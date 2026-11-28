import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import {
  IPC_CHANNELS,
  SUPPORTED_AUDIO_EXTENSIONS,
  ALLOWED_PROVIDER_IDS,
  isWorkerProgressMessage,
  type AddLibraryRootRequest,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderPreset,
  type AiProviderSettingsInput,
  type EmbedLyricsRequest,
  type EmbedLyricsResult,
  type LibraryRoot,
  type LyricsFetchRequest,
  type LyricsProviderId,
  type LyricsProvider,
  type LyricsSearchRequest,
  type LyricsSearchResult,
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
import { disposeApplicationMenu, setupApplicationMenu, updateMenuState } from './menu'
import { isPathWithinRoots } from './utils/pathContainment'
import { isValidTrackId, normalizePathKey, resolveRealPath } from './utils/trackId'
import { scoreCandidate } from '@shared/trackMatching'
import { validateAiBaseUrl } from '@shared/aiTranslate'
import { resolveTaglibWasmPath } from './wasmPath'
import { createLyricsFetchQueue, type LyricsFetchQueue } from './providers/queue'
import { LrclibProvider } from './providers/lrclib'
import { NeteaseProvider } from './providers/netease'
import { createAiTranslator, type AiTranslator } from './providers/aiTranslator'
import { createSettingsStore, type SecretCipher, type SettingsStore } from './settingsStore'
import {
  createLocalSidecarProvider,
  getSidecarPath,
  importLrcFile
} from './providers/localSidecar'

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
let lrclibProvider: LrclibProvider | null = null
let neteaseProvider: NeteaseProvider | null = null
let localSidecarProvider: LyricsProvider | null = null
let settingsStore: SettingsStore | null = null
let aiTranslator: AiTranslator | null = null
/** In-flight AI generation jobs, keyed by `jobId`, for cancellation. */
const activeAiJobs = new Map<string, AbortController>()
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
  // Optional secondary layers: validated as strings when present.
  for (const layer of ['translation', 'romanization'] as const) {
    const value = candidate[layer]
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`Draft ${layer} must be a string when provided`)
    }
  }
  const translation = typeof candidate.translation === 'string' ? candidate.translation : undefined
  const romanization =
    typeof candidate.romanization === 'string' ? candidate.romanization : undefined

  // The 1 MiB budget covers the *combined* UTF-8 bytes of every layer so one
  // draft can never balloon the on-disk record.
  const combinedBytes =
    Buffer.byteLength(candidate.lyrics, 'utf8') +
    Buffer.byteLength(translation ?? '', 'utf8') +
    Buffer.byteLength(romanization ?? '', 'utf8')
  if (combinedBytes > MAX_LYRICS_BYTES) {
    throw new Error('Lyrics payload exceeds 1 MiB limit')
  }
  const status = candidate.status
  if (status !== undefined && status !== 'pending' && status !== 'synced' && status !== 'conflict') {
    throw new Error('Draft status must be pending, synced, or conflict')
  }
  return {
    trackId: candidate.trackId,
    lyrics: candidate.lyrics,
    ...(translation === undefined ? {} : { translation }),
    ...(romanization === undefined ? {} : { romanization }),
    ...(status === undefined ? {} : { status })
  }
}

const AI_PRESETS: readonly AiProviderPreset[] = [
  'openai',
  'gemini',
  'openrouter',
  'ollama',
  'custom'
]
const MAX_AI_MODEL_CHARS = 200
const MAX_AI_LANGUAGE_CHARS = 80

