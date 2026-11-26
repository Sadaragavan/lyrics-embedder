/**
 * Pure LRC parser/normalizer.
 *
 * - Parses `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss:xx]`, and `[mm:ss]` line-synced timestamps
 *   and `<mm:ss.xx>` A2 word tags.
 * - Bakes `[offset:±ms]` using the standard LRC sign convention (`timeMs - offset`:
 *   positive `[offset:+500]` shifts lyrics 500ms earlier, negative delays them) and strips `[offset:]`.
 * - Strips `[length:]` and metadata headers (Poweramp rejects duration mismatches).
 * - Rounds all timestamps to centiseconds (`[mm:ss.xx]`).
 * - Sorts lines by timestamp for stable output.
 * - `stackLrcLayers`: merges multiple LRC strings into same-timestamp stacking.
 * - `shiftLrcOffset`: shifts all timestamps directly by `+ deltaMs` without premature clamping.
 *
 * This module must stay free of Node-only and DOM-only imports.
 */

import type { LyricsTimingKind } from './types'

export interface LrcLine {
  timeMs: number
  text: string
}

export interface ParseLrcOptions {
  /** Keep `<mm:ss.xx>` A2 word-level tags in line text. Default: false (strip). */
  preserveWordTags?: boolean
}

export interface FormatLrcOptions {
  /** Keep `<mm:ss.xx>` A2 word-level tags in line text. Default: false (strip). */
  preserveWordTags?: boolean
}

const TIMESTAMP_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/
const A2_WORD_TAG_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g
const METADATA_RE = /^\[([a-zA-Z][a-zA-Z0-9_-]*):([^\]]*)\]$/
const OFFSET_RE = /^\[offset:\s*([+-]?\d+)\s*\]/im

/**
 * Parses raw minute, second, and optional sub-second components into milliseconds.
 */
export function parseTimestamp(mm: string, ss: string, xx: string = ''): number {
  const minutes = parseInt(mm, 10)
  const seconds = parseInt(ss, 10)
  let fraction = xx.length > 0 ? parseInt(xx, 10) : 0
  if (xx.length === 1) fraction *= 100
  else if (xx.length === 2) fraction *= 10
  // xx.length === 3 -> already milliseconds
  return minutes * 60_000 + seconds * 1_000 + fraction
}

function formatTimeBody(ms: number): string {
  const totalCentis = Math.max(0, Math.round(ms / 10))
  const minutes = Math.floor(totalCentis / 6_000)
  const seconds = Math.floor((totalCentis % 6_000) / 100)
  const centiseconds = totalCentis % 100
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  const xx = String(centiseconds).padStart(2, '0')
  return `${mm}:${ss}.${xx}`
}

/**
 * Formats milliseconds as `[mm:ss.xx]` with centisecond rounding.
 */
export function formatTimestamp(ms: number): string {
  return `[${formatTimeBody(ms)}]`
}

const TIMED_LINE_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
const TIMED_WORD_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g
const METADATA_LINE_RE = /^\[[a-zA-Z][a-zA-Z0-9_-]*:[^\]]*\]$/

/** A timestamp is valid when its seconds component is 00-59. */
function isValidSeconds(ss: string): boolean {
  const seconds = Number.parseInt(ss, 10)
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 59
}

/**
 * Splits a line into its leading timestamps and the remaining text.
 * Returns `null` when the line does not begin with a valid `[mm:ss.xx]` tag.
 */
function splitLeadingTimestamps(line: string): string | null {
  let rest = line
  let found = false
  TIMED_LINE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TIMED_LINE_RE.exec(rest)) !== null) {
    if (match.index !== 0) break
    if (!isValidSeconds(match[2]!)) return null
    found = true
    rest = rest.slice(match[0].length)
  }
  return found ? rest : null
}

/** True when any non-metadata line has visible lyric text after tag removal. */
function hasLyricText(raw: string): boolean {
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (METADATA_LINE_RE.test(line)) continue
    const rest = splitLeadingTimestamps(line)
    const text = (rest ?? line).replace(TIMED_WORD_RE, '').trim()
    if (text.length > 0) return true
  }
  return false
}

