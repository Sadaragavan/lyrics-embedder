import { describe, expect, it } from 'vitest'
import {
  NeteaseProvider,
  extractLayers,
  normalizeSong,
  parseRetryAfterMs,
  type FetchFunction,
  type SleepFunction
} from '../src/main/providers/netease'
import { ProviderError } from '../src/main/providers/router'
import type { LyricsQuery, LyricsSearchRequest } from '../src/shared/types'

const PRIMARY = '[00:01.00]First line\n[00:02.00]Second line'
const TRANSLATION = '[00:01.00]Primera línea\n[00:02.00]Segunda línea'
const ROMANIZATION = '[00:01.00]Fāsuto rain\n[00:02.00]Sekando rain'

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

function searchBody(
  songs: Array<{ id?: number; name?: string; artist?: string; album?: string; ms?: number }>
): unknown {
  return {
    code: 200,
    result: {
      songs: songs.map((song) => ({
        id: song.id ?? 1,
        name: song.name ?? 'Test Song',
        artists: [{ name: song.artist ?? 'Test Artist' }],
        album: { name: song.album ?? 'Test Album' },
        duration: song.ms ?? 240_000
      }))
    }
  }
}

function lyricBody(
  layers: { lrc?: string | null; tlyric?: string | null; romalrc?: string | null }
): unknown {
  return {
    code: 200,
    lrc: { lyric: layers.lrc ?? '' },
    tlyric: { lyric: layers.tlyric ?? '' },
    romalrc: { lyric: layers.romalrc ?? '' }
  }
}

/** Records every request and replies from a URL -> response map. */
function makeFetch(
  handler: (url: string) => Response | Promise<Response>
): FetchFunction & { calls: string[]; headers: Array<Record<string, string>> } {
  const calls: string[] = []
  const headers: Array<Record<string, string>> = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push(url)
    headers.push((init.headers ?? {}) as Record<string, string>)
    return handler(url)
  }) as FetchFunction & { calls: string[]; headers: Array<Record<string, string>> }
  fn.calls = calls
  fn.headers = headers
  return fn
}

const noSleep: SleepFunction = async () => {}

describe('normalizeSong', () => {
  it('parses the NetEase search hit shape (ms duration -> seconds)', () => {
    expect(
      normalizeSong({
        id: 123,
        name: 'Song',
        artists: [{ name: 'A' }, { name: 'B' }],
        album: { name: 'Album' },
        duration: 245_000
      })
    ).toEqual({ id: 123, name: 'Song', artists: ['A', 'B'], album: 'Album', durationSec: 245 })
  })

  it('supports the v3 `ar`/`al`/`dt` aliases', () => {
    expect(
      normalizeSong({ id: 5, name: 'N', ar: [{ name: 'X' }], al: { name: 'L' }, dt: 60_000 })
    ).toEqual({ id: 5, name: 'N', artists: ['X'], album: 'L', durationSec: 60 })
  })

  it('rejects a hit without an id or name', () => {
    expect(normalizeSong({ name: 'No id' })).toBeNull()
    expect(normalizeSong({ id: 1, name: '   ' })).toBeNull()
    expect(normalizeSong(null)).toBeNull()
    expect(normalizeSong('nope')).toBeNull()
  })
})

describe('extractLayers', () => {
  it('extracts all three layers when every one is timestamped', () => {
    expect(
      extractLayers(
        lyricBody({ lrc: PRIMARY, tlyric: TRANSLATION, romalrc: ROMANIZATION })
      )
    ).toEqual({ primary: PRIMARY, translation: TRANSLATION, romanization: ROMANIZATION })
  })

  it('drops layers that are empty or missing timestamps', () => {
    expect(extractLayers(lyricBody({ lrc: PRIMARY, tlyric: 'no timestamps here' }))).toEqual({
      primary: PRIMARY,
      translation: null,
      romanization: null
    })
  })

  it('returns empty layers when the primary is un-timed', () => {
    expect(extractLayers(lyricBody({ lrc: 'plain words', tlyric: TRANSLATION }))).toEqual({
      primary: null,
      translation: null,
      romanization: null
    })
  })

  it('tolerates a malformed payload', () => {
    expect(extractLayers(null)).toEqual({ primary: null, translation: null, romanization: null })
    expect(extractLayers({})).toEqual({ primary: null, translation: null, romanization: null })
    expect(extractLayers({ lrc: 'string-not-object' })).toEqual({
      primary: null,
      translation: null,
      romanization: null
    })
  })
})