/** Validates a renderer settings write (URL safety + field lengths). */
function validateAiSettingsInput(payload: unknown): AiProviderSettingsInput {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid AI settings payload')
  }
  const c = payload as Record<string, unknown>

  if (typeof c.preset !== 'string' || !(AI_PRESETS as readonly string[]).includes(c.preset)) {
    throw new Error(`Invalid AI preset: ${String(c.preset)}`)
  }
  if (typeof c.baseUrl !== 'string') {
    throw new Error('AI settings must include a baseUrl string')
  }
  const urlCheck = validateAiBaseUrl(c.baseUrl)
  if (!urlCheck.ok) {
    throw new Error(urlCheck.error)
  }
  if (typeof c.model !== 'string' || c.model.trim().length === 0) {
    throw new Error('AI settings must include a model')
  }
  if (c.model.length > MAX_AI_MODEL_CHARS) {
    throw new Error(`AI model must be <= ${MAX_AI_MODEL_CHARS} characters`)
  }
  for (const key of ['targetLanguage', 'romanizationStyle'] as const) {
    const value = c[key]
    if (value !== undefined && (typeof value !== 'string' || value.length > MAX_AI_LANGUAGE_CHARS)) {
      throw new Error(`${key} must be a string <= ${MAX_AI_LANGUAGE_CHARS} characters`)
    }
  }
  if (c.apiKey !== undefined && typeof c.apiKey !== 'string') {
    throw new Error('apiKey must be a string when provided')
  }

  return {
    preset: c.preset as AiProviderPreset,
    baseUrl: urlCheck.url,
    model: c.model.trim(),
    targetLanguage: (c.targetLanguage as string | undefined) ?? 'English',
    romanizationStyle:
      (c.romanizationStyle as string | undefined) ?? 'Hepburn-style Romaji',
    ...(typeof c.apiKey === 'string' ? { apiKey: c.apiKey } : {})
  }
}

