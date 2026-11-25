import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import {
  IPC_CHANNELS,
  SUPPORTED_AUDIO_EXTENSIONS,
  ALLOWED_PROVIDER_IDS,
  isWorkerProgressMessage,
  type AddLibraryRootRequest,
  type EmbedLyricsRequest,
  type EmbedLyricsResult,
  type LibraryRoot,
  type LyricsFetchRequest,
  type LyricsProviderId,
  type MediaUnloadAck,
  type MediaUnloadRequest,
  type MediaUrl,
  type SaveDraftRequest,
  type ScanLibraryRequest,
  type ScanLibraryResult,
  type ScanProgress,
  type TagEngineHealth,
  type TrackMetadata,
  type TrackRecord,
  type WorkerPayload,
  type WorkerRequest,
  type WorkerResponse
} from '@shared/ipc'
import audioWorkerModulePath from './audioWorker?modulePath'
import {
  abortStreamsForPath,
  createMediaHandler,
  MEDIA_SCHEME,
  MEDIA_SCHEME_PRIVILEGES
} from './mediaProtocol'
import { createStore, computeTrackId, type JsonStore } from './store'
import { cleanupStaleTempFiles, isSupportedAudioPath } from './tagger'
import { isPathWithinRoots } from './utils/pathContainment'
import { isValidTrackId, normalizePathKey, resolveRealPath } from './utils/trackId'
import { resolveTaglibWasmPath } from './wasmPath'
import { createLyricsFetchQueue, type LyricsFetchQueue } from './providers/queue'
import { createLrclibProvider } from './providers/lrclib'
import { createLocalSidecarProvider, importLrcFile } from './providers/localSidecar'

const MAX_LYRICS_BYTES = 1024 * 1024
const MAX_QUERY_FIELD_CHARS = 512
const WORKER_INIT_TIMEOUT_MS = 10_000
const WORKER_RESTART_LIMIT = 3
const UNLOAD_ACK_TIMEOUT_MS = 2000
const STREAM_CLOSE_TIMEOUT_MS = 3000

// `registerSchemesAsPrivileged` must run before the app `ready` event. This
// module is evaluated before `whenReady()`, so registering here is safe.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { ...MEDIA_SCHEME_PRIVILEGES }
  }
])

interface PendingRequest {
  resolve: (value: WorkerResponse) => void
  reject: (reason: Error) => void
}

let mainWindow: BrowserWindow | null = null
let worker: UtilityProcess | null = null
let workerStartPromise: Promise<void> | null = null
let restartAttempts = 0
let restartSuppressed = false
let isQuitting = false
// Ref-counted active target directories for temp sweep
const activeTargetDirs = new Map<string, number>()
let store: JsonStore | null = null
let lyricsFetchQueue: LyricsFetchQueue | null = null
// Tracks `.lrc` file real paths explicitly chosen by the user via native open dialog.
const authorizedDialogLrcPaths = new Set<string>()

let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
const pendingUnloads = new Map<string, () => void>()

