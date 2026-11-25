import type { TagEngineHealth, WorkerRequest, WorkerResponse } from '@shared/ipc'
import { AudioTagger } from './tagger'

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

function getHealthSnapshot(): TagEngineHealth {
  return {
    ready: tagger !== null,
    taglibVersion: tagger ? tagger.getVersion() : null,
    wasmPath: initializedWasmPath,
    workerPid: process.pid,
    error: initError
  }
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

    throw new Error(`Unknown worker request type`)
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
