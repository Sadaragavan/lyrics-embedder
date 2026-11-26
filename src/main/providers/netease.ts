/**
 * NetEase Cloud Music (网易云音乐) multi-layer lyrics provider.
 *
 * NetEase exposes three lyrics payloads per song:
 * - `lrc.lyric`    — the line-synced primary lyrics
 * - `tlyric.lyric` — a translation layer sharing the same `[mm:ss.xx]` stamps
 * - `romalrc.lyric`— a romanization layer sharing the same stamps
 *
 * Two public endpoints are used:
 * - search: `https://music.163.com/api/search/get/web?s=<q>&type=1&offset=0&limit=10`
 * - lyric:  `https://music.163.com/api/song/lyric?id=<id>&lv=1&tv=1&rv=1`
 *
 * The provider keeps the project-wide invariants: `concurrency = 1`, >= 500 ms
 * end-to-start pacing recorded in a `finally` block, `AbortSignal` support,
 * bounded 429/503 backoff, and typed `ProviderError`s.
 */

import { detectLyricsTimingKind } from '@shared/lrc'
import { scoreCandidate, type QueryVariant } from '@shared/trackMatching'
import type {
  CandidateEvaluation,
  LyricsCandidate,
  LyricsProvider,
  LyricsProviderId,
  LyricsQuery,
  LyricsSearchRequest,
  LyricsSearchResult,
  ProviderErrorKind
} from '@shared/types'
import {
  classifyProviderError,
  evaluateCandidate,
  pickBetterCandidate,
  ProviderError
} from './router'

const NETEASE_BASE = 'https://music.163.com'
const PROVIDER_ID: LyricsProviderId = 'netease'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REFERER = 'https://music.163.com/'
/** End-to-start pacing between consecutive HTTP requests (>= 500 ms). */
const PACING_MS = 500
const MAX_RETRIES = 2
const BASE_BACKOFF_MS = 1200
const MAX_BACKOFF_MS = 16_000
const MAX_RETRY_AFTER_MS = 30_000
const SEARCH_LIMIT = 10
/** Song metadata results are capped before any lyric fetch (responsiveness). */
const MAX_LYRIC_FETCHES = 5

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>
export type SleepFunction = (ms: number, signal?: AbortSignal) => Promise<void>

export interface NeteaseOptions {
  fetchFn?: FetchFunction
  sleepFn?: SleepFunction
  nowFn?: () => number
  randomFn?: () => number
  baseUrl?: string
  pacingMs?: number
}

interface NeteaseSong {
  id: number
  name: string
  artists: string[]
  album: string
  durationSec: number
}

interface NeteaseLayers {
  primary: string | null
  translation: string | null
  romanization: string | null
}

interface EvaluatedCandidate {
  candidate: LyricsCandidate
  evaluation: CandidateEvaluation
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now()
): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    }
  }
  const timestamp = Date.parse(trimmed)
  if (!Number.isNaN(timestamp)) {
    return Math.min(Math.max(0, timestamp - nowMs), MAX_RETRY_AFTER_MS)
  }
  return null
}

/**
 * Normalizes one hit from `/api/search/get/web` into a `NeteaseSong`.
 * NetEase returns durations in milliseconds; they are converted to seconds.
 */
export function normalizeSong(value: unknown): NeteaseSong | null {
  if (!isRecord(value)) return null
  const id = value.id
  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return null

  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (name.length === 0) return null

  const artistsRaw = value.artists ?? value.ar
  const artists: string[] = []
  if (Array.isArray(artistsRaw)) {
    for (const artist of artistsRaw) {
      if (isRecord(artist) && typeof artist.name === 'string' && artist.name.trim().length > 0) {
        artists.push(artist.name.trim())
      }
    }
  }

  const albumRaw = value.album ?? value.al
  const album =
    isRecord(albumRaw) && typeof albumRaw.name === 'string' ? albumRaw.name.trim() : ''

  const durationRaw = value.duration ?? value.dt
  const durationSec =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.round(durationRaw / 1000)
      : 0

  return { id, name, artists, album, durationSec }
}

/**
 * Extracts the primary/translation/romanization trip from `/api/song/lyric`.
 * Each layer is only kept when it actually contains `[mm:ss.xx]` timestamps, so
 * an un-timed translation never gets stacked at the wrong position.
 */
