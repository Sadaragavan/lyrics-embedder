/**
 * Pure AI translation / romanization helpers.
 *
 * Flow: take a primary LRC, extract the unique translatable lines, ask an
 * OpenAI-compatible chat endpoint to translate them, then rebuild a valid LRC by
 * re-attaching the *original* timestamps. LLM-generated timestamps are never
 * trusted — the model only ever returns text keyed by a stable integer index.
 *
 * This module must stay free of Node-only and DOM-only imports.
 */

import { formatLrc, parseLrc, type LrcLine } from './lrc'
import type { AiGenerateMode } from './types'

/** Maximum number of distinct lines sent in one request. */
export const MAX_TRANSLATABLE_LINES = 600

/** Upper bound on the raw LRC accepted for generation (1 MiB, matching drafts). */
export const MAX_AI_LRC_BYTES = 1024 * 1024

export interface TranslatableEntry {
  /** Stable 1-based key the model must echo back in its JSON response. */
  index: number
  /** Line text as it appeared in the source (word tags already stripped). */
  text: string
  /** Every timestamp that carries this exact text, in source order. */
  timestampsMs: number[]
}

export interface ExtractTranslatableLinesOptions {
  /** Keep `<mm:ss.xx>` A2 word tags. Default: false. */
  preserveWordTags?: boolean
  /** Cap on distinct lines (defaults to `MAX_TRANSLATABLE_LINES`). */
  maxLines?: number
}

export type BaseUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Validates an OpenAI-compatible base URL.
 *
 * Security posture: an API key is sent to this host, so plaintext HTTP is only
 * ever allowed for loopback addresses (a local Ollama/LM Studio server). Any
 * other host must use HTTPS. Embedded credentials and non-HTTP(S) schemes are
 * rejected outright.
 */
export function validateAiBaseUrl(rawUrl: string): BaseUrlValidationResult {
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'Base URL is required' }
  }
  if (trimmed.length > 2048) {
    return { ok: false, error: 'Base URL is too long' }
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, error: 'Base URL must not contain whitespace or control characters' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Base URL is not a valid URL' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `Unsupported URL scheme: ${parsed.protocol.replace(':', '')}` }
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: 'Base URL must not embed credentials' }
  }
  if (parsed.hash.length > 0) {
    return { ok: false, error: 'Base URL must not contain a fragment' }
  }

  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(host)) {
    return {
      ok: false,
      error: 'Plain HTTP is only allowed for localhost/127.0.0.1/[::1]; use HTTPS for remote hosts'
    }
  }

  // Normalize to a bare origin+path without a trailing slash so callers can
  // append `/chat/completions` deterministically.
  const path = parsed.pathname.replace(/\/+$/, '')
  const port = parsed.port.length > 0 ? `:${parsed.port}` : ''
  return { ok: true, url: `${parsed.protocol}//${parsed.hostname}${port}${path}` }
}

/** Appends `/chat/completions` to a validated base URL (idempotent). */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

function normalizeLineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Extracts the unique, non-empty lines of an LRC.
 *
 * Identical text lines collapse into a single entry that remembers every
 * timestamp it occurred at, so the model translates each string once and the
 * rebuild step can re-attach all occurrences deterministically.
 */
export function extractTranslatableLines(
  rawLrc: string,
  options: ExtractTranslatableLinesOptions = {}
): TranslatableEntry[] {
  const { preserveWordTags = false, maxLines = MAX_TRANSLATABLE_LINES } = options
  const lines = parseLrc(rawLrc, { preserveWordTags })

  const byText = new Map<string, TranslatableEntry>()
  const ordered: TranslatableEntry[] = []

  for (const line of lines) {
    const text = normalizeLineText(line.text)
    // Empty/instrumental lines carry no text to translate; they still keep their
    // timestamp in the primary LRC, which is never modified by this flow.
    if (text.length === 0) continue

    const existing = byText.get(text)
    if (existing) {
      existing.timestampsMs.push(line.timeMs)
      continue
    }
    if (ordered.length >= maxLines) continue

    const entry: TranslatableEntry = {
      index: ordered.length + 1,
      text,
      timestampsMs: [line.timeMs]
    }
    byText.set(text, entry)
    ordered.push(entry)
  }

  return ordered
}

