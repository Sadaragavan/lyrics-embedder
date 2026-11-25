import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LrclibProvider,
  parseRetryAfterMs,
  type FetchFunction,
  type SleepFunction
} from '../src/main/providers/lrclib'
import type { LyricsQuery } from '../src/shared/types'

function makeQuery(overrides: Partial<LyricsQuery> = {}): LyricsQuery {
  return {
    trackId: 'a'.repeat(32),
    title: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Album',
    durationSec: 240,
    filePath: '/music/test.flac',
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('parseRetryAfterMs', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('5', 1_000)).toBe(5_000)
    expect(parseRetryAfterMs('0', 1_000)).toBe(0)
  })

  it('parses HTTP-date relative to nowMs', () => {
    const now = Date.UTC(2026, 10, 25, 12, 0, 0)
    // RFC 1123 HTTP-date has 1-second resolution
    const retryDate = new Date(now + 4_000).toUTCString()
    expect(parseRetryAfterMs(retryDate, now)).toBe(4_000)
  })

  it('clamps past HTTP-dates to 0 and huge delays to max bound', () => {
    const now = Date.UTC(2026, 10, 25, 12, 0, 0)
    const pastDate = new Date(now - 5_000).toUTCString()
    expect(parseRetryAfterMs(pastDate, now)).toBe(0)
    expect(parseRetryAfterMs('999999', now)).toBe(60_000)
  })

  it('returns null for missing or invalid headers', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('invalid-date')).toBeNull()
  })
})

describe('LrclibProvider', () => {
  let fetchFn: FetchFunction
  let sleepCalls: number[]
  let sleepFn: SleepFunction
  let fakeNow: number
  let provider: LrclibProvider

  beforeEach(() => {
    fetchFn = vi.fn()
    sleepCalls = []
    fakeNow = 10_000
    sleepFn = vi.fn(async (ms: number) => {
      sleepCalls.push(ms)
      fakeNow += ms
    })
    provider = new LrclibProvider({
      fetchFn,
      sleepFn,
      nowFn: () => fakeNow,
      randomFn: () => 0.5,
      pacingMs: 400,
      baseUrl: 'https://lrclib.test'
    })
  })

  it('returns synced lyrics from /api/get', async () => {
    vi.mocked(fetchFn).mockResolvedValueOnce(
      jsonResponse({
        id: 1,
        trackName: 'Test Song',
        artistName: 'Test Artist',
        duration: 240,
        syncedLyrics: '[00:01.00]Hello',
        plainLyrics: 'Hello'
      })
    )

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('lrclib')
    expect(result!.syncedLyrics).toBe('[00:01.00]Hello')
    expect(result!.plainLyrics).toBe('Hello')
    expect(result!.score).toBe(18)
  })

  it('falls back to /api/search with ~400ms pacing when /api/get returns 404', async () => {
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 2,
            trackName: 'Test Song',
            artistName: 'Test Artist',
            duration: 240,
            syncedLyrics: '[00:01.00]Found via search',
            plainLyrics: null
          }
        ])
      )

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBe('[00:01.00]Found via search')
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(2)
    expect(sleepCalls).toEqual([400])
  })

  it('skips /api/get when artist is empty and searches directly', async () => {
    vi.mocked(fetchFn).mockResolvedValueOnce(
      jsonResponse([
        {
          syncedLyrics: '[00:01.00]Title only match',
          plainLyrics: null
        }
      ])
    )

    const result = await provider.fetch(makeQuery({ artist: '' }))
    expect(result!.syncedLyrics).toBe('[00:01.00]Title only match')
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchFn).mock.calls[0]![0]).toContain('/api/search')
  })

  it('returns null when both endpoints return 404', async () => {
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    const result = await provider.fetch(makeQuery())
    expect(result).toBeNull()
  })

  it('retries on 429 with Retry-After seconds', async () => {
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          syncedLyrics: '[00:01.00]After retry',
          plainLyrics: null
        })
      )

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBe('[00:01.00]After retry')
    expect(sleepCalls).toEqual([3_000])
  })

  it('retries on 429 with Retry-After HTTP-date', async () => {
    const retryDate = new Date(fakeNow + 2_000).toUTCString()
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'Retry-After': retryDate } })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          syncedLyrics: '[00:01.00]After HTTP-date',
          plainLyrics: null
        })
      )

    const result = await provider.fetch(makeQuery())
    expect(result!.syncedLyrics).toBe('[00:01.00]After HTTP-date')
    expect(sleepCalls).toEqual([2_000])
  })

  it('retries on 503 with jittered exponential backoff when Retry-After is absent', async () => {
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          syncedLyrics: '[00:01.00]Recovered',
          plainLyrics: null
        })
      )

    const result = await provider.fetch(makeQuery())
    expect(result!.syncedLyrics).toBe('[00:01.00]Recovered')
    // randomFn = 0.5 -> base * (1 + 0.25) = 1250, 2500
    expect(sleepCalls).toEqual([1_250, 2_500])
  })

  it('returns null on network error', async () => {
    vi.mocked(fetchFn).mockRejectedValueOnce(new Error('Network down'))
    vi.mocked(fetchFn).mockResolvedValueOnce(new Response(null, { status: 404 }))

    const result = await provider.fetch(makeQuery())
    expect(result).toBeNull()
  })

  it('enforces sequential concurrency = 1 across concurrent fetch calls', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    vi.mocked(fetchFn)
      .mockImplementationOnce(async () => {
        events.push('start-1')
        await firstGate
        events.push('end-1')
        return jsonResponse({ syncedLyrics: '[00:01.00]One', plainLyrics: null })
      })
      .mockImplementationOnce(async () => {
        events.push('start-2')
        events.push('end-2')
        return jsonResponse({ syncedLyrics: '[00:02.00]Two', plainLyrics: null })
      })

    const p1 = provider.fetch(makeQuery({ trackId: 'a'.repeat(32) }))
    const p2 = provider.fetch(makeQuery({ trackId: 'b'.repeat(32) }))

    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['start-1'])

    releaseFirst()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1!.syncedLyrics).toBe('[00:01.00]One')
    expect(r2!.syncedLyrics).toBe('[00:02.00]Two')
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
    expect(sleepCalls).toEqual([400])
  })

  it('includes duration only within valid LRCLIB range and sends custom User-Agent', async () => {
    vi.mocked(fetchFn).mockResolvedValue(new Response(null, { status: 404 }))

    await provider.fetch(makeQuery({ durationSec: 180 }))
    const firstCall = vi.mocked(fetchFn).mock.calls[0]!
    expect(firstCall[0]).toContain('duration=180')
    const headers = firstCall[1].headers as Record<string, string>
    expect(headers['User-Agent']).toContain('PowerampLrcEmbedder')

    await provider.fetch(makeQuery({ durationSec: 5000 }))
    const thirdCall = vi.mocked(fetchFn).mock.calls[2]!
    expect(thirdCall[0]).not.toContain('duration=')
  })

  it('picks best result from search by score', async () => {
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse([
          { syncedLyrics: null, plainLyrics: 'Plain only', duration: 999 },
          { syncedLyrics: '[00:01.00]Synced', plainLyrics: 'Also plain', duration: 240 }
        ])
      )

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBe('[00:01.00]Synced')
  })

  it('aborts cleanly when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await provider.fetch(makeQuery(), controller.signal)
    expect(result).toBeNull()
    expect(vi.mocked(fetchFn)).not.toHaveBeenCalled()
  })
})
