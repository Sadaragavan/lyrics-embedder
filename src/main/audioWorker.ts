import type {
  LibraryRoot,
  ScanProgress,
  TagEngineHealth,
  TrackRecord,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse
} from '@shared/ipc'
import { AudioTagger } from './tagger'
import { scanAudioLibrary } from './scanner'

const parentPort = process.parentPort
if (!parentPort) {
  throw new Error('audioWorker must be started inside an Electron utilityProcess')
}

let tagger: AudioTagger | null = null
let initializedWasmPath: string | null = null
let initError: string | null = null

function postResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response)
}

function postProgress(id: number, progress: ScanProgress): void {
  const message: WorkerMessage = { type: 'scanProgress', id, progress }
  parentPort?.postMessage(message)
}

function getHealthSnapshot(): TagEngineHealth {
  return {
    ready: tagger !== null,
    taglibVersion: tagger ? tagger.getVersion() : null,
    wasmPath: initializedWasmPath,
    workerPid: process.pid,
    error: initError
  }
}

async function handleScanLibrary(root: LibraryRoot, requestId: number): Promise<TrackRecord[]> {
  let lastTotal = 0
  let lastProcessed = 0
  let lastErrors = 0

  const tracks = await scanAudioLibrary(root.path, {
    rootId: root.id,
    readMetadata: async (filePath) => {
      if (!tagger) {
        throw new Error(initError ?? 'AudioTagger is not initialized')
      }
      return tagger.readTrackMetadata(filePath)
    },
    onProgress: (update) => {
      lastTotal = update.total
      lastProcessed = update.processed
      lastErrors = update.errors
      postProgress(requestId, {
        phase: 'scanning',
        processed: update.processed,
        total: update.total,
        currentPath: update.currentPath,
        errors: update.errors
      })
    }
  })

  postProgress(requestId, {
    phase: 'complete',
    processed: lastProcessed || tracks.length,
    total: lastTotal || tracks.length,
    errors: lastErrors
  })

  return tracks
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === 'init') {
      initializedWasmPath = request.wasmUrl
      initError = null
      tagger = await AudioTagger.create({ wasmUrl: request.wasmUrl })
      postResponse({
        id: request.id,
        ok: true,
        result: getHealthSnapshot()
      })
      return
    }

    if (request.type === 'health') {
      postResponse({
        id: request.id,
        ok: true,
        result: getHealthSnapshot()
      })
      return
    }

    if (request.type === 'scanLibrary') {
      const tracks = await handleScanLibrary(request.root, request.id)
      postResponse({ id: request.id, ok: true, result: tracks })
      return
    }

    if (!tagger) {
      throw new Error(initError ?? 'AudioTagger is not initialized')
    }

    if (request.type === 'readTrackMetadata') {
      const metadata = await tagger.readTrackMetadata(request.filePath)
      postResponse({ id: request.id, ok: true, result: metadata })
      return
    }

    if (request.type === 'embedLyrics') {
      const result = await tagger.embedLyrics(request.filePath, request.lyrics)
      postResponse({ id: request.id, ok: true, result })
      return
    }

    throw new Error('Unknown worker request type')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (request.type === 'init') {
      initError = message
      tagger = null
    }
    postResponse({
      id: request.id,
      ok: false,
      error: message
    })
  }
}

parentPort.on('message', (event) => {
  void handleRequest(event.data as WorkerRequest)
})
