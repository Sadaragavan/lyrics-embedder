import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AI_SETTINGS,
  SettingsStore,
  createSettingsStore,
  sanitizeAiSettings,
  type DecryptedSecret,
  type SecretCipher,
  type StoredAiSettings
} from '../src/main/settingsStore'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-settings-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** In-memory stand-in for Electron's `safeStorage`, with a reversible transform. */
function makeCipher(
  options: { available?: boolean; shouldReEncrypt?: boolean; failDecrypt?: boolean } = {}
): SecretCipher & { encryptCalls: number; decryptCalls: number } {
  const available = options.available ?? true
  const state = {
    encryptCalls: 0,
    decryptCalls: 0,
    isAvailable: () => available,
    async encrypt(plaintext: string): Promise<string> {
      state.encryptCalls += 1
      return Buffer.from(`enc:${plaintext}`, 'utf8').toString('base64')
    },
    async decrypt(ciphertext: string): Promise<DecryptedSecret> {
      state.decryptCalls += 1
      if (options.failDecrypt) throw new Error('decrypt failed')
      const decoded = Buffer.from(ciphertext, 'base64').toString('utf8')
      return {
        value: decoded.replace(/^enc:/, ''),
        ...(options.shouldReEncrypt ? { shouldReEncrypt: true } : {})
      }
    }
  }
  return state
}

function makeStore(dir: string, cipher: SecretCipher): SettingsStore {
  return createSettingsStore(dir, { cipher })
}

describe('sanitizeAiSettings', () => {
  it('falls back to defaults for non-objects', () => {
    expect(sanitizeAiSettings(null)).toEqual({ ...DEFAULT_AI_SETTINGS })
    expect(sanitizeAiSettings('nope')).toEqual({ ...DEFAULT_AI_SETTINGS })
  })

  it('rejects an unknown preset and blank fields', () => {
    const result = sanitizeAiSettings({ preset: 'evil', baseUrl: '', model: '  ' })
    expect(result.preset).toBe(DEFAULT_AI_SETTINGS.preset)
    expect(result.baseUrl).toBe(DEFAULT_AI_SETTINGS.baseUrl)
    expect(result.model).toBe(DEFAULT_AI_SETTINGS.model)
  })

  it('keeps valid values and trims them', () => {
    const result = sanitizeAiSettings({
      preset: 'ollama',
      baseUrl: '  http://localhost:11434/v1  ',
      model: ' llama3  ',
      targetLanguage: ' Tamil ',
      romanizationStyle: ' ISO 15919 '
    })
    expect(result).toEqual({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      targetLanguage: 'Tamil',
      romanizationStyle: 'ISO 15919'
    })
  })

  it('rejects over-long fields', () => {
    const result = sanitizeAiSettings({ model: 'x'.repeat(500) })
    expect(result.model).toBe(DEFAULT_AI_SETTINGS.model)
  })
})