/** True when the text contains at least one valid A2 word tag on a timed line. */
function hasValidWordTagOnTimedLine(text: string): boolean {
  TIMED_WORD_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TIMED_WORD_RE.exec(text)) !== null) {
    if (isValidSeconds(match[2]!)) return true
  }
  return false
}

/**
 * Classifies a lyric payload by its timing granularity.
 *
 * - `word`: timed lines containing valid A2 `<mm:ss.xx>` word tags.
 * - `line`: at least one valid `[mm:ss.xx]` line timestamp.
 * - `plain`: untimed text, or timestamps that are malformed/out of range.
 * - `instrumental`: explicitly marked instrumental with no lyric text.
 * - `none`: no lyric content at all.
 */
export function detectLyricsTimingKind(
  syncedLyrics: string | null | undefined,
  plainLyrics: string | null | undefined,
  instrumental = false
): LyricsTimingKind {
  const synced = syncedLyrics ?? ''
  const plain = plainLyrics ?? ''
  const syncedHasText = hasLyricText(synced)
  const plainHasText = hasLyricText(plain)

  if (instrumental && !syncedHasText && !plainHasText) return 'instrumental'

  const cleaned = synced.charCodeAt(0) === 0xfeff ? synced.slice(1) : synced
  let timedLines = 0
  let wordLines = 0
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (METADATA_LINE_RE.test(line)) continue
    const rest = splitLeadingTimestamps(line)
    if (rest === null) continue
    timedLines++
    if (hasValidWordTagOnTimedLine(rest)) wordLines++
  }

  if (timedLines > 0) return wordLines > 0 ? 'word' : 'line'
  if (syncedHasText || plainHasText) return 'plain'
  return 'none'
}

/**
 * Extracts the `[offset:±ms]` value from raw LRC text. Returns 0 if absent.
 */
export function extractOffset(raw: string): number {
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const match = OFFSET_RE.exec(normalized)
  if (!match || !match[1]) return 0
  const value = parseInt(match[1], 10)
  return Number.isFinite(value) ? value : 0
}

/**
 * Returns true if the line is a metadata header like `[ti:...]`, `[length:...]`, `[offset:...]`.
 */
function isMetadataLine(line: string): boolean {
  return METADATA_RE.test(line.trim())
}

/**
 * Strips `<mm:ss.xx>` A2 word-level tags from line text and normalizes adjacent spaces.
 */
function stripWordTags(text: string): string {
  if (!A2_WORD_TAG_RE.test(text)) {
    return text.trim()
  }
  A2_WORD_TAG_RE.lastIndex = 0
  return text.replace(A2_WORD_TAG_RE, '').replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Shifts inline `<mm:ss.xx>` A2 word-level tags by `deltaMs` and rounds to centiseconds.
 */
function shiftWordTags(text: string, deltaMs: number): string {
  return text.replace(A2_WORD_TAG_RE, (_match, mm: string, ss: string, xx: string | undefined) => {
    const shiftedMs = Math.max(0, parseTimestamp(mm, ss, xx ?? '') + deltaMs)
    return `<${formatTimeBody(shiftedMs)}>`
  })
}

function parseLrcUnclamped(
  raw: string,
  options: ParseLrcOptions = {}
): { lines: LrcLine[]; offset: number } {
  const { preserveWordTags = false } = options
  const cleanedRaw = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const offset = extractOffset(cleanedRaw)
  const rawLines = cleanedRaw.split(/\r?\n/)
  const lines: LrcLine[] = []

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue
    if (isMetadataLine(trimmed)) continue

    const timestamps: number[] = []
    let remaining = trimmed
    let match: RegExpExecArray | null
    while ((match = TIMESTAMP_RE.exec(remaining)) !== null) {
      const mm = match[1]!
      const ss = match[2]!
      const xx = match[3] ?? ''
      // Standard LRC spec: +offset shifts playback earlier -> timestamp - offset
      timestamps.push(parseTimestamp(mm, ss, xx) - offset)
      remaining = remaining.slice(match[0].length)
    }

    if (timestamps.length === 0) continue

    const text = preserveWordTags ? remaining.trim() : stripWordTags(remaining)

    for (const timeMs of timestamps) {
      lines.push({ timeMs, text })
    }
  }

  return { lines, offset }
}

