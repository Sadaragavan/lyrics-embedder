/**
 * Core domain types shared by the main process, preload, renderer, and tests.
 * This module must stay free of Node-only and DOM-only imports.
 */

export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.flac',
  '.opus',
  '.m4a',
  '.mp3',
  '.wav'
] as const

export type SupportedAudioExtension = (typeof SUPPORTED_AUDIO_EXTENSIONS)[number]

export type LyricsSource = 'tag' | 'sidecar' | 'none'

export interface LibraryRoot {
  id: string
  path: string
  name: string
  addedAt: string
  lastScannedAt?: string
}

export interface TrackRecord {
  /** Deterministic SHA-256 hex prefix of the normalized file path. */
  id: string
  filePath: string
  format: string
  title: string
  artist: string
  album: string
  durationSec: number
  lyrics: string | null
  lyricsSource: LyricsSource
  existingLyricsKeys: string[]
  libraryRootId: string
  mtimeMs: number
  draftId?: string
}

export type DraftStatus = 'pending' | 'synced' | 'conflict'

export interface LyricDraft {
  id: string
  trackId: string
  lyrics: string
  updatedAt: string
  status: DraftStatus
}

export interface LibraryIndex {
  roots: LibraryRoot[]
  tracks: TrackRecord[]
}

export type ScanPhase = 'idle' | 'scanning' | 'complete' | 'error'

export interface ScanProgress {
  phase: ScanPhase
  processed: number
  total: number
  currentPath?: string
  error?: string
  errors?: number
}

export interface MediaUrl {
  trackId: string
  url: string
}

export interface MediaUnloadRequest {
  requestId: string
  filePath: string
}

export interface MediaUnloadAck {
  requestId: string
  acknowledgedAt: string
}

// --- Phase 3: Provider / Lyrics Fetch types ---

export type LyricsProviderId = 'lrclib' | 'localSidecar'

export interface LyricsQuery {
  trackId: string
  title: string
  artist: string
  album: string
  durationSec: number
  filePath: string
  providerIds?: LyricsProviderId[]
}

export interface LyricsCandidate {
  providerId: LyricsProviderId
  syncedLyrics: string | null
  plainLyrics: string | null
  score: number
}

export interface LyricsProvider {
  id: LyricsProviderId
  displayName: string
  fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsCandidate | null>
}

export type LyricsFetchPhase = 'idle' | 'fetching' | 'done' | 'error' | 'cancelled'

export interface LyricsFetchProgress {
  trackId: string
  phase: LyricsFetchPhase
  providerId?: LyricsProviderId
  candidate?: LyricsCandidate
  error?: string
}
