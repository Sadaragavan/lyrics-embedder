import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type ElectronApi,
  type EmbedLyricsRequest
} from '@shared/ipc'

const api: ElectronApi = {
  getHealth: () => ipcRenderer.invoke(IPC_CHANNELS.getHealth),
  selectAudioFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectAudioFile),
  readTrackMetadata: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.readTrackMetadata, filePath),
  embedLyrics: (request: EmbedLyricsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.embedLyrics, request)
}

contextBridge.exposeInMainWorld('api', api)
