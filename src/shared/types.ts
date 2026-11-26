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

export interface LyricsSearchRequest {
  trackId: string
  title: string
  artist: string
  album: string
  durationSec: number
  filePath: string
  /** Optional interactive-search overrides (never persisted to the track record). */
  searchTitle?: string
  searchArtist?: string
  searchAlbum?: string
}

export interface LyricsSearchResult {
  providerId: LyricsProviderId
  /** Provider-native record id (LRCLIB id) when available; used for dedup. */
  sourceId?: string
  title: string
  artist: string
  album: string
  durationSec: number
  syncedLyrics: string | null
  plainLyrics: string | null
  /** Provider reference for the candidate (API URL) when available. */
  sourceRef?: string
  score: number
}

export interface LyricsProvider {
  id: LyricsProviderId
  displayName: string
  fetch(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsCandidate | null>
  /**
   * Optional interactive candidate listing. Providers that can return more than
   * one match implement this; the sifter skips providers that do not.
   */
  searchAllCandidates?(
    query: LyricsSearchRequest,
    signal?: AbortSignal
  ): Promise<LyricsSearchResult[]>
}

export type LyricsFetchPhase = 'idle' | 'fetching' | 'done' | 'error' | 'cancelled'

export interface LyricsFetchProgress {
  trackId: string
  phase: LyricsFetchPhase
  providerId?: LyricsProviderId
  candidate?: LyricsCandidate
  error?: string
}
