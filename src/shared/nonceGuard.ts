/**
 * One-shot nonce guard used by the audio player.
 *
 * Seek requests and native playback commands are delivered as immutable objects
 * that carry a `nonce`. An effect keyed on the request object re-runs whenever
 * any dependency identity changes (for example `focusedTrack` is replaced by a
 * fresh `TrackRecord` after an embed). Without a guard the *same* request would
 * be applied again, replaying an old seek and yanking playback backwards.
 *
 * This guard guarantees each nonce is handled at most once. It is DOM-free so it
 * can be unit tested directly.
 */
export interface NonceGuard {
  /** Returns true the first time a nonce is seen, false on every replay. */
  shouldHandle(nonce: number): boolean
  /** The most recently handled nonce, or null when nothing has been handled. */
  readonly lastHandled: number | null
  /** Forget the last nonce (used when audio is unloaded and nonces restart). */
  reset(): void
}

export function createNonceGuard(): NonceGuard {
  let lastHandled: number | null = null
  return {
    shouldHandle(nonce: number): boolean {
      if (Object.is(lastHandled, nonce)) return false
      lastHandled = nonce
      return true
    },
    get lastHandled(): number | null {
      return lastHandled
    },
    reset(): void {
      lastHandled = null
    }
  }
}