export function extractLayers(payload: unknown): NeteaseLayers {
  const empty: NeteaseLayers = { primary: null, translation: null, romanization: null }
  if (!isRecord(payload)) return empty

  const readLayer = (key: 'lrc' | 'tlyric' | 'romalrc'): string | null => {
    const container = payload[key]
    if (!isRecord(container)) return null
    const lyric = container.lyric
    if (typeof lyric !== 'string') return null
    const trimmed = lyric.trim()
    if (trimmed.length === 0) return null
    const kind = detectLyricsTimingKind(trimmed, null)
    if (kind !== 'line' && kind !== 'word') return null
    return trimmed
  }

  const primary = readLayer('lrc')
  if (primary === null) return empty

  return {
    primary,
    translation: readLayer('tlyric'),
    romanization: readLayer('romalrc')
  }
}

export class NeteaseProvider implements LyricsProvider {
  readonly id: LyricsProviderId = PROVIDER_ID
  readonly displayName = 'NetEase Cloud Music'

  private readonly fetchFn: FetchFunction
  private readonly sleepFn: SleepFunction
  private readonly nowFn: () => number
  private readonly randomFn: () => number
  private readonly baseUrl: string
  private readonly pacingMs: number
  private lastRequestTime: number | null = null
  private requestQueue: Promise<void> = Promise.resolve()

  constructor(options: NeteaseOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.nowFn = options.nowFn ?? (() => Date.now())
    this.randomFn = options.randomFn ?? (() => Math.random())
    this.baseUrl = (options.baseUrl ?? NETEASE_BASE).replace(/\/+$/, '')
    this.pacingMs = options.pacingMs ?? PACING_MS
  }

  /** Serializes all NetEase traffic at `concurrency = 1`. */
  fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsCandidate | null> {
    return this.enqueue(() => this.performFetch(query, signal))
  }

