import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type AddLibraryRootRequest,
  type ElectronApi,
  type EmbedLyricsRequest,
  type LyricsFetchProgress,
  type LyricsFetchRequest,
  type LyricsSearchRequest,
  type MediaUnloadAck,
  type MediaUnloadRequest,
  type SaveDraftRequest,
  type ScanLibraryRequest
} from '@shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: ElectronApi = {
  getHealth: () => ipcRenderer.invoke(IPC_CHANNELS.getHealth),
  selectAudioFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectAudioFile),
  selectLibraryFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectLibraryFolder),
  selectLrcFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectLrcFile),
  readTrackMetadata: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.readTrackMetadata, filePath),
  embedLyrics: (request: EmbedLyricsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.embedLyrics, request),
  getRoots: () => ipcRenderer.invoke(IPC_CHANNELS.getRoots),
  addRoot: (request: AddLibraryRootRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.addRoot, request),
  removeRoot: (rootId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeRoot, rootId),
  scanLibrary: (request?: ScanLibraryRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.scanLibrary, request),
  getTracks: () => ipcRenderer.invoke(IPC_CHANNELS.getTracks),
  getTrack: (trackId: string) => ipcRenderer.invoke(IPC_CHANNELS.getTrack, trackId),
  saveDraft: (request: SaveDraftRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveDraft, request),
  getDraft: (trackId: string) => ipcRenderer.invoke(IPC_CHANNELS.getDraft, trackId),
  deleteDraft: (trackId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteDraft, trackId),
  getMediaUrl: (trackId: string) => ipcRenderer.invoke(IPC_CHANNELS.getMediaUrl, trackId),
  lyricsFetch: (query: LyricsFetchRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsFetch, query),
  lyricsFetchBatch: (queries: LyricsFetchRequest[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsFetchBatch, queries),
  lyricsCancelFetch: (trackId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsCancelFetch, trackId),
  lyricsImportFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsImportFile, filePath),
  searchLyricsCandidates: (request: LyricsSearchRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.lyricsSearchCandidates, request),
  onScanProgress: (listener) => subscribe(IPC_CHANNELS.scanProgress, listener),
  onScanComplete: (listener) => subscribe(IPC_CHANNELS.scanComplete, listener),
  onUnloadAudio: (listener) => {
    const handler = (_event: IpcRendererEvent, request: MediaUnloadRequest): void => {
      try {
        listener(request)
      } finally {
        const ack: MediaUnloadAck = {
          requestId: request.requestId,
          acknowledgedAt: new Date().toISOString()
        }
        ipcRenderer.send(IPC_CHANNELS.acknowledgeUnload, ack)
      }
    }
    ipcRenderer.on(IPC_CHANNELS.unloadAudio, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.unloadAudio, handler)
    }
  },
  onLyricsFetchProgress: (listener) =>
    subscribe<LyricsFetchProgress>(IPC_CHANNELS.lyricsFetchProgress, listener)
}

contextBridge.exposeInMainWorld('api', api)