describe('parseRetryAfterMs', () => {
  it('parses seconds and clamps huge values', () => {
    expect(parseRetryAfterMs('3', 0)).toBe(3000)
    expect(parseRetryAfterMs('999999', 0)).toBe(30_000)
  })

  it('returns null for junk or absence', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('   ')).toBeNull()
  })
})

describe('NeteaseProvider.fetch', () => {
  it('returns a candidate carrying all three layers', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 7, name: 'Test Song', artist: 'Test Artist' }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY, tlyric: TRANSLATION, romalrc: ROMANIZATION }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    const candidate = await provider.fetch(makeQuery())

    expect(candidate).not.toBeNull()
    expect(candidate?.providerId).toBe('netease')
    expect(candidate?.syncedLyrics).toBe(PRIMARY)
    expect(candidate?.translatedLyrics).toBe(TRANSLATION)
    expect(candidate?.romanizedLyrics).toBe(ROMANIZATION)
    expect(candidate?.timingKind).toBe('line')
    expect(candidate?.score).toBeGreaterThan(0)
  })

  it('sends the NetEase Referer and a browser User-Agent', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 7 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await provider.fetch(makeQuery())
    expect(fetchFn.headers[0]?.Referer).toBe('https://music.163.com/')
    expect(fetchFn.headers[0]?.['User-Agent']).toMatch(/Mozilla/)
    expect(fetchFn.headers[0]?.Accept).toBe('application/json')
  })

  it('builds the documented search and lyric URLs', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 42 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await provider.fetch(makeQuery())

    const searchUrl = new URL(fetchFn.calls[0]!)
    expect(searchUrl.pathname).toBe('/api/search/get/web')
    expect(searchUrl.searchParams.get('s')).toBe('Test Artist Test Song')
    expect(searchUrl.searchParams.get('type')).toBe('1')
    expect(searchUrl.searchParams.get('offset')).toBe('0')
    expect(searchUrl.searchParams.get('limit')).toBe('10')

    const lyricUrl = new URL(fetchFn.calls[1]!)
    expect(lyricUrl.pathname).toBe('/api/song/lyric')
    expect(lyricUrl.searchParams.get('id')).toBe('42')
    expect(lyricUrl.searchParams.get('lv')).toBe('1')
    expect(lyricUrl.searchParams.get('tv')).toBe('1')
    expect(lyricUrl.searchParams.get('rv')).toBe('1')
  })

  it('returns null when the search yields nothing', async () => {
    const fetchFn = makeFetch(() => jsonResponse(searchBody([])))
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    expect(await provider.fetch(makeQuery())).toBeNull()
  })

  it('skips songs whose duration deviates far from the query', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 1, ms: 600_000 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    expect(await provider.fetch(makeQuery({ durationSec: 240 }))).toBeNull()
    // No lyric request for an implausible song.
    expect(fetchFn.calls.filter((url) => url.includes('/api/song/lyric'))).toHaveLength(0)
  })

  it('rejects a wrong-song candidate through the router confidence gate', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(
            searchBody([
              {
                id: 1,
                name: 'Completely Different',
                artist: 'Other Band',
                album: 'Other Album',
                ms: 215_000
              }
            ])
          )
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    expect(await provider.fetch(makeQuery())).toBeNull()
  })

  it('ignores a song whose lyric payload has no timestamps', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 1 }]))
        : jsonResponse(lyricBody({ lrc: 'plain only' }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    expect(await provider.fetch(makeQuery())).toBeNull()
  })

  it('throws a typed NETWORK ProviderError on a transport failure', async () => {
    const fetchFn = makeFetch(() => {
      throw new Error('fetch failed')
    })
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await expect(provider.fetch(makeQuery())).rejects.toBeInstanceOf(ProviderError)
    await expect(provider.fetch(makeQuery())).rejects.toMatchObject({ kind: 'NETWORK' })
  })

  it('retries then throws RATE_LIMITED on repeated 429s', async () => {
    const fetchFn = makeFetch(() => jsonResponse({}, 429))
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await expect(provider.fetch(makeQuery())).rejects.toMatchObject({ kind: 'RATE_LIMITED' })
    // attempt 0 + MAX_RETRIES (2) = 3 requests
    expect(fetchFn.calls).toHaveLength(3)
  })

  it('honors Retry-After on 503 and then succeeds', async () => {
    let calls = 0
    const slept: number[] = []
    const fetchFn = makeFetch((url) => {
      calls += 1
      if (calls === 1) return jsonResponse({}, 503, { 'Retry-After': '2' })
      return url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 9 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    })
    const provider = new NeteaseProvider({
      fetchFn,
      sleepFn: async (ms) => {
        slept.push(ms)
      },
      pacingMs: 0
    })
    const candidate = await provider.fetch(makeQuery())
    expect(candidate).not.toBeNull()
    expect(slept).toContain(2000)
  })

  it('aborts with a typed ABORTED ProviderError', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = makeFetch(() => jsonResponse(searchBody([])))
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await expect(provider.fetch(makeQuery(), controller.signal)).rejects.toMatchObject({
      kind: 'ABORTED'
    })
    expect(fetchFn.calls).toHaveLength(0)
  })

  it('records pacing in finally so requests stay >= pacingMs apart', async () => {
    let now = 0
    const startedAt: number[] = []
    const slept: number[] = []
    const fetchFn = makeFetch((url) => {
      startedAt.push(now)
      // Simulate a request that takes 100ms.
      now += 100
      return url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 1 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    })
    const provider = new NeteaseProvider({
      fetchFn,
      sleepFn: async (ms) => {
        slept.push(ms)
        now += ms
      },
      nowFn: () => now,
      pacingMs: 500
    })
    await provider.fetch(makeQuery())

    // `lastRequestTime` is recorded when the request finishes (100ms in), so the
    // provider waits a further full pacing interval before starting the next one.
    expect(startedAt).toHaveLength(2)
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(500)
    expect(slept).toHaveLength(1)
    expect(slept[0]!).toBeGreaterThanOrEqual(400)
  })

  it('serializes concurrent fetches at concurrency = 1', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchFn = makeFetch(async (url) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 1 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    })
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await Promise.all([provider.fetch(makeQuery()), provider.fetch(makeQuery())])
    expect(maxInFlight).toBe(1)
  })
})

