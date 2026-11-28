export { type TrackEmbedStatus } from '@shared/ipc'

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
