import type {
  DraftStatus,
  LibraryRoot,
  LyricDraft,
  LyricsCandidate,
  LyricsFetchProgress,
  LyricsProviderId,
  LyricsSearchRequest,
  LyricsSearchResult,
  MediaUnloadRequest,
  MediaUrl,
  MenuAction,
  MenuSyncState,
  ScanProgress,
  TrackRecord
} from './types'

export {
  MENU_ACTIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
  isMenuAction,
  type DraftStatus,
  type EditorLayout,
  type MenuAction,
  type MenuSyncState,
  type WorkspaceMode,
  type LibraryIndex,
  type LibraryRoot,
  type LyricDraft,
  type LyricsCandidate,
  type LyricsFetchPhase,
  type LyricsFetchProgress,
  type LyricsProvider,
  type LyricsProviderId,
  type LyricsQuery,
  type LyricsSearchRequest,
  type LyricsSearchResult,
  type LyricsSource,
  type MediaUnloadAck,
  type MediaUnloadRequest,
  type MediaUrl,
  type ScanPhase,
  type ScanProgress,
  type SupportedAudioExtension,
  type TrackRecord
} from './types'

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
  lyricsSource: 'tag' | 'sidecar' | 'none'
  existingLyricsKeys: string[]
}

export interface EmbedLyricsRequest {
  filePath: string
  lyrics: string
}

export interface EmbedLyricsResult {
  filePath: string
  targetPath: string
  lyricsSource: Exclude<TrackMetadata['lyricsSource'], 'none'>
  preservedMtimeMs: number
  verified: boolean
}

export interface AddLibraryRootRequest {
  path: string
  name?: string
}

export interface ScanLibraryRequest {
  rootId?: string
}

export interface ScanLibraryResult {
  rootIds: string[]
  tracks: TrackRecord[]
}

export interface SaveDraftRequest {
  trackId: string
  lyrics: string
  status?: DraftStatus
}

/** Allowed provider IDs for the fetch request (security: allow-list validation). */
export const ALLOWED_PROVIDER_IDS: readonly LyricsProviderId[] = ['lrclib', 'localSidecar']

export interface LyricsFetchRequest {
  trackId: string
  title: string
  artist: string
  album: string
  durationSec: number
  filePath: string
  providerIds?: LyricsProviderId[]
}

export const IPC_CHANNELS = {
  getHealth: 'tagEngine:getHealth',
  selectAudioFile: 'dialog:selectAudioFile',
  selectLibraryFolder: 'dialog:selectLibraryFolder',
  selectLrcFile: 'dialog:selectLrcFile',
  readTrackMetadata: 'track:readMetadata',
  embedLyrics: 'track:embedLyrics',
  getRoots: 'library:getRoots',
  addRoot: 'library:addRoot',
  removeRoot: 'library:removeRoot',
  scanLibrary: 'library:scan',
  scanProgress: 'library:scanProgress',
  scanComplete: 'library:scanComplete',
  getTracks: 'library:getTracks',
  getTrack: 'library:getTrack',
  saveDraft: 'draft:save',
  getDraft: 'draft:get',
  deleteDraft: 'draft:delete',
  getMediaUrl: 'media:getUrl',
  unloadAudio: 'media:unloadAudio',
  acknowledgeUnload: 'media:acknowledgeUnload',
  lyricsFetch: 'lyrics:fetch',
  lyricsFetchBatch: 'lyrics:fetchBatch',
  lyricsCancelFetch: 'lyrics:cancelFetch',
  lyricsFetchProgress: 'lyrics:fetchProgress',
  lyricsImportFile: 'lyrics:importFile',
  lyricsSearchCandidates: 'lyrics:searchCandidates',
  menuAction: 'menu:action',
  menuSyncState: 'menu:syncState'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface ElectronApi {
  getHealth: () => Promise<TagEngineHealth>
  selectAudioFile: () => Promise<string | null>
  selectLibraryFolder: () => Promise<string | null>
  selectLrcFile: () => Promise<string | null>
  readTrackMetadata: (filePath: string) => Promise<TrackMetadata>
  embedLyrics: (request: EmbedLyricsRequest) => Promise<EmbedLyricsResult>
  getRoots: () => Promise<LibraryRoot[]>
  addRoot: (request: AddLibraryRootRequest) => Promise<LibraryRoot>
  removeRoot: (rootId: string) => Promise<boolean>
  scanLibrary: (request?: ScanLibraryRequest) => Promise<ScanLibraryResult>
  getTracks: () => Promise<TrackRecord[]>
  getTrack: (trackId: string) => Promise<TrackRecord | null>
  saveDraft: (request: SaveDraftRequest) => Promise<LyricDraft>
  getDraft: (trackId: string) => Promise<LyricDraft | null>
  deleteDraft: (trackId: string) => Promise<boolean>
  getMediaUrl: (trackId: string) => Promise<MediaUrl>
  lyricsFetch: (query: LyricsFetchRequest) => Promise<LyricsCandidate | null>
  lyricsFetchBatch: (queries: LyricsFetchRequest[]) => Promise<(LyricsCandidate | null)[]>
  lyricsCancelFetch: (trackId: string) => Promise<void>
  lyricsImportFile: (filePath: string) => Promise<string | null>
  searchLyricsCandidates: (request: LyricsSearchRequest) => Promise<LyricsSearchResult[]>
  onScanProgress: (listener: (progress: ScanProgress) => void) => () => void
  onScanComplete: (listener: (result: ScanLibraryResult) => void) => () => void
  onUnloadAudio: (listener: (request: MediaUnloadRequest) => void) => () => void
  onLyricsFetchProgress: (listener: (progress: LyricsFetchProgress) => void) => () => void
  onMenuAction: (listener: (action: MenuAction) => void) => () => void
  syncMenuState: (state: MenuSyncState) => void
}

export type WorkerPayload =
  | { type: 'init'; wasmUrl: string }
  | { type: 'health' }
  | { type: 'readTrackMetadata'; filePath: string }
  | { type: 'embedLyrics'; filePath: string; lyrics: string }
  | { type: 'scanLibrary'; root: LibraryRoot }

export type WorkerRequest = WorkerPayload & { id: number }

export type WorkerResponse =
  | {
      id: number
      ok: true
      result: TagEngineHealth | TrackMetadata | EmbedLyricsResult | TrackRecord[]
    }
  | {
      id: number
      ok: false
      error: string
    }

export interface WorkerProgressMessage {
  type: 'scanProgress'
  id: number
  progress: ScanProgress
}

export type WorkerMessage = WorkerResponse | WorkerProgressMessage

export function isWorkerProgressMessage(message: unknown): message is WorkerProgressMessage {
  if (!message || typeof message !== 'object') return false
  const candidate = message as Record<string, unknown>
  return candidate.type === 'scanProgress' && typeof candidate.id === 'number'
}
