/**
 * LRCLIB lyrics provider.
 *
 * Sequential `concurrency = 1`, ~400ms pacing (recorded in `finally` after each
 * request completes), custom `User-Agent`, and jittered exponential backoff with
 * `Retry-After` support on `429`/`503`. Queries are generated from
 * `buildQueryVariants`, every result is scored with `scoreCandidate`, and the
 * router decides whether to accept, keep as fallback, or keep searching.
 * Failures surface as typed `ProviderError`s.
 */

import { detectLyricsTimingKind } from '@shared/lrc'
import { buildQueryVariants, scoreCandidate, type QueryVariant } from '@shared/trackMatching'
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

const LRCLIB_BASE = 'https://lrclib.net'
const PROVIDER_ID: LyricsProviderId = 'lrclib'
const USER_AGENT = 'PowerampLrcEmbedder/0.1.0 (https://github.com/user/lyrics-embedder)'
const PACING_MS = 400
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 16_000
const MAX_RETRY_AFTER_MS = 60_000

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>
export type SleepFunction = (ms: number, signal?: AbortSignal) => Promise<void>

export interface LrclibOptions {
  fetchFn?: FetchFunction
  sleepFn?: SleepFunction
  nowFn?: () => number
  randomFn?: () => number
  baseUrl?: string
  pacingMs?: number
}

interface LrclibGetResponse {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
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

/**
 * Parses `Retry-After` header value. Supports both delay-seconds (integers) and
 * HTTP-date formats per RFC 9110.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function normalizeResult(value: unknown): LrclibGetResponse | null {
  if (!isRecord(value)) return null
  const result: LrclibGetResponse = {}
  if (typeof value.id === 'number' && Number.isFinite(value.id)) {
    result.id = value.id
  }
  const trackName = readString(value.trackName)
  if (trackName) result.trackName = trackName
  const artistName = readString(value.artistName)
  if (artistName) result.artistName = artistName
  const albumName = readString(value.albumName)
  if (albumName) result.albumName = albumName
  if (typeof value.duration === 'number' && Number.isFinite(value.duration)) {
    result.duration = value.duration
  }
  result.syncedLyrics = typeof value.syncedLyrics === 'string' ? value.syncedLyrics : null
  result.plainLyrics = typeof value.plainLyrics === 'string' ? value.plainLyrics : null
  return result
}

export class LrclibProvider implements LyricsProvider {
  readonly id: LyricsProviderId = PROVIDER_ID
  readonly displayName = 'LRCLIB'

  private readonly fetchFn: FetchFunction
  private readonly sleepFn: SleepFunction
  private readonly nowFn: () => number
  private readonly randomFn: () => number
  private readonly baseUrl: string
  private readonly pacingMs: number
  private lastRequestTime: number | null = null
  private requestQueue: Promise<void> = Promise.resolve()

  constructor(options: LrclibOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.nowFn = options.nowFn ?? (() => Date.now())
    this.randomFn = options.randomFn ?? (() => Math.random())
    this.baseUrl = (options.baseUrl ?? LRCLIB_BASE).replace(/\/+$/, '')
    this.pacingMs = options.pacingMs ?? PACING_MS
  }

  /**
   * Serializes all LRCLIB fetches at concurrency = 1 with pacing and retries.
   */
  fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsCandidate | null> {
    return this.enqueue(() => this.performFetch(query, signal))
  }