let latestHealth: TagEngineHealth = {
  ready: false,
  taglibVersion: null,
  wasmPath: null,
  workerPid: null,
  error: 'Worker not started'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function requireStore(): JsonStore {
  if (!store) {
    throw new Error('Library store is not initialized')
  }
  return store
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function rejectAllPending(reason: string): void {
  const error = new Error(reason)
  for (const [, pending] of pendingRequests) {
    pending.reject(error)
  }
  pendingRequests.clear()
}

// Bounded timeout for post-init worker RPCs
const WORKER_RPC_TIMEOUT_MS = 30_000

function sendWorkerRequest<T>(payload: WorkerPayload): Promise<T> {
  if (!worker) {
    return Promise.reject(new Error('Audio worker is not running'))
  }
  const id = nextRequestId++
  const request: WorkerRequest = { id, ...payload }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Worker RPC timed out after ${WORKER_RPC_TIMEOUT_MS}ms`))
    }, WORKER_RPC_TIMEOUT_MS)

    pendingRequests.set(id, {
      resolve: (response) => {
        clearTimeout(timeout)
        if (response.ok) {
          resolve(response.result as T)
        } else {
          reject(new Error(response.error))
        }
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    })
    worker?.postMessage(request)
  })
}

async function sweepActiveTargetDir(dirPath: string): Promise<void> {
  try {
    const removed = await cleanupStaleTempFiles(dirPath, { recursive: false })
    if (removed.length > 0) {
      console.log(`[audioWorker] removed ${removed.length} orphaned staging file(s) from ${dirPath}`)
    }
  } catch (error) {
    console.warn(`[audioWorker] temp sweep after crash failed for ${dirPath}:`, error)
  }
}

function handleWorkerExit(child: UtilityProcess, code: number): void {
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

  if (isQuitting || restartSuppressed) {
    return
  }

  if (code === 0) {
    return
  }

  void (async () => {
    // Sweep all active target dirs
    for (const dirPath of activeTargetDirs.keys()) {
      await sweepActiveTargetDir(dirPath)
    }
    if (restartAttempts >= WORKER_RESTART_LIMIT) {
      console.error(`[audioWorker] restart limit (${WORKER_RESTART_LIMIT}) reached`)
      return
    }
    restartAttempts++
    setTimeout(() => {
      if (!worker && !isQuitting && !restartSuppressed) {
        void startAudioWorker()
      }
    }, 500)
  })()
}

async function startAudioWorkerInternal(): Promise<void> {
  const wasmUrl = resolveTaglibWasmPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  })

  restartSuppressed = false

  const child = utilityProcess.fork(audioWorkerModulePath, [], { stdio: 'pipe' })
  worker = child

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd()
    if (text) console.log(`[audioWorker] ${text}`)
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd()
    if (text) console.error(`[audioWorker] ${text}`)
  })

  child.on('message', (message: unknown) => {
    if (isWorkerProgressMessage(message)) {
      sendToRenderer(IPC_CHANNELS.scanProgress, message.progress)
      return
    }
    const response = message as WorkerResponse
    if (!response || typeof response.id !== 'number') return
    const pending = pendingRequests.get(response.id)
    if (!pending) return
    pendingRequests.delete(response.id)
    pending.resolve(response)
  })

  child.on('error', (type, location, report) => {
    const message = `audioWorker fatal ${type} at ${location}: ${report}`
    console.error(`[audioWorker] ${message}`)
    latestHealth = { ...latestHealth, ready: false, error: message }
    rejectAllPending(message)
  })

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[audioWorker] exited with non-zero code ${code}`)
    }
    handleWorkerExit(child, code)
  })

  try {
    latestHealth = await withTimeout(
      sendWorkerRequest<TagEngineHealth>({ type: 'init', wasmUrl }),
      WORKER_INIT_TIMEOUT_MS,
      `Audio worker initialization timed out after ${WORKER_INIT_TIMEOUT_MS}ms`
    )
    restartAttempts = 0
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
    restartSuppressed = true
    worker = null
    child.kill()
    rejectAllPending(`Audio worker initialization failed: ${message}`)
  }
}

async function startAudioWorker(): Promise<void> {
  if (workerStartPromise) {
    return workerStartPromise
  }
  workerStartPromise = startAudioWorkerInternal().finally(() => {
    workerStartPromise = null
  })
  return workerStartPromise
}

