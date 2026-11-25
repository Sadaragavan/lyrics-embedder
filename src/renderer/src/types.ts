import type { LyricsSource } from '@shared/types'

export type TrackEmbedPhase = 'idle' | 'embedding' | 'verified' | 'error'

export interface TrackEmbedStatus {
  phase: TrackEmbedPhase
  targetPath?: string
  lyricsSource?: Exclude<LyricsSource, 'none'>
  error?: string
}

export interface SeekRequest {
  trackId: string
  timeMs: number
  nonce: number
}