export interface BuildAiMessagesOptions {
  /** Target language for translation (ignored for romanization). */
  targetLanguage?: string
  /** Romanization style, e.g. `Romaji`, `Revised Romanization`. */
  romanizationStyle?: string
  /**
   * Language of the source lyrics when known. Helps the model avoid
   * re-translating already-English lines.
   */
  sourceLanguage?: string
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

function describeTarget(mode: AiGenerateMode, options: BuildAiMessagesOptions): string {
  if (mode === 'translation') {
    const target = options.targetLanguage?.trim() || 'English'
    return `Translate each lyric line into ${target}.`
  }
  const style = options.romanizationStyle?.trim() || 'Hepburn-style Romaji'
  return `Romanize each lyric line using ${style} (transliterate the pronunciation; do NOT translate the meaning).`
}

/**
 * Builds the system+user chat messages for one generation job.
 *
 * The contract is deliberately rigid JSON so the response is machine-checkable:
 * `{"lines":[{"index":1,"text":"..."}]}`.
 */
export function buildAiLyricsMessages(
  entries: readonly TranslatableEntry[],
  mode: AiGenerateMode,
  options: BuildAiMessagesOptions = {}
): ChatMessage[] {
  const system = [
    'You are a lyric localization engine.',
    describeTarget(mode, options),
    'Rules:',
    '- Return ONLY minified JSON of the shape {"lines":[{"index":<int>,"text":"<string>"}]}.',
    '- Echo the exact "index" you were given. Never invent indexes.',
    '- Never include timestamps, brackets, or metadata in "text".',
    '- Preserve line breaks inside a line as a single space.',
    '- If a line must stay unchanged (already in the target language, or purely instrumental), echo it verbatim.',
    '- Do not add commentary, markdown fences, or extra keys.'
  ].join('\n')

  const payload = entries.map((entry) => ({ index: entry.index, text: entry.text }))
  const sourceLanguage = options.sourceLanguage?.trim()
  const user = [
    mode === 'translation'
      ? `Target language: ${options.targetLanguage?.trim() || 'English'}`
      : `Romanization style: ${options.romanizationStyle?.trim() || 'Hepburn-style Romaji'}`,
    ...(sourceLanguage ? [`Source language: ${sourceLanguage}`] : []),
    `Line count: ${payload.length}`,
    'Lines (JSON):',
    JSON.stringify({ lines: payload })
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

export interface RebuildOptions {
  /** Keep `<mm:ss.xx>` A2 word tags in any untranslated lines. */
  preserveWordTags?: boolean
  /**
   * When true (default), lines the model omitted are copied from the source
   * rather than dropped, so a partial model response can never shorten a track.
   */
  keepMissingLines?: boolean
}

export type ParseAiResponseResult =
  | { ok: true; lyrics: string; lineCount: number }
  | { ok: false; error: string }

/** Strips a Markdown code fence (```json ... ```) wrapper when present. */
export function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const withoutOpening = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
  const closing = withoutOpening.lastIndexOf('```')
  return (closing >= 0 ? withoutOpening.slice(0, closing) : withoutOpening).trim()
}

/**
 * Extracts the first balanced JSON object from a model response and parses it.
 * Tolerates prose before/after the object, which some models emit despite the
 * instruction to return JSON only.
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = stripMarkdownFence(raw)
  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      return null
    }
  }

  const direct = tryParse(text)
  if (direct !== null) return direct

  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return tryParse(text.slice(start, i + 1))
      }
    }
  }
  return null
}

interface ParsedLines {
  byIndex: Map<number, string>
}

function parseLinesPayload(value: unknown): ParsedLines | null {
  if (!value || typeof value !== 'object') return null
  const container = value as Record<string, unknown>
  const rawLines = container.lines ?? container.translations ?? container.results
  if (!Array.isArray(rawLines)) return null

  const byIndex = new Map<number, string>()
  for (const item of rawLines) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const index = record.index
    const text = record.text ?? record.line ?? record.translation
    if (typeof index !== 'number' || !Number.isFinite(index)) continue
    if (typeof text !== 'string') continue
    byIndex.set(Math.trunc(index), text)
  }
  return byIndex.size > 0 ? { byIndex } : null
}

/**
 * Parses a model response and rebuilds a valid LRC.
 *
 * Timestamps are always taken from the source mapping, never from the model.
 * Lines the model omitted are passed through unchanged by default so a partial
 * response cannot silently delete lyrics.
 */
export function parseAiResponseAndRebuildLrc(
  rawContent: string,
  mapping: readonly TranslatableEntry[],
  options: RebuildOptions = {}
): ParseAiResponseResult {
  const { keepMissingLines = true } = options

  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { ok: false, error: 'Model returned an empty response' }
  }

  const json = extractJsonObject(rawContent)
  if (json === null) {
    return { ok: false, error: 'Model response did not contain valid JSON' }
  }

  const parsed = parseLinesPayload(json)
  if (!parsed) {
    return { ok: false, error: 'Model JSON did not include a valid "lines" array' }
  }

  const sourceByIndex = new Map<number, TranslatableEntry>()
  for (const entry of mapping) sourceByIndex.set(entry.index, entry)

  // Reject responses whose indexes do not overlap the request at all: that
  // means the model answered a different question (or hallucinated keys).
  let matched = 0
  for (const index of parsed.byIndex.keys()) {
    if (sourceByIndex.has(index)) matched += 1
  }
  if (matched === 0) {
    return { ok: false, error: 'Model response did not match any requested line indexes' }
  }

  const lines: LrcLine[] = []
  let lineCount = 0
  for (const entry of mapping) {
    const generated = parsed.byIndex.get(entry.index)
    const text = generated === undefined ? (keepMissingLines ? entry.text : null) : generated
    if (text === null) continue
    const cleaned = normalizeLineText(text)
    if (cleaned.length === 0) {
      // An empty generated line collapses to the source text rather than
      // producing an empty `[mm:ss.xx]` entry.
      for (const timeMs of entry.timestampsMs) {
        lines.push({ timeMs, text: entry.text })
      }
      continue
    }
    lineCount += 1
    for (const timeMs of entry.timestampsMs) {
      lines.push({ timeMs, text: cleaned })
    }
  }

  if (lines.length === 0) {
    return { ok: false, error: 'Rebuilt LRC would be empty' }
  }

  lines.sort((a, b) => a.timeMs - b.timeMs)
  return {
    ok: true,
    lyrics: formatLrc(lines, { preserveWordTags: options.preserveWordTags ?? false }),
    lineCount
  }
}

/** Rough estimate of a text's UTF-8 byte length without Node's Buffer. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}