describe('NeteaseProvider.searchAllCandidates', () => {
  it('lists candidates with multi-layer fields and scores', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 11 }, { id: 12, name: 'Other Song' }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY, tlyric: TRANSLATION, romalrc: ROMANIZATION }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    const results = await provider.searchAllCandidates(makeSearchQuery())

    expect(results.length).toBeGreaterThan(0)
    const first = results[0]!
    expect(first.providerId).toBe('netease')
    expect(first.syncedLyrics).toBe(PRIMARY)
    expect(first.translatedLyrics).toBe(TRANSLATION)
    expect(first.romanizedLyrics).toBe(ROMANIZATION)
    expect(first.sourceId).toBeDefined()
    expect(first.timingKind).toBe('line')
  })

  it('caps lyric fetches at the top 5 metadata-scored songs', async () => {
    const songs = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: `Test Song ${index + 1}`
    }))
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody(songs))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await provider.searchAllCandidates(makeSearchQuery())
    const lyricCalls = fetchFn.calls.filter((url) => url.includes('/api/song/lyric'))
    expect(lyricCalls).toHaveLength(5)
  })

  it('deduplicates identical lyric payloads', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 1 }, { id: 2 }, { id: 3 }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    const results = await provider.searchAllCandidates(makeSearchQuery())
    expect(results).toHaveLength(1)
  })

  it('keeps partial results when a later lyric fetch fails', async () => {
    let lyricCalls = 0
    const fetchFn = makeFetch((url) => {
      if (url.includes('/api/search/')) {
        return jsonResponse(searchBody([{ id: 1 }, { id: 2 }]))
      }
      lyricCalls += 1
      if (lyricCalls === 2) throw new Error('network down')
      return jsonResponse(lyricBody({ lrc: PRIMARY }))
    })
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    const results = await provider.searchAllCandidates(makeSearchQuery())
    expect(results).toHaveLength(1)
  })

  it('throws when every lyric fetch fails', async () => {
    const fetchFn = makeFetch((url) => {
      if (url.includes('/api/search/')) return jsonResponse(searchBody([{ id: 1 }]))
      throw new Error('network down')
    })
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await expect(provider.searchAllCandidates(makeSearchQuery())).rejects.toMatchObject({
      kind: 'NETWORK'
    })
  })

  it('applies the sifter search overrides to the keyword', async () => {
    const fetchFn = makeFetch((url) =>
      url.includes('/api/search/')
        ? jsonResponse(searchBody([{ id: 1, name: 'Override', artist: 'Override Artist' }]))
        : jsonResponse(lyricBody({ lrc: PRIMARY }))
    )
    const provider = new NeteaseProvider({ fetchFn, sleepFn: noSleep, pacingMs: 0 })
    await provider.searchAllCandidates(
      makeSearchQuery({ searchTitle: 'Override', searchArtist: 'Override Artist' })
    )
    const keyword = new URL(fetchFn.calls[0]!).searchParams.get('s')
    expect(keyword).toBe('Override Artist Override')
  })
})