describe('SettingsStore persistence', () => {
  it('writes userData/settings.json and defaults when absent', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    const settings = await store.getPublicSettings()
    expect(settings.baseUrl).toBe(DEFAULT_AI_SETTINGS.baseUrl)
    expect(settings.hasApiKey).toBe(false)
    expect(store.filePath).toBe(path.join(dir, 'settings.json'))

    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji'
    })
    const onDisk = JSON.parse(await fs.readFile(store.filePath, 'utf8')) as StoredAiSettings
    expect(onDisk.version).toBe(1)
    expect(onDisk.model).toBe('gpt-4o-mini')
  })

  it('encrypts the API key and never exposes plaintext to the renderer', async () => {
    const dir = await makeTempDir()
    const cipher = makeCipher()
    const store = makeStore(dir, cipher)

    const saved = await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: 'sk-secret-value'
    })

    expect(saved.hasApiKey).toBe(true)
    // The public shape must not carry the key in any form.
    expect(JSON.stringify(saved)).not.toContain('sk-secret-value')
    expect(Object.keys(saved)).not.toContain('apiKey')

    const onDisk = await fs.readFile(store.filePath, 'utf8')
    expect(onDisk).not.toContain('sk-secret-value')
    expect(JSON.parse(onDisk).apiKeyCipher).toBeDefined()

    // The plaintext is still recoverable by main for outbound requests.
    expect(await store.getApiKey()).toBe('sk-secret-value')
  })

  it('keeps the stored key when apiKey is omitted', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm1',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: 'k1'
    })
    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm2',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji'
    })
    expect(await store.getApiKey()).toBe('k1')
    expect((await store.getPublicSettings()).hasApiKey).toBe(true)
  })

  it('clears the key when apiKey is an empty string', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: 'k1'
    })
    const cleared = await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: ''
    })
    expect(cleared.hasApiKey).toBe(false)
    expect(await store.getApiKey()).toBeNull()
  })

  it('clearApiKey removes the secret but keeps the rest of the settings', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await store.saveSettings({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3',
      targetLanguage: 'Tamil',
      romanizationStyle: 'ISO',
      apiKey: 'secret'
    })
    const cleared = await store.clearApiKey()
    expect(cleared.hasApiKey).toBe(false)
    expect(cleared.model).toBe('llama3')
    expect(cleared.targetLanguage).toBe('Tamil')
  })

  it('refuses to save a key when the cipher is unavailable', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher({ available: false }))
    await expect(
      store.saveSettings({
        preset: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'm',
        targetLanguage: 'English',
        romanizationStyle: 'Romaji',
        apiKey: 'secret'
      })
    ).rejects.toThrow(/Secure storage is unavailable/)
    // Settings themselves still save.
    const settings = await store.getPublicSettings()
    expect(settings.encryptionAvailable).toBe(false)
  })

  it('re-encrypts when the cipher reports shouldReEncrypt', async () => {
    const dir = await makeTempDir()
    const cipher = makeCipher({ shouldReEncrypt: true })
    const store = makeStore(dir, cipher)
    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: 'rotate-me'
    })
    const before = cipher.encryptCalls
    expect(await store.getApiKey()).toBe('rotate-me')
    // A rotation triggers one extra encrypt to rewrite the record.
    expect(cipher.encryptCalls).toBeGreaterThan(before)
  })

  it('returns null instead of throwing when decryption fails', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher({ failDecrypt: true }))
    await expect(store.getApiKey()).resolves.toBeNull()
  })

  it('survives a corrupt settings.json', async () => {
    const dir = await makeTempDir()
    await fs.writeFile(path.join(dir, 'settings.json'), '{not json', 'utf8')
    const store = makeStore(dir, makeCipher())
    const settings = await store.getPublicSettings()
    expect(settings.baseUrl).toBe(DEFAULT_AI_SETTINGS.baseUrl)
    expect(settings.hasApiKey).toBe(false)
  })

  it('serializes concurrent writes (last one wins, file stays valid)', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((model) =>
        store.saveSettings({
          preset: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model,
          targetLanguage: 'English',
          romanizationStyle: 'Romaji'
        })
      )
    )
    const onDisk = JSON.parse(await fs.readFile(store.filePath, 'utf8')) as StoredAiSettings
    expect(['a', 'b', 'c', 'd']).toContain(onDisk.model)
  })

  it('rejects an absurdly long API key', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await expect(
      store.saveSettings({
        preset: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'm',
        targetLanguage: 'English',
        romanizationStyle: 'Romaji',
        apiKey: 'x'.repeat(5000)
      })
    ).rejects.toThrow(/API key must be/)
  })

  it('rejects an API key containing control characters', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await expect(
      store.saveSettings({
        preset: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'm',
        targetLanguage: 'English',
        romanizationStyle: 'Romaji',
        apiKey: 'bad\u0000key'
      })
    ).rejects.toThrow(/control characters/)
  })

  it('exposes the stored record without decrypting', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: 'k'
    })
    const record = await store.getStoredRecord()
    expect(record.apiKeyCipher).toBeDefined()
    expect(JSON.stringify(record)).not.toContain('"apiKey"')
  })
})

describe('settings.json file mode', () => {
  it('writes the encrypted settings file with 0600 permissions', async () => {
    const dir = await makeTempDir()
    const store = makeStore(dir, makeCipher())
    await store.saveSettings({
      preset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      targetLanguage: 'English',
      romanizationStyle: 'Romaji',
      apiKey: 'secret'
    })
    // Windows has no POSIX mode bits; the assertion only applies on POSIX.
    if (process.platform !== 'win32') {
      const stat = await fs.stat(store.filePath)
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })
})
