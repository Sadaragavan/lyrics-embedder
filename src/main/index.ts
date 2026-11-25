import fs from 'node:fs/promises'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import {
  IPC_CHANNELS,
  SUPPORTED_AUDIO_EXTENSIONS,
  type EmbedLyricsRequest,
  type EmbedLyricsResult,
  type TagEngineHealth,
  type TrackMetadata,
  type WorkerPayload,
  type WorkerRequest,
  type WorkerResponse
} from '@shared/ipc'
import audioWorkerModulePath from './audioWorker?modulePath'
import { isSupportedAudioPath } from './tagger'
import { resolveTaglibWasmPath } from './wasmPath'

const MAX_LYRICS_BYTES = 1024 * 1024

interface PendingRequest {
  resolve: (value: WorkerResponse) => void
  reject: (reason: Error) => void
}

let mainWindow: BrowserWindow | null = null
let worker: UtilityProcess | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
let latestHealth: TagEngineHealth = {
  ready: false,
  taglibVersion: null,
  wasmPath: null,
  workerPid: null,
  error: 'Worker not started'
}

function rejectAllPending(reason: string): void {
  const err = new Error(reason)
  for (const [, pending] of pendingRequests) {
    pending.reject(err)
  }
  pendingRequests.clear()
}

function sendWorkerRequest<T>(payload: WorkerPayload): Promise<T> {
  if (!worker) {
    return Promise.reject(new Error('Audio worker is not running'))
  }
  const id = nextRequestId++
  const request: WorkerRequest = { id, ...payload }

  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (response) => {
        if (response.ok) {
          resolve(response.result as T)
        } else {
          reject(new Error(response.error))
        }
      },
      reject
    })
    worker?.postMessage(request)
  })
}

async function startAudioWorker(): Promise<void> {
  const wasmUrl = resolveTaglibWasmPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  })

  const child = utilityProcess.fork(audioWorkerModulePath, [], {
    stdio: 'pipe'
  })
  worker = child

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd()
    if (text) console.log(`[audioWorker] ${text}`)
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd()
    if (text) console.error(`[audioWorker] ${text}`)
  })

  child.on('message', (message: WorkerResponse) => {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    pending.resolve(message)
  })

  child.on('error', (type, location, report) => {
    const msg = `audioWorker fatal ${type} at ${location}: ${report}`
    console.error(`[audioWorker] ${msg}`)
    latestHealth = {
      ...latestHealth,
      ready: false,
      error: msg
    }
    rejectAllPending(msg)
  })

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[audioWorker] exited with non-zero code ${code}`)
    }
    if (worker === child) {
      worker = null
    }
    latestHealth = {
      ...latestHealth,
      ready: false,
      workerPid: null,
      error: code === 0 ? 'Worker stopped' : `Worker exited with code ${code}`
    }
    rejectAllPending(`Audio worker exited with code ${code}`)
  })

  try {
    latestHealth = await sendWorkerRequest<TagEngineHealth>({
      type: 'init',
      wasmUrl
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    latestHealth = {
      ready: false,
      taglibVersion: null,
      wasmPath: wasmUrl,
      workerPid: child.pid ?? null,
      error: message
    }
    console.error(`[audioWorker] initialization failed: ${message}`)
  }
}

async function validateAudioFilePath(rawPath: unknown): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw new Error('Invalid file path')
  }
  const normalized = path.resolve(rawPath)
  if (!path.isAbsolute(normalized) || !isSupportedAudioPath(normalized)) {
    throw new Error(`Unsupported audio path: ${rawPath}`)
  }
  const stat = await fs.stat(normalized)
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${normalized}`)
  }
  return normalized
}

function validateEmbedPayload(payload: unknown): EmbedLyricsRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid embed request payload')
  }
  const candidate = payload as Record<string, unknown>
  if (typeof candidate.filePath !== 'string' || typeof candidate.lyrics !== 'string') {
    throw new Error('Embed request must include string filePath and lyrics')
  }
  if (Buffer.byteLength(candidate.lyrics, 'utf8') > MAX_LYRICS_BYTES) {
    throw new Error('Lyrics payload exceeds 1 MiB limit')
  }
  return {
    filePath: candidate.filePath,
    lyrics: candidate.lyrics
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getHealth, async (): Promise<TagEngineHealth> => {
    if (!worker) return latestHealth
    try {
      latestHealth = await sendWorkerRequest<TagEngineHealth>({ type: 'health' })
      return latestHealth
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...latestHealth,
        ready: false,
        error: message
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.selectAudioFile, async (): Promise<string | null> => {
    const filterExtensions = SUPPORTED_AUDIO_EXTENSIONS.map((ext) => ext.slice(1))
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Select Audio File',
      properties: ['openFile'],
      filters: [{ name: 'Supported Audio', extensions: filterExtensions }]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(
    IPC_CHANNELS.readTrackMetadata,
    async (_event, rawFilePath: unknown): Promise<TrackMetadata> => {
      const filePath = await validateAudioFilePath(rawFilePath)
      return sendWorkerRequest<TrackMetadata>({
        type: 'readTrackMetadata',
        filePath
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.embedLyrics,
    async (_event, rawPayload: unknown): Promise<EmbedLyricsResult> => {
      const validated = validateEmbedPayload(rawPayload)
      const filePath = await validateAudioFilePath(validated.filePath)
      return sendWorkerRequest<EmbedLyricsResult>({
        type: 'embedLyrics',
        filePath,
        lyrics: validated.lyrics
      })
    }
  )
}

async function createMainWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 840,
    minHeight: 560,
    backgroundColor: '#09090b',
    title: 'Poweramp LRC Embedder',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  mainWindow = win

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  registerIpcHandlers()
  await startAudioWorker()

  if (process.argv.includes('--smoke-test')) {
    console.log(JSON.stringify(latestHealth))
    app.exit(latestHealth.ready ? 0 : 1)
    return
  }

  await createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (worker) {
    worker.kill()
    worker = null
  }
})
