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
  /** Optional translation layer persisted alongside the primary lyrics. */
  translation?: string
  /** Optional romanization layer persisted alongside the primary lyrics. */
  romanization?: string
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

/** Granularity of a candidate's timing data, derived from its lyric payload. */
export type LyricsTimingKind = 'word' | 'line' | 'plain' | 'instrumental' | 'none'

/** Why the router accepted, deferred, or rejected a candidate. */
export type SelectionDecision = 'ACCEPT_FINAL' | 'CONTINUE' | 'KEEP_AS_FALLBACK' | 'REJECT'

/** Normalized provider failure categories surfaced through fetch progress. */
export type ProviderErrorKind =
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN'

export interface LyricsCandidate {
  providerId: LyricsProviderId
  syncedLyrics: string | null
  plainLyrics: string | null
  score: number
  /** Timing granularity; populated by providers via `detectLyricsTimingKind`. */
  timingKind?: LyricsTimingKind
}

/** Router verdict for a single candidate, with an auditable reason. */
export interface CandidateEvaluation {
  timingKind: LyricsTimingKind
  score: number
  decision: SelectionDecision
  reason: string
  durationDeltaSec?: number
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
  /** Timing granularity of this candidate (`word`/`line`/`plain`/...). */
  timingKind?: LyricsTimingKind
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

// --- Phase 5: Native menu + dynamic workspace ---

/** Every actionable command a native menu item can dispatch to the renderer. */
export const MENU_ACTIONS = [
  'add-library-folder',
  'scan-all-roots',
  'import-lrc',
  'discard-draft',
  'embed-current-track',
  'normalize-lrc',
  'toggle-preserve-word-tags',
  'send-primary-to-translation',
  'send-primary-to-romanization',
  'toggle-sidebar',
  'mode-edit',
  'mode-layers',
  'mode-find',
  'layout-raw',
  'layout-live',
  'toggle-play-pause',
  'stop-and-unload',
  'show-tag-engine-status'
] as const

export type MenuAction = (typeof MENU_ACTIONS)[number]

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && (MENU_ACTIONS as readonly string[]).includes(value)
}

/** Right-workspace mode selected from the View menu or the in-app mode bar. */
export type WorkspaceMode = 'edit' | 'layers' | 'find'

/**
 * Edit-mode layout selected from the View > Editor Layout submenu.
 * `live` is the unified editable synced view; `raw` is plain monospace LRC text.
 */
export type EditorLayout = 'live' | 'raw'

/**
 * Renderer-owned menu state. The main process rebuilds the native menu from
 * this snapshot so checkboxes, radios, and enabled flags stay in sync.
 */
export interface MenuSyncState {
  hasFocusedTrack: boolean
  hasDraft: boolean
  isDirty: boolean
  hasLyrics: boolean
  workerReady: boolean
  preserveWordTags: boolean
  sidebarVisible: boolean
  mode: WorkspaceMode
  editorLayout: EditorLayout
  isPlaying: boolean
  canPlay: boolean
  canStop: boolean
  selectedCount: number
  embedding: boolean
}

export interface LyricsFetchProgress {
  trackId: string
  phase: LyricsFetchPhase
  providerId?: LyricsProviderId
  candidate?: LyricsCandidate
  error?: string
  /** Normalized failure category when `phase === 'error'`. */
  errorKind?: ProviderErrorKind
}
