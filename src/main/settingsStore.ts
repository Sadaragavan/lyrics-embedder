/**
 * Encrypted AI settings persistence.
 *
 * Stores `{ baseUrl, model, apiKey }` in `userData/settings.json`, written
 * atomically through a serialized `writeQueue`. The API key is encrypted with an
 * injected `SecretCipher` (Electron's async `safeStorage` in production) so this
 * module stays free of `electron` imports and can be unit tested in plain Node.
 *
 * The plaintext key is never exposed to the renderer: `getPublicSettings()`
 * returns `hasApiKey` only.
 */

import path from 'node:path'
import { readJson, writeJson } from './store'
import type {
  AiProviderPreset,
  AiProviderSettingsInput,
  AiProviderSettingsPublic
} from '@shared/types'

export interface DecryptedSecret {
  value: string
  /**
   * True when the platform asks for the blob to be rewritten with the current
   * key (Electron's `decryptStringAsync` reports `shouldReEncrypt` after a key
   * rotation or when a stronger backend became available). The store re-encrypts
   * `value` and rewrites `settings.json` once.
   */
  shouldReEncrypt?: boolean
}

/**
 * Injected platform secret store. Production wires this to Electron's async
 * `safeStorage`; tests use an in-memory implementation.
 */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<DecryptedSecret>
  /** Optional warm-up hook so `isAvailable()` is meaningful before first use. */
  encryptProbe?: () => Promise<boolean>
}

export interface SettingsStoreOptions {
  cipher: SecretCipher
  /** Injected for tests; defaults to `writeJson`. */
  writeFile?: (filePath: string, data: unknown) => Promise<void>
  /** Injected for tests; defaults to `readJson`. */
  readFile?: (filePath: string) => Promise<unknown>
}

export interface StoredAiSettings {
  version: 1
  preset: AiProviderPreset
  baseUrl: string
  model: string
  targetLanguage: string
  romanizationStyle: string
  /** Base64 secret blob from `SecretCipher.encrypt`, never plaintext. */
  apiKeyCipher?: string
  updatedAt: string
}

const PRESETS: readonly AiProviderPreset[] = ['openai', 'gemini', 'openrouter', 'ollama', 'custom']
const MAX_BASE_URL_CHARS = 2048
const MAX_MODEL_CHARS = 200
const MAX_LANGUAGE_CHARS = 80
const MAX_API_KEY_CHARS = 4096

export const DEFAULT_AI_SETTINGS: Readonly<{
  preset: AiProviderPreset
  baseUrl: string
  model: string
  targetLanguage: string
  romanizationStyle: string
}> = Object.freeze({
  preset: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  targetLanguage: 'English',
  romanizationStyle: 'Hepburn-style Romaji'
})

function asPreset(value: unknown): AiProviderPreset {
  return PRESETS.includes(value as AiProviderPreset)
    ? (value as AiProviderPreset)
    : DEFAULT_AI_SETTINGS.preset
}

function asTrimmedString(value: unknown, maxChars: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxChars) return fallback
  return trimmed
}

/** Defensively normalizes an untrusted settings payload. */
export function sanitizeAiSettings(input: unknown): {
  preset: AiProviderPreset
  baseUrl: string
  model: string
  targetLanguage: string
  romanizationStyle: string
} {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_AI_SETTINGS }
  }
  const candidate = input as Record<string, unknown>
  return {
    preset: asPreset(candidate.preset),
    baseUrl: asTrimmedString(candidate.baseUrl, MAX_BASE_URL_CHARS, DEFAULT_AI_SETTINGS.baseUrl),
    model: asTrimmedString(candidate.model, MAX_MODEL_CHARS, DEFAULT_AI_SETTINGS.model),
    targetLanguage: asTrimmedString(
      candidate.targetLanguage,
      MAX_LANGUAGE_CHARS,
      DEFAULT_AI_SETTINGS.targetLanguage
    ),
    romanizationStyle: asTrimmedString(
      candidate.romanizationStyle,
      MAX_LANGUAGE_CHARS,
      DEFAULT_AI_SETTINGS.romanizationStyle
    )
  }
}

