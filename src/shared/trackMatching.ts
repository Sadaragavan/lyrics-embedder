/**
 * Pure track-matching helpers: text normalization, title cleaning, artist
 * splitting, query-variant generation, and multi-factor candidate scoring.
 *
 * This module must stay free of Node-only and DOM-only imports so it can run in
 * the main process, the renderer, and Vitest alike.
 */

import { detectLyricsTimingKind } from './lrc'
import type { LyricsTimingKind } from './types'

export interface TrackMatchInput {
  title: string
  artist: string
  album?: string
  durationSec?: number
}

/** One normalized query shape sent to a provider. */
export interface QueryVariant {
  /** Stable label: `raw`, `cleaned-album`, or `cleaned`. */
  id: string
  title: string
  artist: string
  album: string
  /** Normalized identity used for dedup. */
  fingerprint: string
}

export interface CandidateScoreInput {
  queryTitle: string
  queryArtist: string
  queryAlbum?: string
  queryDurationSec?: number
  candidateTitle?: string | null
  candidateArtist?: string | null
  candidateAlbum?: string | null
  candidateDurationSec?: number | null
  syncedLyrics?: string | null
  plainLyrics?: string | null
  /** Local sidecars are authoritative for their own file. */
  isLocalSidecar?: boolean
}

export interface CandidateScore {
  score: number
  timingKind: LyricsTimingKind
  titleSimilarity: number
  artistSimilarity: number
  durationDeltaSec?: number
}

/** Scoring weights (points, total capped at 100). */
const WEIGHT_TITLE = 35
const WEIGHT_ARTIST = 20
const WEIGHT_ALBUM = 5
const DURATION_BONUS_CLOSE = 8
const DURATION_PENALTY_FAR = 12
const DURATION_PENALTY_VERY_FAR = 30
const LOCAL_SYNCED_BASELINE = 100
const LOCAL_PLAIN_BASELINE = 6

const TIMING_WEIGHT: Record<LyricsTimingKind, number> = {
  word: 30,
  line: 25,
  plain: 8,
  instrumental: 5,
  none: 0
}

/**
 * NFKC-normalizes text, lowercases it, and keeps only Unicode letters, numbers,
 * and combining marks (needed for abugida scripts such as Tamil) as
 * space-separated tokens.
 */
export function normalizeMatchText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const BRACKET_SEGMENT_RE = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)|\[([^[\]]*(?:\[[^[\]]*\][^[\]]*)*)\]/g

/** Parenthetical/bracketed segments that are noise for matching purposes. */
const NOISE_SEGMENT_RE =
  /^\s*(?:from\b|feat\.?\b|ft\.?\b|featuring\b|remaster(?:ed)?\b|official\b|original motion picture soundtrack\b|bonus track\b)/i

const BARE_FEATURE_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i
const SINGLE_SUFFIX_RE = /\s*[-–—]\s*single\s*$/i
const TRAILING_SEPARATOR_RE = /[\s\-–—:|,]+$/u

/**
 * Removes marketing/edition noise from a track title:
 * `(From "...")`, `(feat./ft./featuring ...)`, `[Remastered ...]`,
 * `(Official ...)`, `(Original Motion Picture Soundtrack)`, `(Bonus Track)`,
 * and a trailing `- Single`.
 */
export function cleanTrackTitle(title: string): string {
  let result = title.normalize('NFKC')
  let previous = ''
  // Repeat so nested segments (e.g. `(From "Movie (2020)")`) collapse fully.
  while (result !== previous) {
    previous = result
    result = result.replace(BRACKET_SEGMENT_RE, (match, paren?: string, bracket?: string) => {
      const inner = paren ?? bracket ?? ''
      return NOISE_SEGMENT_RE.test(inner) ? ' ' : match
    })
  }
  result = result
    .replace(BARE_FEATURE_RE, ' ')
    .replace(SINGLE_SUFFIX_RE, ' ')
    .replace(TRAILING_SEPARATOR_RE, ' ')
  return result.replace(/\s+/g, ' ').trim()
}

const ARTIST_SPLIT_RE = /\s*(?:;|,|\/|&|×|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bx\b)\s*/i

/**
 * Splits a combined artist credit on `;`, `,`, `/`, `&`, `x`, `feat.`, `ft.`,
 * and `featuring`, preserving the original casing of each unique artist.
 */
export function splitArtists(artist: string): string[] {
  const parts = artist
    .normalize('NFKC')
    .split(ARTIST_SPLIT_RE)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0)

  const seen = new Set<string>()
  const unique: string[] = []
  for (const part of parts) {
    const key = normalizeMatchText(part)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    unique.push(part)
  }
  return unique
}

/** Returns the first artist credit, or the trimmed input when none split out. */
export function extractPrimaryArtist(artist: string): string {
  const parts = splitArtists(artist)
  if (parts.length > 0) return parts[0]!
  return artist.replace(/\s+/g, ' ').trim()
}

/**
 * Stable identity for a track/query: normalized title, artist, album, and
 * rounded duration.
 */
export function computeTrackFingerprint(input: TrackMatchInput): string {
  const duration =
    typeof input.durationSec === 'number' && Number.isFinite(input.durationSec) && input.durationSec > 0
      ? Math.round(input.durationSec)
      : 0
  return [
    normalizeMatchText(input.title),
    normalizeMatchText(input.artist),
    normalizeMatchText(input.album ?? ''),
    String(duration)
  ].join('|')
}

