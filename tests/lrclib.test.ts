import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LrclibProvider,
  parseRetryAfterMs,
  type FetchFunction,
  type SleepFunction
} from '../src/main/providers/lrclib'
import { ProviderError } from '../src/main/providers/router'
import type { LyricsQuery, LyricsSearchRequest } from '../src/shared/types'

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

function makeSearchQuery(overrides: Partial<LyricsSearchRequest> = {}): LyricsSearchRequest {
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
    expect(result!.score).toBe(88)
    expect(result!.timingKind).toBe('line')
  })

  it('falls back to /api/search with ~400ms pacing after fetchFn completes on 404', async () => {
    vi.mocked(fetchFn)
      .mockImplementationOnce(async () => {
        // Simulate 250ms HTTP latency; pacing must wait 400ms AFTER completion
        fakeNow += 250
        return new Response(null, { status: 404 })
      })
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

  it('returns null when all variants and endpoints return 404', async () => {
    vi.mocked(fetchFn).mockResolvedValue(new Response(null, { status: 404 }))

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

  it('throws on exhausted 429/503 retries without falling back to /api/search', async () => {
    vi.mocked(fetchFn).mockImplementation(async () => new Response(null, { status: 429 }))

    await expect(provider.fetch(makeQuery())).rejects.toThrow(/429/)
    // 1 initial + 3 retries = 4 calls; must NOT invoke /api/search after exhaustion
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(4)
  })

  it('throws on network error without falling back to /api/search', async () => {
    vi.mocked(fetchFn).mockRejectedValueOnce(new Error('Network down'))

    await expect(provider.fetch(makeQuery())).rejects.toThrow('Network down')
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1)
  })

  it('throws on non-404 HTTP error without falling back to /api/search', async () => {
    vi.mocked(fetchFn).mockResolvedValueOnce(new Response(null, { status: 500 }))

    await expect(provider.fetch(makeQuery())).rejects.toThrow(/HTTP 500/)
    expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1)
  })

  it('populates timingKind=word for A2 word-synced candidates', async () => {
    const wordLrc = '[00:01.00]<00:01.00>Hel<00:01.50>lo'
    vi.mocked(fetchFn).mockResolvedValueOnce(
      jsonResponse({
        id: 1,
        trackName: 'Test Song',
        artistName: 'Test Artist',
        duration: 240,
        syncedLyrics: wordLrc,
        plainLyrics: null
      })
    )

    const result = await provider.fetch(makeQuery())
    expect(result!.timingKind).toBe('word')
    expect(result!.syncedLyrics).toBe(wordLrc)
  })

  it('treats invalid timestamps as plain lyrics', async () => {
    vi.mocked(fetchFn)
      .mockResolvedValueOnce(
        jsonResponse({
          id: 1,
          trackName: 'Test Song',
          artistName: 'Test Artist',
          duration: 240,
          syncedLyrics: '[00:75.00]Bad timestamp',
          plainLyrics: null
        })
      )
      .mockResolvedValue(new Response(null, { status: 404 }))

    const result = await provider.fetch(makeQuery())
    expect(result!.timingKind).toBe('plain')
    expect(result!.syncedLyrics).toBeNull()
    expect(result!.plainLyrics).toBe('[00:75.00]Bad timestamp')
  })

  it('throws a typed RATE_LIMITED error on exhausted 429 retries', async () => {
    vi.mocked(fetchFn).mockImplementation(async () => new Response(null, { status: 429 }))

    const error = await provider.fetch(makeQuery()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('RATE_LIMITED')
    expect((error as ProviderError).providerId).toBe('lrclib')
  })

  it('throws a typed NETWORK error on fetch failure', async () => {
    vi.mocked(fetchFn).mockRejectedValueOnce(new TypeError('fetch failed'))

    const error = await provider.fetch(makeQuery()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('NETWORK')
  })

  it('throws a typed BAD_RESPONSE error on invalid JSON', async () => {
    vi.mocked(fetchFn).mockResolvedValueOnce(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    const error = await provider.fetch(makeQuery()).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('BAD_RESPONSE')
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

    vi.mocked(fetchFn).mockClear()
    await provider.fetch(makeQuery({ durationSec: 5000 }))
    const firstCallOfSecondFetch = vi.mocked(fetchFn).mock.calls[0]!
    expect(firstCallOfSecondFetch[0]).toContain('/api/get')
    expect(firstCallOfSecondFetch[0]).not.toContain('duration=')
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

  it('throws a typed ABORTED error when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(provider.fetch(makeQuery(), controller.signal)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'ABORTED',
      providerId: 'lrclib'
    })
    expect(vi.mocked(fetchFn)).not.toHaveBeenCalled()
  })

  describe('searchAllCandidates', () => {
    it('dedups multi-candidates returned by both /api/get and /api/search', async () => {
      vi.mocked(fetchFn)
        .mockResolvedValueOnce(
          jsonResponse({
            id: 1,
            trackName: 'Test Song',
            artistName: 'Test Artist',
            albumName: 'Test Album',
            duration: 240,
            syncedLyrics: '[00:01.00]One',
            plainLyrics: 'One'
          })
        )
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 1,
              trackName: 'Test Song',
              artistName: 'Test Artist',
              albumName: 'Test Album',
              duration: 240,
              syncedLyrics: '[00:01.00]One',
              plainLyrics: 'One'
            },
            {
              id: 2,
              trackName: 'Test Song',
              artistName: 'Test Artist',
              albumName: 'Deluxe',
              duration: 243,
              syncedLyrics: '[00:01.00]Two',
              plainLyrics: 'Two'
            },
            {
              id: 3,
              trackName: 'Other',
              artistName: 'Nobody',
              duration: 100,
              syncedLyrics: null,
              plainLyrics: null
            }
          ])
        )

      const results = await provider.searchAllCandidates(makeSearchQuery())

      expect(results).toHaveLength(2)
      expect(results.map((result) => result.sourceId)).toEqual(['1', '2'])
      expect(results[0]!.syncedLyrics).toBe('[00:01.00]One')
      expect(results[0]!.sourceRef).toBe('https://lrclib.test/api/get/1')
      expect(results[1]!.album).toBe('Deluxe')
      expect(results[1]!.providerId).toBe('lrclib')
    })

    it('paces the /api/search call after /api/get using the shared queue', async () => {
      vi.mocked(fetchFn)
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 7,
              trackName: 'Test Song',
              artistName: 'Test Artist',
              duration: 240,
              syncedLyrics: '[00:01.00]Search only',
              plainLyrics: null
            }
          ])
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }))

      const results = await provider.searchAllCandidates(makeSearchQuery())

      expect(results).toHaveLength(1)
      expect(results[0]!.syncedLyrics).toBe('[00:01.00]Search only')
      // raw /api/get, raw /api/search, then cleaned /api/get (cleaned /api/search
      // is deduplicated because it has the same q URL)
      expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(3)
      expect(sleepCalls).toEqual([400, 400])
    })

    it('uses interactive search overrides in /api/get and /api/search queries', async () => {
      vi.mocked(fetchFn)
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))

      await provider.searchAllCandidates(
        makeSearchQuery({
          searchTitle: 'Alt Title',
          searchArtist: 'Alt Artist',
          searchAlbum: 'Alt Album'
        })
      )

      const getUrl = vi.mocked(fetchFn).mock.calls[0]![0]
      const searchUrl = vi.mocked(fetchFn).mock.calls[1]![0]
      expect(getUrl).toContain('/api/get')
      expect(getUrl).toContain('track_name=Alt+Title')
      expect(getUrl).toContain('artist_name=Alt+Artist')
      expect(getUrl).toContain('album_name=Alt+Album')
      expect(searchUrl).toContain('/api/search')
      expect(searchUrl).toContain('q=Alt+Artist+Alt+Title')
    })

    it('stops issuing requests once the server reports RATE_LIMITED', async () => {
      vi.mocked(fetchFn).mockImplementation(
        async () => new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
      )

      const error = await provider
        .searchAllCandidates(makeSearchQuery())
        .catch((err: unknown) => err)
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).kind).toBe('RATE_LIMITED')
      // 4 attempts for the first request, then the variant loop must break.
      expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(4)
    })

    it('stops issuing requests once the server is unreachable (NETWORK)', async () => {
      vi.mocked(fetchFn).mockRejectedValue(new TypeError('fetch failed'))

      const error = await provider
        .searchAllCandidates(makeSearchQuery())
        .catch((err: unknown) => err)
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).kind).toBe('NETWORK')
      expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1)
    })

    it('keeps partial results collected before a rate-limit failure', async () => {
      vi.mocked(fetchFn)
        .mockResolvedValueOnce(
          jsonResponse({
            id: 11,
            trackName: 'Test Song',
            artistName: 'Test Artist',
            duration: 240,
            syncedLyrics: '[00:01.00]First',
            plainLyrics: null
          })
        )
        .mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '0' } }))

      const results = await provider.searchAllCandidates(makeSearchQuery())
      expect(results).toHaveLength(1)
      expect(results[0]!.sourceId).toBe('11')
    })

    it('sanitizes invalid timestamps and populates timingKind', async () => {
      vi.mocked(fetchFn)
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 21,
              trackName: 'Test Song',
              artistName: 'Test Artist',
              duration: 240,
              syncedLyrics: '[00:75.00]Bad timestamp',
              plainLyrics: null
            },
            {
              id: 22,
              trackName: 'Test Song',
              artistName: 'Test Artist',
              duration: 240,
              syncedLyrics: '[00:01.00]<00:01.00>He<00:01.50>llo',
              plainLyrics: null
            }
          ])
        )
        .mockResolvedValue(new Response(null, { status: 404 }))

      const results = await provider.searchAllCandidates(makeSearchQuery())
      const broken = results.find((result) => result.sourceId === '21')!
      const word = results.find((result) => result.sourceId === '22')!

      expect(broken.timingKind).toBe('plain')
      expect(broken.syncedLyrics).toBeNull()
      expect(broken.plainLyrics).toBe('[00:75.00]Bad timestamp')

      expect(word.timingKind).toBe('word')
      expect(word.syncedLyrics).toContain('<00:01.50>')
    })

    it('marks line-synced candidates with timingKind=line', async () => {
      vi.mocked(fetchFn)
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 31,
              trackName: 'Test Song',
              artistName: 'Test Artist',
              duration: 240,
              syncedLyrics: '[00:01.00]Plain line',
              plainLyrics: 'Plain line'
            }
          ])
        )
        .mockResolvedValue(new Response(null, { status: 404 }))

      const results = await provider.searchAllCandidates(makeSearchQuery())
      expect(results[0]!.timingKind).toBe('line')
    })

    it('skips /api/get when the overridden artist is empty', async () => {
      vi.mocked(fetchFn).mockResolvedValueOnce(
        jsonResponse([
          {
            id: 9,
            trackName: 'Test Song',
            artistName: 'Test Artist',
            duration: 240,
            syncedLyrics: '[00:01.00]Search only',
            plainLyrics: null
          }
        ])
      )

      const results = await provider.searchAllCandidates(
        makeSearchQuery({ searchArtist: '' })
      )

      expect(results).toHaveLength(1)
      expect(vi.mocked(fetchFn)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fetchFn).mock.calls[0]![0]).toContain('/api/search')
    })
  })
})
