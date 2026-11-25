export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.flac',
  '.opus',
  '.m4a',
  '.mp3',
  '.wav'
] as const

export type SupportedAudioExtension = (typeof SUPPORTED_AUDIO_EXTENSIONS)[number]

export type LyricsSource = 'tag' | 'sidecar' | 'none'

export interface TagEngineHealth {
  ready: boolean
  taglibVersion: string | null
  wasmPath: string | null
  workerPid: number | null
  error: string | null
}

export interface TrackMetadata {
  filePath: string
  format: string
  title: string
  artist: string
  album: string
  durationSec: number
  lyrics: string | null
  lyricsSource: LyricsSource
  existingLyricsKeys: string[]
}

export interface EmbedLyricsRequest {
  filePath: string
  lyrics: string
}

export interface EmbedLyricsResult {
  filePath: string
  targetPath: string
  lyricsSource: Exclude<LyricsSource, 'none'>
  preservedMtimeMs: number
  verified: boolean
}

export const IPC_CHANNELS = {
  getHealth: 'tagEngine:getHealth',
  selectAudioFile: 'dialog:selectAudioFile',
  readTrackMetadata: 'track:readMetadata',
  embedLyrics: 'track:embedLyrics'
} as const

export interface ElectronApi {
  getHealth: () => Promise<TagEngineHealth>
  selectAudioFile: () => Promise<string | null>
  readTrackMetadata: (filePath: string) => Promise<TrackMetadata>
  embedLyrics: (request: EmbedLyricsRequest) => Promise<EmbedLyricsResult>
}

export type WorkerPayload =
  | { type: 'init'; wasmUrl: string }
  | { type: 'health' }
  | { type: 'readTrackMetadata'; filePath: string }
  | { type: 'embedLyrics'; filePath: string; lyrics: string }

export type WorkerRequest = WorkerPayload & { id: number }

export type WorkerResponse =
  | {
      id: number
      ok: true
      result: TagEngineHealth | TrackMetadata | EmbedLyricsResult
    }
  | {
      id: number
      ok: false
      error: string
    }
