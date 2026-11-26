/**
 * Pure row model for the unified live lyrics editor.
 *
 * The editor shows one editable row per primary `[mm:ss.xx]` line, with the
 * translation/romanization lines that share that timestamp indented beneath it.
 * Everything here is DOM-free and Node-free so it can be unit tested and reused
 * by the renderer and main process alike.
 *
 * Layer alignment rules:
 * - Rows are keyed by rounded centisecond timestamps (the LRC resolution).
 * - A layer line with a timestamp that exists in the primary joins that row.
 * - A layer line whose timestamp is missing from the primary becomes its own row
 *   (created by the layer) so content is never silently dropped.
 * - Extra layer lines at an already-used timestamp append, in layer order, to the
 *   row's text for that layer (same-timestamp multi-line stacking).
 */

import { formatTimestamp, parseLrc, parseTimestamp } from './lrc'

export interface EditableLrcRow {
  /** Stable identifier: the rounded centisecond timestamp. */
  key: number
  timeMs: number
  /** Primary line text (may be empty for rows that only carry layers). */
  text: string
  translation: string
  romanization: string
  /** True when the primary layer has no line at this timestamp. */
  createsOnlyFromLayers: boolean
}

export interface ParseEditableRowsOptions {
  /** Keep `<mm:ss.xx>` A2 word tags in row text. Default: false (strip). */
  preserveWordTags?: boolean
}

export interface SerializeEditableRowsOptions {
  preserveWordTags?: boolean
  /** Emit rows whose primary text is empty. Default: false. */
  includeEmptyPrimary?: boolean
  /** Also emit translation/romanization layers. Default: true. */
  includeLayers?: boolean
}

/** Rounds to LRC centisecond resolution so equal timestamps compare exactly. */
function rowKey(timeMs: number): number {
  return Math.round(Math.max(0, timeMs) / 10)
}

/** Collapses duplicate layer text at the same timestamp into one stacked string. */
function joinLayerText(previous: string, next: string): string {
  if (previous.length === 0) return next
  if (next.length === 0) return previous
  return `${previous}\n${next}`
}

function layerLines(
  raw: string,
  opts: ParseEditableRowsOptions
): Array<{ key: number; timeMs: number; text: string }> {
  if (!raw || raw.trim().length === 0) return []
  return parseLrc(raw, { preserveWordTags: opts.preserveWordTags ?? false }).map((line) => ({
    key: rowKey(line.timeMs),
    timeMs: line.timeMs,
    text: line.text
  }))
}

/**
 * Builds the editable row list from the three lyric layers.
 *
 * Rows are sorted by timestamp; ties keep primary-then-layer discovery order.
 */
export function parseEditableRows(
  primaryRaw: string,
  translationRaw: string,
  romanizationRaw: string,
  opts: ParseEditableRowsOptions = {}
): EditableLrcRow[] {
  const rows = new Map<number, EditableLrcRow>()
  const order: number[] = []

  const ensureRow = (key: number, timeMs: number, fromPrimary: boolean): EditableLrcRow => {
    const existing = rows.get(key)
    if (existing) {
      if (fromPrimary) existing.createsOnlyFromLayers = false
      return existing
    }
    const row: EditableLrcRow = {
      key,
      timeMs,
      text: '',
      translation: '',
      romanization: '',
      createsOnlyFromLayers: !fromPrimary
    }
    rows.set(key, row)
    order.push(key)
    return row
  }

  for (const line of layerLines(primaryRaw, opts)) {
    const row = ensureRow(line.key, line.timeMs, true)
    row.text = joinLayerText(row.text, line.text)
  }

  for (const line of layerLines(translationRaw, opts)) {
    const row = ensureRow(line.key, line.timeMs, false)
    row.translation = joinLayerText(row.translation, line.text)
  }

  for (const line of layerLines(romanizationRaw, opts)) {
    const row = ensureRow(line.key, line.timeMs, false)
    row.romanization = joinLayerText(row.romanization, line.text)
  }

  return order
    .map((key) => rows.get(key)!)
    .sort((a, b) => a.timeMs - b.timeMs)
}

/**
 * Serializes rows back into primary LRC text (one `[mm:ss.xx]text` line per row
 * that has primary text).
 */
export function serializeEditableRows(
  rows: readonly EditableLrcRow[],
  opts: SerializeEditableRowsOptions = {}
): string {
  const { includeEmptyPrimary = false } = opts
  return rows
    .filter((row) => includeEmptyPrimary || row.text.trim().length > 0)
    .map((row) => `${formatTimestamp(row.timeMs)}${row.text}`)
    .join('\n')
}

/**
 * Serializes a single layer (translation or romanization) from the same rows,
 * skipping rows where that layer is empty.
 */
export function serializeEditableLayer(
  rows: readonly EditableLrcRow[],
  layer: 'translation' | 'romanization',
  opts: SerializeEditableRowsOptions = {}
): string {
  if (opts.includeLayers === false) return ''
  return rows
    .filter((row) => row[layer].trim().length > 0)
    .map((row) => `${formatTimestamp(row.timeMs)}${row[layer]}`)
    .join('\n')
}

export interface ParsedInlineTimestamp {
  timeMs: number
  /** Canonical `[mm:ss.xx]` form, including the brackets. */
  formatted: string
}

/**
 * Parses a user-typed timestamp (`[mm:ss.xx]`, `mm:ss.xx`, `mm:ss`, `[mm:ss]`).
 *
 * Validates `mm` as 1-3 digits and `ss` strictly as `00`-`59`; sub-second
 * fractions of 1-3 digits are accepted and normalized to centiseconds.
 * Returns `null` for anything else so callers can reject the edit.
 */
export function parseInlineTimestamp(input: string): ParsedInlineTimestamp | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^\[/, '').replace(/\]$/, '')
  const match = /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/.exec(trimmed)
  if (!match) return null

  const mm = match[1]!
  const ss = match[2]!
  const xx = match[3] ?? ''
  const seconds = Number.parseInt(ss, 10)
  if (seconds > 59) return null

  const timeMs = parseTimestamp(mm, ss, xx)
  if (!Number.isFinite(timeMs) || timeMs < 0) return null
  return { timeMs, formatted: formatTimestamp(timeMs) }
}

/** True when `input` parses as a valid inline timestamp. */
export function isValidInlineTimestamp(input: string): boolean {
  return parseInlineTimestamp(input) !== null
}