  searchAllCandidates(
    query: LyricsSearchRequest,
    signal?: AbortSignal
  ): Promise<LyricsSearchResult[]> {
    return this.enqueue(() => this.performSearchAllCandidates(query, signal))
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.requestQueue.then(task, task)
    this.requestQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ProviderError('ABORTED', 'NetEase request aborted', { providerId: PROVIDER_ID })
    }
  }

  private effectiveQuery(query: LyricsSearchRequest): LyricsQuery {
    return {
      trackId: query.trackId,
      title: query.searchTitle === undefined ? query.title : query.searchTitle.trim(),
      artist: query.searchArtist === undefined ? query.artist : query.searchArtist.trim(),
      album: query.searchAlbum === undefined ? query.album : query.searchAlbum.trim(),
      durationSec: query.durationSec,
      filePath: query.filePath
    }
  }

  /** Builds the single query variant NetEase searches with (its API is keyword-based). */
  private variantOf(query: LyricsQuery): QueryVariant {
    const title = query.title.trim()
    const artist = query.artist.trim()
    const album = query.album.trim()
    return { id: 'raw', title, artist, album, fingerprint: `${artist}\u0000${title}` }
  }

  private scoreFor(song: NeteaseSong, query: LyricsQuery, layers: NeteaseLayers) {
    return scoreCandidate({
      queryTitle: query.title,
      queryArtist: query.artist,
      queryAlbum: query.album,
      queryDurationSec: query.durationSec,
      candidateTitle: song.name,
      candidateArtist: song.artists.join(', '),
      candidateAlbum: song.album.length > 0 ? song.album : null,
      candidateDurationSec: song.durationSec > 0 ? song.durationSec : null,
      syncedLyrics: layers.primary,
      plainLyrics: null
    })
  }

  private async performFetch(
    query: LyricsQuery,
    signal?: AbortSignal
  ): Promise<LyricsCandidate | null> {
    this.throwIfAborted(signal)
    const variant = this.variantOf(query)
    if (variant.title.length === 0) return null

    const songs = await this.searchSongs(variant, signal)
    if (songs.length === 0) return null

    let best: EvaluatedCandidate | null = null
    // Metadata-score first so only the most plausible songs cost a lyric fetch.
    const ranked = songs
      .map((song) => ({
        song,
        metadataScore: scoreCandidate({
          queryTitle: variant.title,
          queryArtist: variant.artist,
          queryAlbum: variant.album,
          queryDurationSec: query.durationSec,
          candidateTitle: song.name,
          candidateArtist: song.artists.join(', '),
          candidateAlbum: song.album.length > 0 ? song.album : null,
          candidateDurationSec: song.durationSec > 0 ? song.durationSec : null
        }).score
      }))
      .sort((a, b) => b.metadataScore - a.metadataScore)
      .slice(0, MAX_LYRIC_FETCHES)

    for (const { song } of ranked) {
      this.throwIfAborted(signal)
      if (song.durationSec > 0) {
        const delta = Math.abs(song.durationSec - query.durationSec)
        if (query.durationSec > 0 && delta > 30) continue
      }

      const layers = await this.fetchLayers(song.id, signal)
      this.throwIfAborted(signal)
      if (!layers.primary) continue

      const scored = this.scoreFor(song, query, layers)
      const evaluation = evaluateCandidate({
        timingKind: scored.timingKind,
        score: scored.score,
        providerId: PROVIDER_ID,
        durationDeltaSec: scored.durationDeltaSec
      })
      if (evaluation.decision === 'REJECT' || evaluation.decision === 'CONTINUE') continue

      const candidate: LyricsCandidate = {
        providerId: PROVIDER_ID,
        syncedLyrics: layers.primary,
        plainLyrics: null,
        translatedLyrics: layers.translation,
        romanizedLyrics: layers.romanization,
        score: scored.score,
        timingKind: scored.timingKind,
        title: song.name,
        artist: song.artists.join(', '),
        album: song.album,
        durationSec: song.durationSec
      }

      if (evaluation.decision === 'ACCEPT_FINAL') return candidate
      best = pickBetterCandidate(best, { candidate, evaluation })
    }

    return best?.candidate ?? null
  }

  private async performSearchAllCandidates(
    query: LyricsSearchRequest,
    signal?: AbortSignal
  ): Promise<LyricsSearchResult[]> {
    this.throwIfAborted(signal)
    const effective = this.effectiveQuery(query)
    const variant = this.variantOf(effective)
    if (variant.title.length === 0) return []

    const songs = await this.searchSongs(variant, signal, true)
    if (songs.length === 0) return []

    // Cap lyric fetches to the best metadata matches so an interactive search
    // stays responsive even though each layer fetch costs a paced request.
    const bestByScore = songs
      .map((song) => ({
        song,
        metadataScore: scoreCandidate({
          queryTitle: variant.title,
          queryArtist: variant.artist,
          queryAlbum: variant.album,
          queryDurationSec: effective.durationSec,
          candidateTitle: song.name,
          candidateArtist: song.artists.join(', '),
          candidateAlbum: song.album.length > 0 ? song.album : null,
          candidateDurationSec: song.durationSec > 0 ? song.durationSec : null
        }).score
      }))
      .sort((a, b) => b.metadataScore - a.metadataScore)
      .slice(0, MAX_LYRIC_FETCHES)

    const results: LyricsSearchResult[] = []
    const seenLyrics = new Set<string>()
    let lastError: ProviderError | null = null

    for (const { song } of bestByScore) {
      this.throwIfAborted(signal)
      try {
        const layers = await this.fetchLayers(song.id, signal)
        if (!layers.primary) continue
        if (seenLyrics.has(layers.primary)) continue
        seenLyrics.add(layers.primary)

        const scored = this.scoreFor(song, effective, layers)
        results.push({
          providerId: PROVIDER_ID,
          sourceId: String(song.id),
          sourceRef: `${this.baseUrl}/api/song/lyric?id=${song.id}&lv=1&tv=1&rv=1`,
          title: song.name,
          artist: song.artists.join(', '),
          album: song.album,
          durationSec: song.durationSec,
          syncedLyrics: layers.primary,
          plainLyrics: null,
          translatedLyrics: layers.translation,
          romanizedLyrics: layers.romanization,
          score: scored.score,
          timingKind: scored.timingKind
        })
      } catch (error) {
        const providerError = classifyProviderError(error, PROVIDER_ID)
        if (providerError.kind === 'ABORTED') throw providerError
        lastError = providerError
        if (providerError.kind === 'RATE_LIMITED' || providerError.kind === 'NETWORK') break
      }
    }

    if (results.length === 0 && lastError) throw lastError

    return results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (
        Math.abs(a.durationSec - effective.durationSec) -
        Math.abs(b.durationSec - effective.durationSec)
      )
    })
  }

  private buildSearchUrl(keyword: string): string {
    const params = new URLSearchParams()
    params.set('s', keyword)
    params.set('type', '1')
    params.set('offset', '0')
    params.set('limit', String(SEARCH_LIMIT))
    return `${this.baseUrl}/api/search/get/web?${params.toString()}`
  }

  private buildLyricUrl(songId: number): string {
    const params = new URLSearchParams()
    params.set('id', String(songId))
    params.set('lv', '1')
    params.set('tv', '1')
    params.set('rv', '1')
    return `${this.baseUrl}/api/song/lyric?${params.toString()}`
  }

  /**
   * Keyword search. The strict `artist title` form is tried first, then the
   * looser `title` form so unusual artist credits (feat. lists) still match.
   */
  private async searchSongs(
    variant: QueryVariant,
    signal?: AbortSignal,
    includeTitleOnly = false
  ): Promise<NeteaseSong[]> {
    const keywords: string[] = []
    const strict = `${variant.artist} ${variant.title}`.trim()
    if (strict.length > 0) keywords.push(strict)
    if (includeTitleOnly && variant.title.length > 0) keywords.push(variant.title)

    const songs: NeteaseSong[] = []
    const seen = new Set<number>()

    for (const keyword of keywords) {
      this.throwIfAborted(signal)
      const data = await this.requestJson(this.buildSearchUrl(keyword), signal)
      const hits = this.parseSearchHits(data)
      for (const song of hits) {
        if (seen.has(song.id)) continue
        seen.add(song.id)
        songs.push(song)
      }
      if (songs.length >= MAX_LYRIC_FETCHES) break
    }

    return songs
  }

  private parseSearchHits(data: unknown): NeteaseSong[] {
    if (data === null) return []
    if (!isRecord(data)) {
      throw new ProviderError('BAD_RESPONSE', 'NetEase search returned a non-object payload', {
        providerId: PROVIDER_ID
      })
    }
    const result = data.result
    if (!isRecord(result)) return []
    const rawSongs = result.songs
    if (rawSongs !== undefined && !Array.isArray(rawSongs)) {
      throw new ProviderError('BAD_RESPONSE', 'NetEase search result.songs was not an array', {
        providerId: PROVIDER_ID
      })
    }
    const songs: NeteaseSong[] = []
    if (Array.isArray(rawSongs)) {
      for (const raw of rawSongs) {
        const song = normalizeSong(raw)
        if (song) songs.push(song)
      }
    }
    return songs
  }

  private async fetchLayers(songId: number, signal?: AbortSignal): Promise<NeteaseLayers> {
    const data = await this.requestJson(this.buildLyricUrl(songId), signal)
    return extractLayers(data)
  }

  private async requestJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
    const response = await this.fetchWithRetry(url, signal)
    if (!response) return null
    try {
      return (await response.json()) as unknown
    } catch (error) {
      throw new ProviderError('BAD_RESPONSE', 'NetEase returned invalid JSON', {
        providerId: PROVIDER_ID,
        cause: error
      })
    }
  }

  private async pace(signal?: AbortSignal): Promise<void> {
    if (this.lastRequestTime === null || this.pacingMs <= 0) return
    const elapsed = this.nowFn() - this.lastRequestTime
    if (elapsed < this.pacingMs) {
      await this.sleepFn(this.pacingMs - elapsed, signal)
    }
  }

  private jitter(baseMs: number): number {
    return baseMs + Math.floor(this.randomFn() * baseMs * 0.5)
  }

  /**
   * Paced GET with bounded 429/503 backoff. Pacing is recorded in `finally` so
   * even a thrown request keeps the end-to-start interval intact.
   */
  private async fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response | null> {
    let lastRetryAfterMs: number | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.throwIfAborted(signal)

      if (attempt === 0) {
        await this.pace(signal)
        this.throwIfAborted(signal)
      }

      let response: Response
      try {
        response = await this.fetchFn(url, {
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Referer: REFERER,
            Accept: 'application/json'
          },
          ...(signal ? { signal } : {})
        })
      } catch (error) {
        this.throwIfAborted(signal)
        const providerError = classifyProviderError(error, PROVIDER_ID)
        if (providerError.kind === 'ABORTED') throw providerError
        throw new ProviderError('NETWORK', providerError.message, {
          providerId: PROVIDER_ID,
          cause: error
        })
      } finally {
        this.lastRequestTime = this.nowFn()
      }

      if (response.status === 404) return null

      if (response.status === 429 || response.status === 503) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), this.nowFn())
        if (retryAfterMs !== null) lastRetryAfterMs = retryAfterMs

        if (attempt === MAX_RETRIES) {
          throw new ProviderError(
            'RATE_LIMITED',
            `NetEase rate-limited/unavailable (HTTP ${response.status}) after ${MAX_RETRIES + 1} attempts`,
            {
              providerId: PROVIDER_ID,
              ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {})
            }
          )
        }

        const delay =
          retryAfterMs !== null
            ? retryAfterMs
            : Math.min(this.jitter(BASE_BACKOFF_MS * 2 ** attempt), MAX_BACKOFF_MS)
        await this.sleepFn(delay, signal)
        this.throwIfAborted(signal)
        continue
      }

      if (!response.ok) {
        const kind: ProviderErrorKind = response.status >= 500 ? 'NETWORK' : 'BAD_RESPONSE'
        throw new ProviderError(kind, `NetEase request failed (HTTP ${response.status})`, {
          providerId: PROVIDER_ID
        })
      }

      return response
    }
    return null
  }
}

export function createNeteaseProvider(options: NeteaseOptions = {}): LyricsProvider {
  return new NeteaseProvider(options)
}
