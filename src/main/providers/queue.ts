/**
 * Cancellable sequential lyrics fetch queue.
 *
 * Runs allowed providers in order for each track, emitting progress events.
 * Supports batch fetching, per-request provider filtering, short-circuiting
 * on local synced sidecar matches, error phase reporting, and immediate
 * cancellation of pending or in-flight requests.
 */

import type {
  LyricsCandidate,
  LyricsFetchPhase,
  LyricsFetchProgress,
  LyricsProvider,
  LyricsProviderId,
  LyricsQuery
} from '@shared/types'

export type ProgressListener = (progress: LyricsFetchProgress) => void

export interface LyricsFetchQueueOptions {
  providers: LyricsProvider[]
  onProgress?: ProgressListener
}

interface QueueEntry {
  query: LyricsQuery
  resolve: (result: LyricsCandidate | null) => void
  reject: (error: Error) => void
  cancelled: boolean
  controller: AbortController
}

export class LyricsFetchQueue {
  private readonly providers: LyricsProvider[]
  private readonly providerMap: Map<LyricsProviderId, LyricsProvider>
  private readonly onProgress: ProgressListener | undefined
  private readonly queue: QueueEntry[] = []
  private activeEntry: QueueEntry | null = null
  private processing = false
  private disposed = false

  constructor(options: LyricsFetchQueueOptions) {
    this.providers = [...options.providers]
    this.providerMap = new Map(this.providers.map((provider) => [provider.id, provider]))
    this.onProgress = options.onProgress
  }

  private emitProgress(
    trackId: string,
    phase: LyricsFetchPhase,
    extra?: Partial<LyricsFetchProgress>
  ): void {
    this.onProgress?.({ trackId, phase, ...extra })
  }

  /**
   * Enqueues a single track for lyrics fetching.
   * Returns the best candidate found, or null if none matched, failed, or cancelled.
   */
  fetch(query: LyricsQuery): Promise<LyricsCandidate | null> {
    if (this.disposed) {
      return Promise.reject(new Error('LyricsFetchQueue is disposed'))
    }
    return new Promise<LyricsCandidate | null>((resolve, reject) => {
      this.queue.push({
        query,
        resolve,
        reject,
        cancelled: false,
        controller: new AbortController()
      })
      void this.processQueue()
    })
  }

  /**
   * Enqueues multiple tracks for sequential fetching.
   * Returns results in the same order as the input queries.
   */
  async fetchBatch(queries: LyricsQuery[]): Promise<(LyricsCandidate | null)[]> {
    const promises = queries.map((query) => this.fetch(query))
    return Promise.all(promises)
  }

  /**
   * Cancels any pending or in-flight fetch matching `trackId`.
   */
  cancel(trackId: string): void {
    if (this.activeEntry && this.activeEntry.query.trackId === trackId) {
      this.activeEntry.cancelled = true
      this.activeEntry.controller.abort()
    }

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i]!
      if (entry.query.trackId === trackId) {
        this.queue.splice(i, 1)
        entry.cancelled = true
        entry.controller.abort()
        this.emitProgress(trackId, 'cancelled')
        entry.resolve(null)
      }
    }
  }

  /**
   * Cancels all pending and in-flight fetches and rejects new enqueues.
   */
  dispose(): void {
    this.disposed = true
    if (this.activeEntry) {
      this.activeEntry.cancelled = true
      this.activeEntry.controller.abort()
    }
    for (const entry of this.queue) {
      entry.cancelled = true
      entry.controller.abort()
      this.emitProgress(entry.query.trackId, 'cancelled')
      entry.resolve(null)
    }
    this.queue.length = 0
  }

  get pendingCount(): number {
    return this.queue.length
  }

  private resolveProvidersForQuery(query: LyricsQuery): LyricsProvider[] {
    if (!query.providerIds) {
      return this.providers
    }
    const selected: LyricsProvider[] = []
    const seen = new Set<LyricsProviderId>()
    for (const id of query.providerIds) {
      if (seen.has(id)) continue
      const provider = this.providerMap.get(id)
      if (provider) {
        seen.add(id)
        selected.push(provider)
      }
    }
    return selected
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!
        const { query, resolve, controller } = entry

        if (entry.cancelled || this.disposed) {
          this.emitProgress(query.trackId, 'cancelled')
          resolve(null)
          continue
        }

        this.activeEntry = entry
        this.emitProgress(query.trackId, 'fetching')

        const selectedProviders = this.resolveProvidersForQuery(query)
        let best: LyricsCandidate | null = null
        let bestScore = -1
        let lastError: string | undefined

        for (const provider of selectedProviders) {
          if (entry.cancelled || controller.signal.aborted) {
            break
          }

          this.emitProgress(query.trackId, 'fetching', { providerId: provider.id })

          try {
            const candidate = await provider.fetch(query, controller.signal)
            if (entry.cancelled || controller.signal.aborted) {
              break
            }
            if (candidate && candidate.score > bestScore) {
              bestScore = candidate.score
              best = candidate
              this.emitProgress(query.trackId, 'fetching', {
                providerId: provider.id,
                candidate
              })
            }
            // Short-circuit remaining providers when a local synced sidecar is found.
            if (provider.id === 'localSidecar' && candidate?.syncedLyrics) {
              break
            }
          } catch (error) {
            if (entry.cancelled || controller.signal.aborted) {
              break
            }
            const message = error instanceof Error ? error.message : String(error)
            lastError = message
            this.emitProgress(query.trackId, 'fetching', {
              providerId: provider.id,
              error: message
            })
          }
        }

        this.activeEntry = null

        if (entry.cancelled || controller.signal.aborted) {
          this.emitProgress(query.trackId, 'cancelled')
          resolve(null)
          continue
        }

        if (best === null && lastError !== undefined) {
          this.emitProgress(query.trackId, 'error', { error: lastError })
          resolve(null)
          continue
        }

        this.emitProgress(query.trackId, 'done', best ? { candidate: best } : undefined)
        resolve(best)
      }
    } finally {
      this.activeEntry = null
      this.processing = false
    }
  }
}

export function createLyricsFetchQueue(options: LyricsFetchQueueOptions): LyricsFetchQueue {
  return new LyricsFetchQueue(options)
}