/**
 * Parses raw LRC text into sorted `LrcLine[]`.
 *
 * - Bakes `[offset:±ms]` (`timeMs - offset`) into timestamps and preserved word tags.
 * - Strips `[length:]` and other metadata headers from output.
 * - Handles multiple timestamps per line (`[01:00.00][01:30.00]text`).
 * - Strips A2 `<mm:ss.xx>` word tags unless `preserveWordTags` is true.
 * - Clamps negative timestamps to 0 and sorts stably by timestamp.
 */
export function parseLrc(raw: string, options: ParseLrcOptions = {}): LrcLine[] {
  const { preserveWordTags = false } = options
  const { lines, offset } = parseLrcUnclamped(raw, options)
  const clamped = lines.map((line) => ({
    timeMs: Math.max(0, line.timeMs),
    text: preserveWordTags && offset !== 0 ? shiftWordTags(line.text, -offset) : line.text
  }))
  clamped.sort((a, b) => a.timeMs - b.timeMs)
  return clamped
}

/**
 * Formats `LrcLine[]` into standard `[mm:ss.xx]` LRC text.
 * Strips A2 word tags unless `preserveWordTags` is true.
 */
export function formatLrc(lines: LrcLine[], options: FormatLrcOptions = {}): string {
  const { preserveWordTags = false } = options
  const formatted = lines.map((line) => {
    const ts = formatTimestamp(line.timeMs)
    const text = preserveWordTags ? line.text : stripWordTags(line.text)
    return `${ts}${text}`
  })
  return formatted.join('\n')
}

/**
 * Full normalize pipeline: parse raw LRC, bake offset, strip metadata/length,
 * round to centiseconds, sort, and re-format.
 */
export function normalizeLrc(raw: string, options: ParseLrcOptions & FormatLrcOptions = {}): string {
  const lines = parseLrc(raw, options)
  return formatLrc(lines, options)
}

/**
 * Merges multiple LRC strings by stacking lines with the same centisecond timestamp.
 * Lines from later layers appear after lines from earlier layers at the
 * same timestamp (same-timestamp multi-line stacking for translations/romanization).
 */
export function stackLrcLayers(layers: string[], options: ParseLrcOptions & FormatLrcOptions = {}): string {
  const allLines: LrcLine[] = []
  for (const layer of layers) {
    allLines.push(...parseLrc(layer, options))
  }
  // Compare by rounded centiseconds so lines mapping to the same [mm:ss.xx] stay in layer order.
  allLines.sort((a, b) => Math.round(a.timeMs / 10) - Math.round(b.timeMs / 10))
  return formatLrc(allLines, options)
}

/**
 * Shifts all timestamps directly by `+ deltaMs` milliseconds (positive = later, negative = earlier)
 * without premature clamping of baked `[offset:±ms]` intermediate values.
 */
export function shiftLrcOffset(raw: string, deltaMs: number, options: ParseLrcOptions & FormatLrcOptions = {}): string {
  const { preserveWordTags = false } = options
  const { lines, offset } = parseLrcUnclamped(raw, options)
  const wordDelta = -offset + deltaMs
  const shifted = lines.map((line) => ({
    timeMs: Math.max(0, line.timeMs + deltaMs),
    text: preserveWordTags && wordDelta !== 0 ? shiftWordTags(line.text, wordDelta) : line.text
  }))
  shifted.sort((a, b) => a.timeMs - b.timeMs)
  return formatLrc(shifted, options)
}
