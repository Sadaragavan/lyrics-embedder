/**
 * LRCLIB lyrics provider.
 *
 * Sequential `concurrency = 1`, ~400ms pacing, custom `User-Agent`,
 * `/api/get` -> `/api/search` fallback, and `429`/`503` `Retry-After`
 * (seconds + HTTP-date) + jittered exponential backoff.
 *
 * Network calls, timer sleep, clock, and RNG can be injected for deterministic testing.
 */

import type {
  LyricsCandidate,
  LyricsProvider,
  LyricsProviderId,
  LyricsQuery
} from '@shared/types'

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

function scoreLrclibResult(result: LrclibGetResponse, query: LyricsQuery): number {
  let score = 0
  if (result.syncedLyrics) score += 10
  if (result.plainLyrics) score += 5
  if (
    result.duration !== undefined &&
    query.durationSec > 0 &&
    Math.abs(result.duration - query.durationSec) <= 3
  ) {
    score += 3
  }
  return score
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

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.requestQueue.then(task, task)
    this.requestQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async performFetch(
    query: LyricsQuery,
    signal?: AbortSignal
  ): Promise<LyricsCandidate | null> {
    if (signal?.aborted) return null

    const hasExactFields = query.title.trim().length > 0 && query.artist.trim().length > 0
    if (hasExactFields) {
      const getResult = await this.tryGet(query, signal)
      if (signal?.aborted) return null
      if (getResult) {
        return {
          providerId: PROVIDER_ID,
          syncedLyrics: getResult.syncedLyrics ?? null,
          plainLyrics: getResult.plainLyrics ?? null,
          score: scoreLrclibResult(getResult, query)
        }
      }
    }

    if (signal?.aborted) return null

    const searchResult = await this.trySearch(query, signal)
    if (signal?.aborted) return null
    if (searchResult) {
      return {
        providerId: PROVIDER_ID,
        syncedLyrics: searchResult.syncedLyrics ?? null,
        plainLyrics: searchResult.plainLyrics ?? null,
        score: scoreLrclibResult(searchResult, query)
      }
    }

    return null
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

  private async fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) return null

      if (attempt === 0) {
        await this.pace(signal)
        if (signal?.aborted) return null
      }

      this.lastRequestTime = this.nowFn()
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
      } catch {
        return null
      }

      if (response.status === 404) {
        return null
      }

      if (response.status === 429 || response.status === 503) {
        if (attempt === MAX_RETRIES) return null
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), this.nowFn())
        const delay =
          retryAfterMs !== null
            ? retryAfterMs
            : Math.min(this.jitter(BASE_BACKOFF_MS * 2 ** attempt), MAX_BACKOFF_MS)
        await this.sleepFn(delay, signal)
        continue
      }

      if (!response.ok) {
        return null
      }

      return response
    }
    return null
  }

  private async tryGet(
    query: LyricsQuery,
    signal?: AbortSignal
  ): Promise<LrclibGetResponse | null> {
    const params = new URLSearchParams()
    params.set('track_name', query.title)
    params.set('artist_name', query.artist)
    if (query.album) params.set('album_name', query.album)
    const roundedDuration = Math.round(query.durationSec)
    if (roundedDuration >= 1 && roundedDuration <= 3600) {
      params.set('duration', String(roundedDuration))
    }

    const url = `${this.baseUrl}/api/get?${params.toString()}`
    const response = await this.fetchWithRetry(url, signal)
    if (!response) return null

    try {
      const data = (await response.json()) as LrclibGetResponse
      if (!data.syncedLyrics && !data.plainLyrics) return null
      return data
    } catch {
      return null
    }
  }

  private async trySearch(
    query: LyricsQuery,
    signal?: AbortSignal
  ): Promise<LrclibGetResponse | null> {
    const searchQuery = `${query.artist} ${query.title}`.trim()
    if (searchQuery.length === 0) return null

    const params = new URLSearchParams()
    params.set('q', searchQuery)

    const url = `${this.baseUrl}/api/search?${params.toString()}`
    const response = await this.fetchWithRetry(url, signal)
    if (!response) return null

    try {
      const data = (await response.json()) as LrclibGetResponse[]
      if (!Array.isArray(data) || data.length === 0) return null

      let best: LrclibGetResponse | null = null
      let bestScore = -1
      for (const result of data) {
        if (!result.syncedLyrics && !result.plainLyrics) continue
        const s = scoreLrclibResult(result, query)
        if (s > bestScore) {
          bestScore = s
          best = result
        }
      }
      return best
    } catch {
      return null
    }
  }
}

export function createLrclibProvider(options: LrclibOptions = {}): LyricsProvider {
  return new LrclibProvider(options)
}