/** Throws when an API key is unreasonably large (guards the encrypted record). */
export function assertApiKeyShape(apiKey: string): void {
  if (apiKey.length > MAX_API_KEY_CHARS) {
    throw new Error(`API key must be <= ${MAX_API_KEY_CHARS} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new Error('API key must not contain control characters')
  }
}

export class SettingsStore {
  readonly filePath: string
  private readonly cipher: SecretCipher
  private readonly writeFile: (filePath: string, data: unknown) => Promise<void>
  private readonly readFile: (filePath: string) => Promise<unknown>
  private writeQueue: Promise<void> = Promise.resolve()
  private cache: StoredAiSettings | null = null
  /** True once a decrypt reported that the blob should be re-encrypted. */
  private needsReEncrypt = false

  constructor(userDataDir: string, options: SettingsStoreOptions) {
    this.filePath = path.join(path.resolve(userDataDir), 'settings.json')
    this.cipher = options.cipher
    // `settings.json` holds an encrypted API key, so it is written 0600.
    this.writeFile =
      options.writeFile ?? ((filePath, data) => writeJson(filePath, data, { mode: 0o600 }))
    this.readFile = options.readFile ?? ((filePath) => readJson<unknown>(filePath))
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Reads and normalizes `settings.json`; a corrupt file falls back to defaults. */
  private async load(): Promise<StoredAiSettings> {
    if (this.cache) return this.cache
    let raw: unknown = null
    try {
      raw = await this.readFile(this.filePath)
    } catch (error) {
      console.error('[settings] failed to read settings.json, using defaults:', error)
      raw = null
    }
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const normalized = sanitizeAiSettings(record)
    const apiKeyCipher =
      typeof record.apiKeyCipher === 'string' && record.apiKeyCipher.length > 0
        ? record.apiKeyCipher
        : undefined
    this.cache = {
      version: 1,
      ...normalized,
      ...(apiKeyCipher ? { apiKeyCipher } : {}),
      updatedAt:
        typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
    }
    return this.cache
  }

  /**
   * Re-encrypts a stored blob when the platform reports it used a legacy scheme
   * (for example a Linux `basic_text` backend that has since been upgraded).
   */
  private async reEncryptIfNeeded(stored: StoredAiSettings): Promise<StoredAiSettings> {
    if (!this.needsReEncrypt || !stored.apiKeyCipher) return stored
    try {
      const decrypted = await this.cipher.decrypt(stored.apiKeyCipher)
      const encrypted = await this.cipher.encrypt(decrypted.value)
      const next: StoredAiSettings = { ...stored, apiKeyCipher: encrypted }
      this.needsReEncrypt = false
      this.cache = next
      await this.enqueueWrite(() => this.writeFile(this.filePath, next))
      return next
    } catch (error) {
      console.error('[settings] failed to re-encrypt stored API key:', error)
      return stored
    }
  }

  /** Settings safe to hand to the renderer (no plaintext key, ever). */
  async getPublicSettings(): Promise<AiProviderSettingsPublic> {
    const stored = await this.load()
    return {
      preset: stored.preset,
      baseUrl: stored.baseUrl,
      model: stored.model,
      targetLanguage: stored.targetLanguage,
      romanizationStyle: stored.romanizationStyle,
      hasApiKey: typeof stored.apiKeyCipher === 'string' && stored.apiKeyCipher.length > 0,
      encryptionAvailable: this.cipher.isAvailable()
    }
  }

  /**
   * Resolves the plaintext API key for a single request. Returns `null` when no
   * key is stored or decryption fails (the request then runs unauthenticated).
   */
  async getApiKey(): Promise<string | null> {
    const stored = await this.load()
    if (!stored.apiKeyCipher) return null
    try {
      const decrypted = await this.cipher.decrypt(stored.apiKeyCipher)
      if (decrypted.shouldReEncrypt) {
        this.needsReEncrypt = true
        await this.reEncryptIfNeeded(stored)
      }
      return decrypted.value.length > 0 ? decrypted.value : null
    } catch (error) {
      console.error('[settings] failed to decrypt API key:', error)
      return null
    }
  }

  /**
   * Persists settings. `apiKey` semantics:
   * - `undefined` → keep the stored key untouched
   * - `''`        → clear the stored key
   * - non-empty   → encrypt and replace
   */
  async saveSettings(input: AiProviderSettingsInput): Promise<AiProviderSettingsPublic> {
    const normalized = sanitizeAiSettings(input)
    const apiKey = (input as { apiKey?: unknown }).apiKey

    if (apiKey !== undefined && typeof apiKey !== 'string') {
      throw new Error('apiKey must be a string when provided')
    }
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      assertApiKeyShape(apiKey)
    }

    const current = await this.load()
    let apiKeyCipher: string | undefined = current.apiKeyCipher

    if (typeof apiKey === 'string') {
      const trimmedKey = apiKey.trim()
      if (trimmedKey.length === 0) {
        apiKeyCipher = undefined
      } else {
        if (!this.cipher.isAvailable()) {
          throw new Error(
            'Secure storage is unavailable on this system; the API key cannot be saved'
          )
        }
        apiKeyCipher = await this.cipher.encrypt(trimmedKey)
      }
    }

    const next: StoredAiSettings = {
      version: 1,
      ...normalized,
      ...(apiKeyCipher ? { apiKeyCipher } : {}),
      updatedAt: new Date().toISOString()
    }

    await this.enqueueWrite(() => this.writeFile(this.filePath, next))
    this.cache = next
    this.needsReEncrypt = false
    return this.getPublicSettings()
  }

  /** Removes the stored API key, keeping the provider/model/language settings. */
  async clearApiKey(): Promise<AiProviderSettingsPublic> {
    const current = await this.load()
    const { apiKeyCipher: _removed, ...rest } = current
    const next: StoredAiSettings = { ...rest, updatedAt: new Date().toISOString() }
    await this.enqueueWrite(() => this.writeFile(this.filePath, next))
    this.cache = next
    return this.getPublicSettings()
  }

  /** Test/introspection helper: the raw on-disk record (still ciphertext). */
  async getStoredRecord(): Promise<StoredAiSettings> {
    return { ...(await this.load()) }
  }
}

export function createSettingsStore(
  userDataDir: string,
  options: SettingsStoreOptions
): SettingsStore {
  return new SettingsStore(userDataDir, options)
}
