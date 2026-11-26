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

/** One-shot imperative command from the native menu to the audio player. */
export type PlayerCommandKind = 'toggle' | 'stop'

export interface PlayerCommand {
  kind: PlayerCommandKind
  nonce: number
}