async function validateAudioFilePath(rawPath: unknown): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw new Error('Invalid file path')
  }
  // Reject relative paths before resolving
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`Path must be absolute: ${rawPath}`)
  }
  const normalized = path.resolve(rawPath)
  if (!isSupportedAudioPath(normalized)) {
    throw new Error(`Unsupported audio path: ${rawPath}`)
  }

  // Resolve real path to block symlink escapes
  const realPath = await resolveRealPath(normalized)

  const stat = await fs.stat(realPath)
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${realPath}`)
  }

  // When library roots exist, restrict operations to authorized roots.
  if (store) {
    const roots = await store.getRoots()
    if (roots.length === 0) {
      throw new Error('No authorized library roots configured')
    }
    if (!isPathWithinRoots(realPath, roots.map((root) => root.path))) {
      throw new Error(`Path is outside authorized library roots: ${realPath}`)
    }
  }

  return realPath
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
  return { filePath: candidate.filePath, lyrics: candidate.lyrics }
}

function validateScanRequest(payload: unknown): ScanLibraryRequest {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object') {
    throw new Error('Invalid scan request payload')
  }
  const candidate = payload as Record<string, unknown>
  if (candidate.rootId !== undefined && typeof candidate.rootId !== 'string') {
    throw new Error('Scan request rootId must be a string')
  }
  return candidate.rootId === undefined ? {} : { rootId: candidate.rootId }
}

function validateSaveDraft(payload: unknown): SaveDraftRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid draft payload')
  }
  const candidate = payload as Record<string, unknown>
  if (typeof candidate.trackId !== 'string' || candidate.trackId.length === 0) {
    throw new Error('Draft payload must include a trackId')
  }
  if (typeof candidate.lyrics !== 'string') {
    throw new Error('Draft payload must include lyrics text')
  }
  if (Buffer.byteLength(candidate.lyrics, 'utf8') > MAX_LYRICS_BYTES) {
    throw new Error('Lyrics payload exceeds 1 MiB limit')
  }
  const status = candidate.status
  if (status !== undefined && status !== 'pending' && status !== 'synced' && status !== 'conflict') {
    throw new Error('Draft status must be pending, synced, or conflict')
  }
  return {
    trackId: candidate.trackId,
    lyrics: candidate.lyrics,
    ...(status === undefined ? {} : { status })
  }
}

function validateLyricsFetchRequest(payload: unknown): LyricsFetchRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid lyrics fetch request')
  }
  const c = payload as Record<string, unknown>
  if (typeof c.trackId !== 'string' || c.trackId.length === 0) {
    throw new Error('Lyrics fetch request must include trackId')
  }
  if (!isValidTrackId(c.trackId)) {
    throw new Error('Invalid track id format')
  }
  if (typeof c.title !== 'string' || c.title.length > MAX_QUERY_FIELD_CHARS) {
    throw new Error(`Lyrics fetch request title must be a string <= ${MAX_QUERY_FIELD_CHARS} chars`)
  }
  if (typeof c.artist !== 'string' || c.artist.length > MAX_QUERY_FIELD_CHARS) {
    throw new Error(`Lyrics fetch request artist must be a string <= ${MAX_QUERY_FIELD_CHARS} chars`)
  }
  if (typeof c.album !== 'string' || c.album.length > MAX_QUERY_FIELD_CHARS) {
    throw new Error(`Lyrics fetch request album must be a string <= ${MAX_QUERY_FIELD_CHARS} chars`)
  }
  if (typeof c.durationSec !== 'number' || !Number.isFinite(c.durationSec) || c.durationSec < 0) {
    throw new Error('Lyrics fetch request must include non-negative numeric durationSec')
  }
  if (typeof c.filePath !== 'string' || c.filePath.length === 0 || c.filePath.includes('\0')) {
    throw new Error('Lyrics fetch request must include valid filePath')
  }

  let providerIds: LyricsProviderId[] | undefined
  if (c.providerIds !== undefined) {
    if (!Array.isArray(c.providerIds) || c.providerIds.length === 0) {
      throw new Error('providerIds must be a non-empty array when specified')
    }
    for (const pid of c.providerIds) {
      if (typeof pid !== 'string' || !(ALLOWED_PROVIDER_IDS as readonly string[]).includes(pid)) {
        throw new Error(`Invalid provider id: ${String(pid)}`)
      }
    }
    providerIds = c.providerIds as LyricsProviderId[]
  }

  return {
    trackId: c.trackId,
    title: c.title,
    artist: c.artist,
    album: c.album,
    durationSec: c.durationSec,
    filePath: c.filePath,
    ...(providerIds ? { providerIds } : {})
  }
}

async function prepareAuthorizedLyricsFetch(rawPayload: unknown): Promise<LyricsFetchRequest> {
  const request = validateLyricsFetchRequest(rawPayload)
  const realPath = await validateAudioFilePath(request.filePath)

  if (store) {
    const existingTrack = await store.getTrack(request.trackId)
    if (existingTrack && normalizePathKey(existingTrack.filePath) !== normalizePathKey(realPath)) {
      throw new Error('Track ID does not match authorized track path')
    }
  }

  return {
    ...request,
    filePath: realPath
  }
}

async function validateLrcImportPath(rawFilePath: unknown): Promise<string> {
  if (typeof rawFilePath !== 'string' || rawFilePath.length === 0 || rawFilePath.includes('\0')) {
    throw new Error('Invalid file path')
  }
  if (!path.isAbsolute(rawFilePath)) {
    throw new Error(`Path must be absolute: ${rawFilePath}`)
  }
  const normalized = path.resolve(rawFilePath)
  if (path.extname(normalized).toLowerCase() !== '.lrc') {
    throw new Error(`Unsupported lyrics file extension: ${rawFilePath}`)
  }

  const lstat = await fs.lstat(normalized)
  if (lstat.isSymbolicLink()) {
    throw new Error(`Symlink LRC paths are not allowed: ${normalized}`)
  }
  if (!lstat.isFile()) {
    throw new Error(`Path is not a file: ${normalized}`)
  }

  const realPath = await resolveRealPath(normalized)
  const roots = store ? await store.getRoots() : []
  const withinRoots =
    roots.length > 0 && isPathWithinRoots(realPath, roots.map((root) => root.path))
  const selectedViaDialog = authorizedDialogLrcPaths.has(normalizePathKey(realPath))

  if (!withinRoots && !selectedViaDialog) {
    throw new Error(`Path is outside authorized library roots: ${realPath}`)
  }

  return realPath
}

function requestRendererUnload(filePath: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve()
  }

  const requestId = crypto.randomUUID()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingUnloads.delete(requestId)
      resolve()
    }, UNLOAD_ACK_TIMEOUT_MS)

    pendingUnloads.set(requestId, () => {
      clearTimeout(timer)
      resolve()
    })

    const request: MediaUnloadRequest = { requestId, filePath }
    mainWindow?.webContents.send(IPC_CHANNELS.unloadAudio, request)
  })
}

async function runScan(request: ScanLibraryRequest): Promise<ScanLibraryResult> {
  const library = requireStore()
  const index = await library.readIndex()
  const roots = request.rootId
    ? index.roots.filter((root) => root.id === request.rootId)
    : index.roots

  if (roots.length === 0) {
    const empty: ScanLibraryResult = { rootIds: [], tracks: [] }
    sendToRenderer(IPC_CHANNELS.scanComplete, empty)
    return empty
  }

  const allTracks: TrackRecord[] = []
  const rootIds: string[] = []

  for (const root of roots) {
    const initial: ScanProgress = {
      phase: 'scanning',
      processed: 0,
      total: 0,
      currentPath: root.path
    }
    sendToRenderer(IPC_CHANNELS.scanProgress, initial)

    const tracks = await sendWorkerRequest<TrackRecord[]>({ type: 'scanLibrary', root })
    await library.upsertTracks(tracks)
    await library.markRootScanned(root.id)
    allTracks.push(...tracks)
    rootIds.push(root.id)
  }

  const result: ScanLibraryResult = { rootIds, tracks: allTracks }
  sendToRenderer(IPC_CHANNELS.scanComplete, result)
  return result
}

async function refreshTrackAfterEmbed(
  filePath: string,
  result: EmbedLyricsResult
): Promise<void> {
  if (!store) return
  try {
    const metadata = await sendWorkerRequest<TrackMetadata>({
      type: 'readTrackMetadata',
      filePath
    })
    const stat = await fs.stat(filePath)
    const trackId = computeTrackId(filePath)
    const existing = await store.getTrack(trackId)
    const record: TrackRecord = {
      id: trackId,
      filePath,
      format: metadata.format,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      durationSec: metadata.durationSec,
      lyrics: metadata.lyrics,
      lyricsSource: metadata.lyricsSource,
      existingLyricsKeys: metadata.existingLyricsKeys,
      libraryRootId: existing?.libraryRootId ?? '',
      mtimeMs: stat.mtimeMs,
      ...(existing?.draftId ? { draftId: existing.draftId } : {})
    }
    await store.upsertTracks([record])
    if (result.targetPath !== filePath) {
      // `.wav` writes a sidecar; the track record above already reflects it.
      console.log(`[embed] sidecar updated: ${result.targetPath}`)
    }
  } catch (error) {
    console.warn('[embed] failed to refresh track record after embed:', error)
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
      return { ...latestHealth, ready: false, error: message }
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
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC_CHANNELS.selectLibraryFolder, async (): Promise<string | null> => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Add Library Folder',
      properties: ['openDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(
    IPC_CHANNELS.readTrackMetadata,
    async (_event, rawFilePath: unknown): Promise<TrackMetadata> => {
      const filePath = await validateAudioFilePath(rawFilePath)
      return sendWorkerRequest<TrackMetadata>({ type: 'readTrackMetadata', filePath })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.embedLyrics,
    async (_event, rawPayload: unknown): Promise<EmbedLyricsResult> => {
      const validated = validateEmbedPayload(rawPayload)
      const filePath = await validateAudioFilePath(validated.filePath)

      // Check worker is available before proceeding
      if (!worker) {
        throw new Error('Audio worker is not running')
      }

      // Windows lock handshake: unload <audio> and close all media:// handles
      // before the worker stages/swaps the file.
      await abortStreamsForPath(filePath, {
        requestUnload: () => requestRendererUnload(filePath),
        unloadTimeoutMs: UNLOAD_ACK_TIMEOUT_MS,
        closeTimeoutMs: STREAM_CLOSE_TIMEOUT_MS
      })

      const targetDir = path.dirname(filePath)
      // Increment ref count for target dir
      const prevCount = activeTargetDirs.get(targetDir) ?? 0
      activeTargetDirs.set(targetDir, prevCount + 1)
      try {
        const result = await sendWorkerRequest<EmbedLyricsResult>({
          type: 'embedLyrics',
          filePath,
          lyrics: validated.lyrics
        })
        await refreshTrackAfterEmbed(filePath, result)
        return result
      } finally {
        // Decrement ref count and clean up if zero
        const count = activeTargetDirs.get(targetDir) ?? 1
        if (count <= 1) {
          activeTargetDirs.delete(targetDir)
        } else {
          activeTargetDirs.set(targetDir, count - 1)
        }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.getRoots, async (): Promise<LibraryRoot[]> => {
    return requireStore().getRoots()
  })

  ipcMain.handle(
    IPC_CHANNELS.addRoot,
    async (_event, rawPayload: unknown): Promise<LibraryRoot> => {
      if (!rawPayload || typeof rawPayload !== 'object') {
        throw new Error('Invalid add-root payload')
      }
      const candidate = rawPayload as Record<string, unknown>
      if (typeof candidate.path !== 'string' || candidate.path.length === 0) {
        throw new Error('Add-root payload must include a path')
      }
      const request: AddLibraryRootRequest = {
        path: candidate.path,
        ...(typeof candidate.name === 'string' ? { name: candidate.name } : {})
      }

      const resolved = path.resolve(request.path)
      const stat = await fs.stat(resolved)
      if (!stat.isDirectory()) {
        throw new Error(`Library root is not a directory: ${resolved}`)
      }

      const library = requireStore()
      const existing = (await library.getRoots()).find(
        (root) => path.resolve(root.path).toLowerCase() === resolved.toLowerCase()
      )
      if (existing) return existing

      const root: LibraryRoot = {
        id: computeTrackId(resolved),
        path: resolved,
        name: request.name?.trim() || path.basename(resolved) || resolved,
        addedAt: new Date().toISOString()
      }
      return library.addRoot(root)
    }
  )

  ipcMain.handle(IPC_CHANNELS.removeRoot, async (_event, rawRootId: unknown): Promise<boolean> => {
    if (typeof rawRootId !== 'string' || rawRootId.length === 0) {
      throw new Error('Invalid library root id')
    }
    return requireStore().removeRoot(rawRootId)
  })

  ipcMain.handle(
    IPC_CHANNELS.scanLibrary,
    async (_event, rawPayload: unknown): Promise<ScanLibraryResult> => {
      return runScan(validateScanRequest(rawPayload))
    }
  )

  ipcMain.handle(IPC_CHANNELS.getTracks, async (): Promise<TrackRecord[]> => {
    return requireStore().getTracks()
  })

  ipcMain.handle(
    IPC_CHANNELS.getTrack,
    async (_event, rawTrackId: unknown): Promise<TrackRecord | null> => {
      if (typeof rawTrackId !== 'string' || rawTrackId.length === 0) {
        throw new Error('Invalid track id')
      }
      if (!isValidTrackId(rawTrackId)) {
        throw new Error('Invalid track id format')
      }
      return requireStore().getTrack(rawTrackId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.saveDraft, async (_event, rawPayload: unknown) => {
    const validated = validateSaveDraft(rawPayload)
    if (!isValidTrackId(validated.trackId)) {
      throw new Error('Invalid track id format')
    }
    return requireStore().saveDraft(validated)
  })

  ipcMain.handle(IPC_CHANNELS.getDraft, async (_event, rawTrackId: unknown) => {
    if (typeof rawTrackId !== 'string' || rawTrackId.length === 0) {
      throw new Error('Invalid track id')
    }
    if (!isValidTrackId(rawTrackId)) {
      throw new Error('Invalid track id format')
    }
    return requireStore().readDraft(rawTrackId)
  })

  ipcMain.handle(IPC_CHANNELS.deleteDraft, async (_event, rawTrackId: unknown) => {
    if (typeof rawTrackId !== 'string' || rawTrackId.length === 0) {
      throw new Error('Invalid track id')
    }
    if (!isValidTrackId(rawTrackId)) {
      throw new Error('Invalid track id format')
    }
    return requireStore().deleteDraft(rawTrackId)
  })

  ipcMain.handle(
    IPC_CHANNELS.getMediaUrl,
    async (_event, rawTrackId: unknown): Promise<MediaUrl> => {
      if (typeof rawTrackId !== 'string' || rawTrackId.length === 0) {
        throw new Error('Invalid track id')
      }
      if (!isValidTrackId(rawTrackId)) {
        throw new Error('Invalid track id format')
      }
      const library = requireStore()
      const index = await library.readIndex()
      const track = index.tracks.find((candidate) => candidate.id === rawTrackId)
      if (!track) {
        throw new Error(`Unknown track id: ${rawTrackId}`)
      }
      if (!isPathWithinRoots(track.filePath, index.roots.map((root) => root.path))) {
        throw new Error('Track path is outside authorized library roots')
      }
      return {
        trackId: track.id,
        url: `${MEDIA_SCHEME}://track/${encodeURIComponent(track.id)}`
      }
    }
  )

  ipcMain.on(IPC_CHANNELS.acknowledgeUnload, (_event, rawAck: unknown) => {
    if (!rawAck || typeof rawAck !== 'object') return
    const ack = rawAck as MediaUnloadAck
    if (typeof ack.requestId !== 'string') return
    const resolve = pendingUnloads.get(ack.requestId)
    if (!resolve) return
    pendingUnloads.delete(ack.requestId)
    resolve()
  })

  // --- Lyrics provider IPC handlers ---

  ipcMain.handle(IPC_CHANNELS.selectLrcFile, async (): Promise<string | null> => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Import LRC File',
      properties: ['openFile'],
      filters: [{ name: 'LRC Files', extensions: ['lrc'] }]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return null
    const selected = result.filePaths[0]
    if (!selected) return null
    try {
      const lstat = await fs.lstat(selected)
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        return null
      }
      const realPath = await resolveRealPath(selected)
      authorizedDialogLrcPaths.add(normalizePathKey(realPath))
    } catch {
      // Return null if the chosen file cannot be stat-ed cleanly
      return null
    }
    return selected
  })

  ipcMain.handle(
    IPC_CHANNELS.lyricsFetch,
    async (_event, rawPayload: unknown) => {
      if (!lyricsFetchQueue) {
        throw new Error('Lyrics fetch queue not initialized')
      }
      const request = await prepareAuthorizedLyricsFetch(rawPayload)
      return lyricsFetchQueue.fetch(request)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.lyricsFetchBatch,
    async (_event, rawPayload: unknown) => {
      if (!Array.isArray(rawPayload)) {
        throw new Error('Batch fetch payload must be an array')
      }
      if (!lyricsFetchQueue) {
        throw new Error('Lyrics fetch queue not initialized')
      }
      const queries = await Promise.all(rawPayload.map(prepareAuthorizedLyricsFetch))
      return lyricsFetchQueue.fetchBatch(queries)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.lyricsCancelFetch,
    async (_event, rawTrackId: unknown): Promise<void> => {
      if (typeof rawTrackId !== 'string' || rawTrackId.length === 0) {
        throw new Error('Invalid track id for cancel')
      }
      if (!isValidTrackId(rawTrackId)) {
        throw new Error('Invalid track id format')
      }
      lyricsFetchQueue?.cancel(rawTrackId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.lyricsImportFile,
    async (_event, rawFilePath: unknown): Promise<string | null> => {
      const realPath = await validateLrcImportPath(rawFilePath)
      return importLrcFile(realPath)
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
  // Restrict navigation to prevent loading external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') || url.startsWith(`${MEDIA_SCHEME}://`)) {
      return
    }
    event.preventDefault()
  })
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

async function initializePersistence(): Promise<void> {
  store = createStore(app.getPath('userData'))
  const removed = await store.initialize()
  if (removed.length > 0) {
    console.log(`[store] removed ${removed.length} stale staging file(s) on startup`)
  }
}

function initializeLyricsFetchQueue(): void {
  lyricsFetchQueue = createLyricsFetchQueue({
    providers: [
      createLocalSidecarProvider(),
      createLrclibProvider()
    ],
    onProgress: (progress) => {
      sendToRenderer(IPC_CHANNELS.lyricsFetchProgress, progress)
    }
  })
}

void app.whenReady().then(async () => {
  registerIpcHandlers()

  await initializePersistence()
  initializeLyricsFetchQueue()

  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      resolveTrack: async (trackId) => {
        if (!store) return null
        const index = await store.readIndex()
        const track = index.tracks.find((candidate) => candidate.id === trackId)
        if (!track) return null
        return {
          filePath: track.filePath,
          roots: index.roots.map((root) => root.path)
        }
      }
    })
  )

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
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error('[startup] fatal error during app initialization:', message)
  if (!process.argv.includes('--smoke-test')) {
    try {
      dialog.showErrorBox('Startup Error', `Poweramp LRC Embedder failed to initialize:\n\n${message}`)
    } catch {
      // Ignore dialog errors if display is unavailable
    }
  }
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  lyricsFetchQueue?.dispose()
  for (const [, resolve] of pendingUnloads) {
    resolve()
  }
  pendingUnloads.clear()
  if (worker) {
    worker.kill()
    worker = null
  }
})