  /**
   * Interactive candidate listing: walks query variants, dedups by record id,
   * and returns every usable match sorted by `scoreCandidate`. Shares the same
   * `concurrency = 1` queue and pacing state as `fetch()`.
   */
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
      throw new ProviderError('ABORTED', 'LRCLIB request aborted', { providerId: PROVIDER_ID })
    }
  }

  private async performFetch(
    query: LyricsQuery,
    signal?: AbortSignal
  ): Promise<LyricsCandidate | null> {
    this.throwIfAborted(signal)

    const variants = buildQueryVariants(query)
    let best: EvaluatedCandidate | null = null

    for (const variant of variants) {
      this.throwIfAborted(signal)
      if (variant.title.length === 0) continue

      if (variant.artist.length > 0) {
        const getResult = await this.tryGet(variant, query.durationSec, signal)
        this.throwIfAborted(signal)
        if (getResult) {
          const evaluated = this.evaluateResult(getResult, variant, query)
          if (evaluated.evaluation.decision === 'ACCEPT_FINAL') return evaluated.candidate
          if (evaluated.evaluation.decision === 'KEEP_AS_FALLBACK') {
            best = pickBetterCandidate(best, evaluated)
          }
        }

        const structured = await this.trySearchStructured(variant, signal)
        this.throwIfAborted(signal)
        const structuredBest = this.evaluateResults(structured, variant, query)
        if (structuredBest) {
          if (structuredBest.evaluation.decision === 'ACCEPT_FINAL') {
            return structuredBest.candidate
          }
          if (structuredBest.evaluation.decision === 'KEEP_AS_FALLBACK') {
            best = pickBetterCandidate(best, structuredBest)
          }
        }
      }
    }

    // Broad `q` fallback runs only when no variant produced a final acceptance.
    this.throwIfAborted(signal)
    const fallbackVariant = variants[0]
    if (fallbackVariant && fallbackVariant.title.length > 0) {
      const broad = await this.trySearchQuery(fallbackVariant, signal)
      this.throwIfAborted(signal)
      const broadBest = this.evaluateResults(broad, fallbackVariant, query)
      if (broadBest) {
        if (broadBest.evaluation.decision === 'ACCEPT_FINAL') return broadBest.candidate
        if (broadBest.evaluation.decision === 'KEEP_AS_FALLBACK') {
          best = pickBetterCandidate(best, broadBest)
        }
      }
    }

    return best?.candidate ?? null
  }

  private buildEffectiveQuery(query: LyricsSearchRequest): LyricsQuery {
    // An explicit override always wins, including an empty string: clearing the
    // artist field in the interactive sifter must skip `/api/get` rather than
    // silently fall back to the track metadata.
    return {
      trackId: query.trackId,
      title: query.searchTitle === undefined ? query.title : query.searchTitle.trim(),
      artist: query.searchArtist === undefined ? query.artist : query.searchArtist.trim(),
      album: query.searchAlbum === undefined ? query.album : query.searchAlbum.trim(),
      durationSec: query.durationSec,
      filePath: query.filePath
    }
  }

  private async performSearchAllCandidates(
    query: LyricsSearchRequest,
    signal?: AbortSignal
  ): Promise<LyricsSearchResult[]> {
    this.throwIfAborted(signal)

    const effectiveQuery = this.buildEffectiveQuery(query)
    const variants = buildQueryVariants(effectiveQuery)
    const requestedUrls = new Set<string>()
    const collected: LrclibGetResponse[] = []
    const seenIds = new Set<number>()
    const seenLyrics = new Set<string>()
    let lastError: ProviderError | null = null

    const collect = (result: LrclibGetResponse): void => {
      if (!result.syncedLyrics && !result.plainLyrics) return
      if (typeof result.id === 'number') {
        if (seenIds.has(result.id)) return
        seenIds.add(result.id)
      }
      const lyricsKey = (result.syncedLyrics ?? result.plainLyrics ?? '').trim()
      if (lyricsKey.length > 0) {
        if (seenLyrics.has(lyricsKey)) return
        seenLyrics.add(lyricsKey)
      }
      collected.push(result)
    }

    for (const variant of variants) {
      this.throwIfAborted(signal)
      if (variant.title.length === 0) continue

      try {
        if (variant.artist.length > 0) {
          const getResult = await this.tryGet(
            variant,
            effectiveQuery.durationSec,
            signal,
            requestedUrls
          )
          if (getResult) collect(getResult)
        }

        const searchResults = await this.trySearchQuery(variant, signal, requestedUrls)
        for (const result of searchResults) collect(result)
      } catch (error) {
        const providerError = classifyProviderError(error, PROVIDER_ID)
        if (providerError.kind === 'ABORTED') throw providerError
        // Keep partial results from earlier variants; only the final throw
        // happens when nothing at all was collected.
        lastError = providerError
        // A rate-limited or offline server will fail every remaining variant:
        // stop issuing requests instead of hammering it.
        if (providerError.kind === 'RATE_LIMITED' || providerError.kind === 'NETWORK') {
          break
        }
      }
    }

    if (collected.length === 0 && lastError) throw lastError

    return collected
      .map((result) => this.toSearchResult(result, effectiveQuery))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return (
          Math.abs(a.durationSec - effectiveQuery.durationSec) -
          Math.abs(b.durationSec - effectiveQuery.durationSec)
        )
      })
  }

  private buildGetUrl(variant: QueryVariant, durationSec: number): string {
    const params = new URLSearchParams()
    params.set('track_name', variant.title)
    params.set('artist_name', variant.artist)
    if (variant.album) params.set('album_name', variant.album)
    const roundedDuration = Math.round(durationSec)
    if (roundedDuration >= 1 && roundedDuration <= 3600) {
      params.set('duration', String(roundedDuration))
    }
    return `${this.baseUrl}/api/get?${params.toString()}`
  }

  private buildStructuredSearchUrl(variant: QueryVariant): string {
    const params = new URLSearchParams()
    params.set('track_name', variant.title)
    params.set('artist_name', variant.artist)
    if (variant.album) params.set('album_name', variant.album)
    return `${this.baseUrl}/api/search?${params.toString()}`
  }

  private buildQuerySearchUrl(variant: QueryVariant): string {
    const params = new URLSearchParams()
    params.set('q', `${variant.artist} ${variant.title}`.trim())
    return `${this.baseUrl}/api/search?${params.toString()}`
  }

  private async requestJson(
    url: string,
    signal?: AbortSignal,
    seen?: Set<string>
  ): Promise<unknown | null> {
    if (seen) {
      if (seen.has(url)) return null
      seen.add(url)
    }

    const response = await this.fetchWithRetry(url, signal)
    if (!response) return null

    try {
      return (await response.json()) as unknown
    } catch (error) {
      throw new ProviderError('BAD_RESPONSE', 'LRCLIB returned invalid JSON', {
        providerId: PROVIDER_ID,
        cause: error
      })
    }
  }

  private parseResultArray(data: unknown): LrclibGetResponse[] {
    if (data === null) return []
    if (!Array.isArray(data)) {
      throw new ProviderError('BAD_RESPONSE', 'LRCLIB /api/search returned a non-array payload', {
        providerId: PROVIDER_ID
      })
    }
    const results: LrclibGetResponse[] = []
    for (const item of data) {
      const result = normalizeResult(item)
      if (result && (result.syncedLyrics || result.plainLyrics)) {
        results.push(result)
      }
    }
    return results
  }

  private async trySearchStructured(
    variant: QueryVariant,
    signal?: AbortSignal,
    seen?: Set<string>
  ): Promise<LrclibGetResponse[]> {
    if (variant.title.length === 0 || variant.artist.length === 0) return []
    const data = await this.requestJson(this.buildStructuredSearchUrl(variant), signal, seen)
    return this.parseResultArray(data)
  }

  private async trySearchQuery(
    variant: QueryVariant,
    signal?: AbortSignal,
    seen?: Set<string>
  ): Promise<LrclibGetResponse[]> {
    if (`${variant.artist} ${variant.title}`.trim().length === 0) return []
    const data = await this.requestJson(this.buildQuerySearchUrl(variant), signal, seen)
    return this.parseResultArray(data)
  }

  private evaluateResult(
    result: LrclibGetResponse,
    variant: QueryVariant,
    query: LyricsQuery
  ): EvaluatedCandidate {
    const rawSynced = result.syncedLyrics ?? null
    const rawPlain = result.plainLyrics ?? null
    const detected = detectLyricsTimingKind(rawSynced, rawPlain)

    // Invalid timestamps are treated as plain text so downstream consumers do
    // not try to parse them as synced lines.
    const syncedLyrics = detected === 'plain' ? null : rawSynced
    const plainLyrics = detected === 'plain' ? (rawPlain ?? rawSynced) : rawPlain

    const scored = scoreCandidate({
      queryTitle: variant.title,
      queryArtist: variant.artist,
      queryAlbum: variant.album,
      queryDurationSec: query.durationSec,
      // A record returned for this exact query that omits a metadata field is
      // treated as agreeing with the query for that field; otherwise absent
      // metadata would trip the wrong-song confidence gate.
      candidateTitle: result.trackName ?? variant.title,
      candidateArtist: result.artistName ?? variant.artist,
      candidateAlbum: result.albumName ?? null,
      candidateDurationSec: result.duration ?? null,
      syncedLyrics,
      plainLyrics
    })

    const candidate: LyricsCandidate = {
      providerId: PROVIDER_ID,
      syncedLyrics,
      plainLyrics,
      score: scored.score,
      timingKind: scored.timingKind
    }

    const evaluation = evaluateCandidate({
      timingKind: scored.timingKind,
      score: scored.score,
      providerId: PROVIDER_ID,
      durationDeltaSec: scored.durationDeltaSec
    })

    return { candidate, evaluation }
  }

  private evaluateResults(
    results: LrclibGetResponse[],
    variant: QueryVariant,
    query: LyricsQuery
  ): EvaluatedCandidate | null {
    let best: EvaluatedCandidate | null = null
    for (const result of results) {
      const evaluated = this.evaluateResult(result, variant, query)
      if (evaluated.evaluation.decision === 'REJECT' || evaluated.evaluation.decision === 'CONTINUE') {
        continue
      }
      best = pickBetterCandidate(best, evaluated)
    }
    return best
  }

  private toSearchResult(result: LrclibGetResponse, query: LyricsQuery): LyricsSearchResult {
    const sourceId = typeof result.id === 'number' ? String(result.id) : undefined
    const rawSynced = result.syncedLyrics ?? null
    const rawPlain = result.plainLyrics ?? null
    // Validate timestamps before handing the candidate to the sifter: payloads
    // with unusable `[mm:ss.xx]` tags are downgraded to plain lyrics so the UI
    // never offers a broken "synced" candidate.
    const timingKind = detectLyricsTimingKind(rawSynced, rawPlain)
    const syncedLyrics = timingKind === 'plain' ? null : rawSynced
    const plainLyrics = timingKind === 'plain' ? (rawPlain ?? rawSynced) : rawPlain
    const scored = scoreCandidate({
      queryTitle: query.title,
      queryArtist: query.artist,
      queryAlbum: query.album,
      queryDurationSec: query.durationSec,
      candidateTitle: result.trackName ?? query.title,
      candidateArtist: result.artistName ?? query.artist,
      candidateAlbum: result.albumName ?? null,
      candidateDurationSec: result.duration ?? null,
      syncedLyrics,
      plainLyrics
    })
    return {
      providerId: PROVIDER_ID,
      ...(sourceId ? { sourceId } : {}),
      title: result.trackName ?? query.title,
      artist: result.artistName ?? query.artist,
      album: result.albumName ?? query.album,
      durationSec:
        typeof result.duration === 'number' && Number.isFinite(result.duration)
          ? result.duration
          : 0,
      syncedLyrics,
      plainLyrics,
      ...(sourceId ? { sourceRef: `${this.baseUrl}/api/get/${sourceId}` } : {}),
      score: scored.score,
      timingKind
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
   * Executes an HTTP GET with pacing and bounded retries.
   * Returns `null` only for HTTP 404 (not found).
   * Throws `ProviderError` on aborts, network failures, invalid statuses, and
   * exhausted 429/503 retries.
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

      if (response.status === 404) {
        return null
      }

      if (response.status === 429 || response.status === 503) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), this.nowFn())
        if (retryAfterMs !== null) lastRetryAfterMs = retryAfterMs

        if (attempt === MAX_RETRIES) {
          throw new ProviderError(
            'RATE_LIMITED',
            `LRCLIB rate-limited/unavailable (HTTP ${response.status}) after ${MAX_RETRIES + 1} attempts`,
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
        throw new ProviderError(kind, `LRCLIB request failed (HTTP ${response.status})`, {
          providerId: PROVIDER_ID
        })
      }

      return response
    }
    return null
  }

  private async tryGet(
    variant: QueryVariant,
    durationSec: number,
    signal?: AbortSignal,
    seen?: Set<string>
  ): Promise<LrclibGetResponse | null> {
    if (variant.title.length === 0 || variant.artist.length === 0) return null

    const data = await this.requestJson(this.buildGetUrl(variant, durationSec), signal, seen)
    if (data === null) return null
    if (!isRecord(data)) {
      throw new ProviderError('BAD_RESPONSE', 'LRCLIB /api/get returned an invalid payload', {
        providerId: PROVIDER_ID
      })
    }

    const result = normalizeResult(data)
    if (!result || (!result.syncedLyrics && !result.plainLyrics)) return null
    return result
  }
}

export function createLrclibProvider(options: LrclibOptions = {}): LyricsProvider {
  return new LrclibProvider(options)
}