/**
 * Builds up to three query variants, deduplicated by fingerprint:
 * 1. `raw` — untouched metadata.
 * 2. `cleaned-album` — cleaned title + primary artist + album.
 * 3. `cleaned` — cleaned title + primary artist, album dropped.
 */
export function buildQueryVariants(input: TrackMatchInput): QueryVariant[] {
  const rawTitle = input.title.trim()
  const rawArtist = input.artist.trim()
  const rawAlbum = (input.album ?? '').trim()

  const cleanedTitle = cleanTrackTitle(input.title) || rawTitle
  const primaryArtist = extractPrimaryArtist(input.artist)

  const candidates: Array<Omit<QueryVariant, 'fingerprint'>> = [
    { id: 'raw', title: rawTitle, artist: rawArtist, album: rawAlbum },
    { id: 'cleaned-album', title: cleanedTitle, artist: primaryArtist, album: rawAlbum },
    { id: 'cleaned', title: cleanedTitle, artist: primaryArtist, album: '' }
  ]

  const seen = new Set<string>()
  const variants: QueryVariant[] = []
  for (const candidate of candidates) {
    const fingerprint = computeTrackFingerprint(candidate)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    variants.push({ ...candidate, fingerprint })
  }
  return variants
}

/**
 * Token-based similarity in `[0, 1]` using Dice overlap plus a containment
 * bonus. Unicode-aware via `normalizeMatchText`.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeMatchText(a)
  const nb = normalizeMatchText(b)
  if (na.length === 0 || nb.length === 0) return 0
  if (na === nb) return 1

  const tokensA = new Set(na.split(' '))
  const tokensB = new Set(nb.split(' '))
  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }

  const dice = (2 * intersection) / (tokensA.size + tokensB.size)
  const containment =
    intersection === Math.min(tokensA.size, tokensB.size)
      ? Math.min(tokensA.size, tokensB.size) / Math.max(tokensA.size, tokensB.size)
      : 0
  return Math.max(dice, containment)
}

function albumBonus(queryAlbum: string | undefined, candidateAlbum: string | null | undefined): number {
  const a = normalizeMatchText(queryAlbum ?? '')
  const b = normalizeMatchText(candidateAlbum ?? '')
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return WEIGHT_ALBUM
  if (a.includes(b) || b.includes(a)) return Math.round(WEIGHT_ALBUM / 2)
  return 0
}

function durationAdjustment(
  queryDurationSec: number | undefined,
  candidateDurationSec: number | null | undefined
): { adjustment: number; delta?: number } {
  if (
    typeof queryDurationSec !== 'number' ||
    !Number.isFinite(queryDurationSec) ||
    queryDurationSec <= 0 ||
    typeof candidateDurationSec !== 'number' ||
    !Number.isFinite(candidateDurationSec) ||
    candidateDurationSec <= 0
  ) {
    return { adjustment: 0 }
  }

  const delta = Math.abs(candidateDurationSec - queryDurationSec)
  const rounded = Math.round(delta * 10) / 10
  if (delta <= 2) return { adjustment: DURATION_BONUS_CLOSE, delta: rounded }
  if (delta <= 15) return { adjustment: 0, delta: rounded }
  if (delta <= 30) return { adjustment: -DURATION_PENALTY_FAR, delta: rounded }
  return { adjustment: -DURATION_PENALTY_VERY_FAR, delta: rounded }
}

/**
 * Scores a candidate against the query using timing granularity, Unicode token
 * similarity for title/artist, album agreement, and duration tiers
 * (`<= 2s`, `<= 15s`, `<= 30s`, `> 30s`). Local sidecars receive a fixed
 * synced baseline because they belong to the exact file being edited.
 */
export function scoreCandidate(input: CandidateScoreInput): CandidateScore {
  const timingKind = detectLyricsTimingKind(
    input.syncedLyrics ?? null,
    input.plainLyrics ?? null
  )

  const titleSimilarity = textSimilarity(
    cleanTrackTitle(input.candidateTitle ?? ''),
    cleanTrackTitle(input.queryTitle)
  )
  const artistSimilarity = textSimilarity(
    input.candidateArtist ?? '',
    input.queryArtist
  )
  const { adjustment: durationAdjustmentPoints, delta: durationDeltaSec } = durationAdjustment(
    input.queryDurationSec,
    input.candidateDurationSec
  )

  let score =
    TIMING_WEIGHT[timingKind] +
    Math.round(titleSimilarity * WEIGHT_TITLE) +
    Math.round(artistSimilarity * WEIGHT_ARTIST) +
    albumBonus(input.queryAlbum, input.candidateAlbum) +
    durationAdjustmentPoints

  if (input.isLocalSidecar) {
    if (timingKind === 'word' || timingKind === 'line') {
      score = Math.max(score, LOCAL_SYNCED_BASELINE)
    } else if (timingKind === 'plain') {
      score = Math.max(score, LOCAL_PLAIN_BASELINE)
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  return {
    score,
    timingKind,
    titleSimilarity,
    artistSimilarity,
    ...(durationDeltaSec !== undefined ? { durationDeltaSec } : {})
  }
}