/** Validates an AI generation request before any network call is made. */
function validateAiGenerateRequest(
  payload: unknown
): { request: AiGenerateRequest; realFilePath: string } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid AI generate payload')
  }
  const c = payload as Record<string, unknown>

  if (typeof c.jobId !== 'string' || c.jobId.length === 0 || c.jobId.length > 128) {
    throw new Error('AI generate payload must include a jobId')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(c.jobId)) {
    throw new Error('Invalid jobId format')
  }
  if (typeof c.trackId !== 'string' || !isValidTrackId(c.trackId)) {
    throw new Error('AI generate payload must include a valid trackId')
  }
  if (c.mode !== 'translation' && c.mode !== 'romanization') {
    throw new Error("AI generate mode must be 'translation' or 'romanization'")
  }
  if (typeof c.lyrics !== 'string') {
    throw new Error('AI generate payload must include lyrics text')
  }
  if (Buffer.byteLength(c.lyrics, 'utf8') > MAX_LYRICS_BYTES) {
    throw new Error('Lyrics payload exceeds 1 MiB limit')
  }

  return {
    request: {
      jobId: c.jobId,
      trackId: c.trackId,
      mode: c.mode,
      lyrics: c.lyrics
    },
    realFilePath: ''
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

function validateLyricsSearchRequest(payload: unknown): LyricsSearchRequest {
  const base = validateLyricsFetchRequest(payload)
  const c = payload as Record<string, unknown>

  const readOverride = (
    key: 'searchTitle' | 'searchArtist' | 'searchAlbum'
  ): string | undefined => {
    const value = c[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length > MAX_QUERY_FIELD_CHARS) {
      throw new Error(`${key} must be a string <= ${MAX_QUERY_FIELD_CHARS} chars`)
    }
    return value
  }

  const searchTitle = readOverride('searchTitle')
  const searchArtist = readOverride('searchArtist')
  const searchAlbum = readOverride('searchAlbum')

  return {
    trackId: base.trackId,
    title: base.title,
    artist: base.artist,
    album: base.album,
    durationSec: base.durationSec,
    filePath: base.filePath,
    ...(searchTitle === undefined ? {} : { searchTitle }),
    ...(searchArtist === undefined ? {} : { searchArtist }),
    ...(searchAlbum === undefined ? {} : { searchAlbum }),
    ...(base.providerIds ? { providerIds: base.providerIds } : {})
  }
}

async function prepareAuthorizedLyricsSearch(
  rawPayload: unknown
): Promise<LyricsSearchRequest> {
  const request = validateLyricsSearchRequest(rawPayload)
  const realPath = await validateAudioFilePath(request.filePath)

  if (store) {
    const existingTrack = await store.getTrack(request.trackId)
    if (existingTrack && normalizePathKey(existingTrack.filePath) !== normalizePathKey(realPath)) {
      throw new Error('Track ID does not match authorized track path')
    }
  }

  return { ...request, filePath: realPath }
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

  // Renderer-owned menu state (checkbox/radio/enabled flags).
  ipcMain.on(IPC_CHANNELS.menuSyncState, (_event, rawState: unknown) => {
    updateMenuState(rawState)
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

  // --- Pass B: AI settings + opt-in AI translation/romanization ---

  ipcMain.handle(IPC_CHANNELS.getAiSettings, async () => {
    if (!settingsStore) throw new Error('Settings store not initialized')
    return settingsStore.getPublicSettings()
  })

  ipcMain.handle(IPC_CHANNELS.saveAiSettings, async (_event, rawPayload: unknown) => {
    if (!settingsStore) throw new Error('Settings store not initialized')
    const input = validateAiSettingsInput(rawPayload)
    return settingsStore.saveSettings(input)
  })

  ipcMain.handle(IPC_CHANNELS.clearAiKey, async () => {
    if (!settingsStore) throw new Error('Settings store not initialized')
    return settingsStore.clearApiKey()
  })

  ipcMain.handle(
    IPC_CHANNELS.lyricsAiCancel,
    async (_event, rawJobId: unknown): Promise<void> => {
      if (typeof rawJobId !== 'string' || rawJobId.length === 0 || rawJobId.length > 128) {
        throw new Error('Invalid jobId for cancel')
      }
      const controller = activeAiJobs.get(rawJobId)
      if (controller) {
        controller.abort()
        activeAiJobs.delete(rawJobId)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.lyricsAiGenerate,
    async (_event, rawPayload: unknown): Promise<AiGenerateResult> => {
      if (!settingsStore || !aiTranslator) {
        throw new Error('AI translator not initialized')
      }
      const { request } = validateAiGenerateRequest(rawPayload)

      const settings = await settingsStore.getPublicSettings()
      if (!settings.encryptionAvailable && !settings.hasApiKey) {
        // Local Ollama needs no key, so only a remote preset without a key blocks.
        const isLoopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(settings.baseUrl)
        if (!isLoopback) {
          throw new Error(
            'No API key saved and secure storage is unavailable. Open Settings to configure AI.'
          )
        }
      }

      const apiKey = await settingsStore.getApiKey()
      const controller = new AbortController()
      activeAiJobs.set(request.jobId, controller)
      sendToRenderer(IPC_CHANNELS.lyricsAiProgress, {
        jobId: request.jobId,
        trackId: request.trackId,
        phase: 'running'
      })

      try {
        const outcome = await aiTranslator.generate({
          jobId: request.jobId,
          trackId: request.trackId,
          mode: request.mode,
          lyrics: request.lyrics,
          settings,
          apiKey,
          signal: controller.signal
        })
        sendToRenderer(IPC_CHANNELS.lyricsAiProgress, {
          jobId: request.jobId,
          trackId: request.trackId,
          phase: 'done'
        })
        return {
          jobId: request.jobId,
          trackId: request.trackId,
          mode: request.mode,
          lyrics: outcome.lyrics,
          lineCount: outcome.lineCount,
          ...(outcome.model ? { model: outcome.model } : {})
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const aborted = controller.signal.aborted
        sendToRenderer(IPC_CHANNELS.lyricsAiProgress, {
          jobId: request.jobId,
          trackId: request.trackId,
          phase: aborted ? 'cancelled' : 'error',
          ...(aborted ? {} : { error: message })
        })
        throw error
      } finally {
        activeAiJobs.delete(request.jobId)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.lyricsSearchCandidates,
    async (_event, rawPayload: unknown): Promise<LyricsSearchResult[]> => {
      if (!lrclibProvider) {
        throw new Error('LRCLIB provider not initialized')
      }
      const request = await prepareAuthorizedLyricsSearch(rawPayload)
      const wanted = request.providerIds ? new Set(request.providerIds) : null
      const isWanted = (id: LyricsProviderId): boolean => wanted === null || wanted.has(id)

      const results: LyricsSearchResult[] = []
      const failures: string[] = []

      // A sibling `.lrc` next to the file always wins: prepend it so the sifter
      // lists the exact-file sidecar ahead of remote matches.
      if (localSidecarProvider && isWanted('localSidecar')) {
        try {
          const localCandidate = await localSidecarProvider.fetch({
            trackId: request.trackId,
            title: request.title,
            artist: request.artist,
            album: request.album,
            durationSec: request.durationSec,
            filePath: request.filePath,
            providerIds: ['localSidecar']
          })
          const text = localCandidate?.syncedLyrics ?? localCandidate?.plainLyrics
          if (localCandidate && text) {
            const scored = scoreCandidate({
              queryTitle: request.title,
              queryArtist: request.artist,
              queryAlbum: request.album,
              queryDurationSec: request.durationSec,
              candidateTitle: request.title,
              candidateArtist: request.artist,
              candidateAlbum: request.album,
              candidateDurationSec: request.durationSec,
              syncedLyrics: localCandidate.syncedLyrics,
              plainLyrics: localCandidate.plainLyrics,
              isLocalSidecar: true
            })
            results.push({
              providerId: 'localSidecar',
              sourceId: `sidecar:${path.basename(request.filePath)}`,
              sourceRef: getSidecarPath(request.filePath),
              title: request.title,
              artist: request.artist,
              album: request.album,
              durationSec: request.durationSec,
              syncedLyrics: localCandidate.syncedLyrics,
              plainLyrics: localCandidate.plainLyrics,
              score: scored.score,
              timingKind: localCandidate.timingKind ?? scored.timingKind
            })
          }
        } catch (error) {
          // Partial results beat a hard failure: record and keep going.
          failures.push(error instanceof Error ? error.message : String(error))
          console.error('[lyrics] local sidecar candidate lookup failed:', error)
        }
      }

      // Remote providers run sequentially (each keeps its own concurrency = 1
      // queue + pacing). A single provider failing must not blank the sifter.
      const remoteProviders: LyricsProvider[] = []
      if (isWanted('lrclib') && lrclibProvider) remoteProviders.push(lrclibProvider)
      if (isWanted('netease') && neteaseProvider) remoteProviders.push(neteaseProvider)

      for (const provider of remoteProviders) {
        try {
          const providerResults = await provider.searchAllCandidates?.(request)
          if (providerResults) results.push(...providerResults)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
          console.error(`[lyrics] ${provider.id} candidate search failed:`, error)
        }
      }

      if (results.length === 0 && failures.length > 0) {
        throw new Error(failures.join(' | '))
      }
      return results
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

/**
 * Adapts Electron's *async* `safeStorage` (Electron 45) to the settings store's
 * `SecretCipher` contract.
 *
 * On Linux, a `basic_text` backend means the "encryption" is a hardcoded key —
 * effectively plaintext — so it is treated as unavailable and the UI tells the
 * user the key cannot be stored. The deprecated synchronous
 * `encryptString`/`decryptString` APIs are deliberately avoided; Electron 45
 * only exposes async variants in the main process.
 */
function createSafeStorageCipher(): SecretCipher {
  let available: boolean | null = null

  const probe = async (): Promise<{ ok: boolean; backend?: string }> => {
    try {
      const ok = await safeStorage.isAsyncEncryptionAvailable()
      if (!ok) return { ok: false }
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend()
        // `basic_text` is obfuscation, not encryption. Never report it as secure.
        if (backend === 'basic_text') {
          console.warn('[settings] safeStorage backend is basic_text; API key storage disabled')
          return { ok: false, backend }
        }
        return { ok: true, backend }
      }
      return { ok: true }
    } catch (error) {
      console.error('[settings] safeStorage availability probe failed:', error)
      return { ok: false }
    }
  }

  return {
    isAvailable(): boolean {
      // Synchronous view for `getPublicSettings()`: the first real answer wins.
      if (available === null) return false
      return available
    },
    /** Warms the availability cache without touching a real secret. */
    async encryptProbe(): Promise<boolean> {
      const status = await probe()
      available = status.ok
      return status.ok
    },
    async encrypt(plaintext: string): Promise<string> {
      const status = await probe()
      available = status.ok
      if (!status.ok) {
        throw new Error('Secure storage is unavailable; cannot encrypt the API key')
      }
      const encrypted = await safeStorage.encryptStringAsync(plaintext)
      return Buffer.from(encrypted).toString('base64')
    },
    async decrypt(ciphertext: string): Promise<{ value: string; shouldReEncrypt?: boolean }> {
      const status = await probe()
      available = status.ok
      if (!status.ok) {
        throw new Error('Secure storage is unavailable; cannot decrypt the API key')
      }
      const buffer = Buffer.from(ciphertext, 'base64')
      const decrypted = await safeStorage.decryptStringAsync(buffer)
      // Electron reports a rotated/new key; the caller re-encrypts and rewrites.
      return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt }
    }
  }
}

async function initializePersistence(): Promise<void> {
  const userData = app.getPath('userData')
  store = createStore(userData)
  const removed = await store.initialize()
  if (removed.length > 0) {
    console.log(`[store] removed ${removed.length} stale staging file(s) on startup`)
  }

  const cipher = createSafeStorageCipher()
  // Probe once up front so the first `getPublicSettings()` already reports
  // `encryptionAvailable` correctly, and so `isAvailable()` is meaningful for
  // the synchronous save path.
  settingsStore = createSettingsStore(userData, { cipher })
  try {
    await cipher.encryptProbe?.()
  } catch (error) {
    console.warn('[settings] secure storage unavailable:', error)
  }
}

function initializeLyricsFetchQueue(): void {
  // Allow E2E tests to override base URLs via environment variables
  const lrclibBaseUrl = process.env.LRCLIB_BASE_URL
  const neteaseBaseUrl = process.env.NETEASE_BASE_URL

  lrclibProvider = new LrclibProvider({
    ...(lrclibBaseUrl ? { baseUrl: lrclibBaseUrl } : {})
  })
  neteaseProvider = new NeteaseProvider({
    ...(neteaseBaseUrl ? { baseUrl: neteaseBaseUrl } : {})
  })
  localSidecarProvider = createLocalSidecarProvider()
  aiTranslator = createAiTranslator()
  lyricsFetchQueue = createLyricsFetchQueue({
    providers: [
      localSidecarProvider!,
      lrclibProvider,
      neteaseProvider
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

  setupApplicationMenu({
    getWindow: () => mainWindow,
    getHealth: () => latestHealth,
    dispatch: (action) => sendToRenderer(IPC_CHANNELS.menuAction, action)
  })

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
  disposeApplicationMenu()
  lyricsFetchQueue?.dispose()
  // Abort any in-flight AI generation so the HTTP request cannot outlive the app.
  for (const controller of activeAiJobs.values()) {
    controller.abort()
  }
  activeAiJobs.clear()
  for (const [, resolve] of pendingUnloads) {
    resolve()
  }
  pendingUnloads.clear()
  if (worker) {
    worker.kill()
    worker = null
  }
})
