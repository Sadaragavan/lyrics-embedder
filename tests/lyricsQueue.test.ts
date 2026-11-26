import { describe, it, expect, vi } from 'vitest'
import { LyricsFetchQueue } from '../src/main/providers/queue'
import type { LyricsCandidate, LyricsProvider, LyricsQuery } from '../src/shared/types'

function makeQuery(trackId: string, overrides: Partial<LyricsQuery> = {}): LyricsQuery {
  return {
    trackId,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    durationSec: 200,
    filePath: `/music/${trackId}.flac`,
    ...overrides
  }
}

function makeProvider(
  id: 'lrclib' | 'localSidecar',
  fetchImpl: (query: LyricsQuery, signal?: AbortSignal) => Promise<LyricsCandidate | null>
): LyricsProvider {
  return {
    id,
    displayName: id,
    fetch: fetchImpl
  }
}

function makeCandidate(
  providerId: 'lrclib' | 'localSidecar',
  score: number,
  syncedLyrics: string | null = null
): LyricsCandidate {
  return {
    providerId,
    syncedLyrics,
    plainLyrics: syncedLyrics ? null : 'plain',
    score
  }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('LyricsFetchQueue', () => {
  it('fetches from providers sequentially', async () => {
    const provider = makeProvider('localSidecar', async () =>
      makeCandidate('localSidecar', 10, '[00:01.00]Hello')
    )
    const queue = new LyricsFetchQueue({ providers: [provider] })

    const result = await queue.fetch(makeQuery('a'.repeat(32)))
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBe('[00:01.00]Hello')
  })

  it('picks the best score across providers when localSidecar returns plain only', async () => {
    const low = makeProvider('localSidecar', async () => makeCandidate('localSidecar', 6))
    const high = makeProvider('lrclib', async () =>
      makeCandidate('lrclib', 15, '[00:01.00]Best')
    )
    const queue = new LyricsFetchQueue({ providers: [low, high] })

    const result = await queue.fetch(makeQuery('b'.repeat(32)))
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('lrclib')
    expect(result!.score).toBe(15)
  })

  it('short-circuits remaining providers when localSidecar finds synced lyrics', async () => {
    const remoteFetch = vi.fn(async () => makeCandidate('lrclib', 15, '[00:01.00]Remote'))
    const local = makeProvider('localSidecar', async () =>
      makeCandidate('localSidecar', 100, '[00:01.00]Local synced')
    )
    const remote = makeProvider('lrclib', remoteFetch)
    const queue = new LyricsFetchQueue({ providers: [local, remote] })

    const result = await queue.fetch(makeQuery('a'.repeat(32)))
    expect(result!.providerId).toBe('localSidecar')
    expect(remoteFetch).not.toHaveBeenCalled()
  })

  it('filters and orders providers when query.providerIds is specified', async () => {
    const calls: string[] = []
    const local = makeProvider('localSidecar', async () => {
      calls.push('localSidecar')
      return makeCandidate('localSidecar', 100, '[00:01.00]Local')
    })
    const remote = makeProvider('lrclib', async () => {
      calls.push('lrclib')
      return makeCandidate('lrclib', 15, '[00:01.00]Remote')
    })
    const queue = new LyricsFetchQueue({ providers: [local, remote] })

    const result = await queue.fetch(
      makeQuery('b'.repeat(32), { providerIds: ['lrclib'] })
    )
    expect(calls).toEqual(['lrclib'])
    expect(result!.providerId).toBe('lrclib')
  })

  it('returns null and emits done when all providers return null without error', async () => {
    const onProgress = vi.fn()
    const provider = makeProvider('lrclib', async () => null)
    const queue = new LyricsFetchQueue({ providers: [provider], onProgress })

    const result = await queue.fetch(makeQuery('c'.repeat(32)))
    expect(result).toBeNull()
    const lastEvent = onProgress.mock.calls.at(-1)?.[0]
    expect(lastEvent?.phase).toBe('done')
  })

  it('emits phase error when selected providers fail without a match', async () => {
    const missLocal = makeProvider('localSidecar', async () => null)
    const failingRemote = makeProvider('lrclib', async () => {
      throw new Error('LRCLIB unavailable (HTTP 503)')
    })
    const onProgress = vi.fn()
    const queue = new LyricsFetchQueue({
      providers: [missLocal, failingRemote],
      onProgress
    })

    const result = await queue.fetch(makeQuery('c'.repeat(32)))
    expect(result).toBeNull()
    const finalEvent = onProgress.mock.calls.at(-1)?.[0]
    expect(finalEvent).toEqual({
      trackId: 'c'.repeat(32),
      phase: 'error',
      error: 'LRCLIB unavailable (HTTP 503)',
      errorKind: 'RATE_LIMITED'
    })
  })

  it('handles provider errors gracefully and continues to fallback', async () => {
    const failing = makeProvider('lrclib', async () => {
      throw new Error('Network down')
    })
    const fallback = makeProvider('localSidecar', async () =>
      makeCandidate('localSidecar', 8, '[00:01.00]Fallback')
    )
    const onProgress = vi.fn()
    const queue = new LyricsFetchQueue({ providers: [failing, fallback], onProgress })

    const result = await queue.fetch(makeQuery('d'.repeat(32)))
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('localSidecar')
    const errorEvent = onProgress.mock.calls.find(([p]) => p.error !== undefined)
    expect(errorEvent).toBeDefined()
    expect(onProgress.mock.calls.at(-1)?.[0]?.phase).toBe('done')
  })

  it('cancels an in-flight fetch immediately via AbortSignal', async () => {
    const gate = deferred()
    const slow = makeProvider('lrclib', (_query, signal) => {
      gate.resolve()
      return new Promise<LyricsCandidate | null>((resolve) => {
        signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    })
    const onProgress = vi.fn()
    const queue = new LyricsFetchQueue({ providers: [slow], onProgress })

    const trackId = 'e'.repeat(32)
    const fetchPromise = queue.fetch(makeQuery(trackId))
    await gate.promise
    queue.cancel(trackId)

    const result = await fetchPromise
    expect(result).toBeNull()
    const cancelledEvent = onProgress.mock.calls.find(([p]) => p.phase === 'cancelled')
    expect(cancelledEvent).toBeDefined()
  })

  it('allows re-fetching a trackId after a previous cancel', async () => {
    let attempt = 0
    const provider = makeProvider('lrclib', async () => {
      attempt++
      return makeCandidate('lrclib', 10, `[00:01.00]Attempt ${attempt}`)
    })
    const gate = deferred()
    const blockingProvider = makeProvider('localSidecar', async () => {
      await gate.promise
      return null
    })
    const queue = new LyricsFetchQueue({ providers: [blockingProvider, provider] })

    const id1 = '1'.repeat(32)
    const id2 = '2'.repeat(32)
    const p1 = queue.fetch(makeQuery(id1))
    const p2 = queue.fetch(makeQuery(id2))

    queue.cancel(id2)
    expect(await p2).toBeNull()

    gate.resolve()
    await p1
    const refetched = await queue.fetch(makeQuery(id2))
    expect(refetched).not.toBeNull()
    expect(refetched!.syncedLyrics).toContain('Attempt')
  })

  it('processes batch queries sequentially', async () => {
    const callOrder: string[] = []
    const provider = makeProvider('lrclib', async (query) => {
      callOrder.push(query.trackId)
      return makeCandidate('lrclib', 10)
    })
    const queue = new LyricsFetchQueue({ providers: [provider] })

    const id1 = 'f'.repeat(32)
    const id2 = '0'.repeat(32)
    const results = await queue.fetchBatch([makeQuery(id1), makeQuery(id2)])
    expect(results).toHaveLength(2)
    expect(callOrder).toEqual([id1, id2])
  })

  it('emits progress events', async () => {
    const provider = makeProvider('localSidecar', async () =>
      makeCandidate('localSidecar', 8)
    )
    const onProgress = vi.fn()
    const queue = new LyricsFetchQueue({ providers: [provider], onProgress })

    await queue.fetch(makeQuery('a'.repeat(32)))
    expect(onProgress).toHaveBeenCalled()
    const phases = onProgress.mock.calls.map(([p]) => p.phase)
    expect(phases).toContain('fetching')
    expect(phases).toContain('done')
  })

  it('rejects after dispose', async () => {
    const provider = makeProvider('lrclib', async () => null)
    const queue = new LyricsFetchQueue({ providers: [provider] })
    queue.dispose()

    await expect(queue.fetch(makeQuery('a'.repeat(32)))).rejects.toThrow('disposed')
  })

  it('reports pendingCount', async () => {
    const d1 = deferred()
    const d2 = deferred()
    let callIdx = 0
    const provider = makeProvider('lrclib', async () => {
      callIdx++
      if (callIdx === 1) await d1.promise
      else await d2.promise
      return null
    })
    const queue = new LyricsFetchQueue({ providers: [provider] })

    const p1 = queue.fetch(makeQuery('a'.repeat(32)))
    const p2 = queue.fetch(makeQuery('b'.repeat(32)))
    expect(queue.pendingCount).toBe(1)

    d1.resolve()
    await p1

    d2.resolve()
    await p2
    expect(queue.pendingCount).toBe(0)
  })

  it('populates timingKind on the returned candidate', async () => {
    const provider = makeProvider('lrclib', async () =>
      makeCandidate('lrclib', 50, '[00:01.00]Hello')
    )
    const queue = new LyricsFetchQueue({ providers: [provider] })

    const result = await queue.fetch(makeQuery('a'.repeat(32)))
    expect(result!.timingKind).toBe('line')
  })

  it('discards candidates with no usable lyrics', async () => {
    const onProgress = vi.fn()
    const provider = makeProvider('lrclib', async () => ({
      providerId: 'lrclib' as const,
      syncedLyrics: null,
      plainLyrics: null,
      score: 50,
      timingKind: 'none' as const
    }))
    const queue = new LyricsFetchQueue({ providers: [provider], onProgress })

    const result = await queue.fetch(makeQuery('a'.repeat(32)))
    expect(result).toBeNull()
    expect(onProgress.mock.calls.at(-1)?.[0]?.phase).toBe('done')
  })

  it('retains line-synced remote fallback and continues searching for word-synced', async () => {
    const lineFetch = vi.fn(async () => makeCandidate('lrclib', 60, '[00:01.00]Line'))
    const wordFetch = vi.fn(async () =>
      makeCandidate('localSidecar', 70, '[00:01.00]<00:01.00>W<00:01.50>ord')
    )
    const queue = new LyricsFetchQueue({
      providers: [
        makeProvider('lrclib', lineFetch),
        makeProvider('localSidecar', wordFetch)
      ],
      preferWordSynced: true
    })

    const result = await queue.fetch(makeQuery('a'.repeat(32)))
    expect(lineFetch).toHaveBeenCalledOnce()
    expect(wordFetch).toHaveBeenCalledOnce()
    expect(result!.timingKind).toBe('word')
    expect(result!.syncedLyrics).toContain('<00:01.50>')
  })

  it('breaks on a local sidecar synced match (ACCEPT_FINAL)', async () => {
    const remoteFetch = vi.fn(async () => makeCandidate('lrclib', 90, '[00:01.00]Remote'))
    const queue = new LyricsFetchQueue({
      providers: [
        makeProvider('localSidecar', async () =>
          makeCandidate('localSidecar', 100, '[00:01.00]Local')
        ),
        makeProvider('lrclib', remoteFetch)
      ],
      preferWordSynced: true
    })

    const result = await queue.fetch(makeQuery('a'.repeat(32)))
    expect(result!.providerId).toBe('localSidecar')
    expect(remoteFetch).not.toHaveBeenCalled()
  })

  it('emits errorKind for a typed network failure', async () => {
    const onProgress = vi.fn()
    const queue = new LyricsFetchQueue({
      providers: [
        makeProvider('lrclib', async () => {
          throw Object.assign(new Error('Network down'), { kind: 'NETWORK' })
        })
      ],
      onProgress
    })

    await queue.fetch(makeQuery('a'.repeat(32)))
    const finalEvent = onProgress.mock.calls.at(-1)?.[0]
    expect(finalEvent).toMatchObject({ phase: 'error', errorKind: 'NETWORK' })
  })
})
