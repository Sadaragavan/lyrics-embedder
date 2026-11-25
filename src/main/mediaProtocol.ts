/**
 * Custom `media://` protocol support.
 *
 * URL format: `media://track/<trackId>` where `<trackId>` is the deterministic
 * hash of the track's absolute path. Serving raw Windows paths over a custom
 * scheme is intentionally avoided so paths never leak into the renderer and
 * the handler can enforce library-root containment.
 *
 * Supports HTTP 200 (full), 206 (bounded/open-ended/suffix byte ranges), and
 * 416 (Range Not Satisfiable) responses, with `Accept-Ranges: bytes`.
 *
 * The module has no `electron` import so range parsing, the stream registry,
 * and the abort handshake can be unit tested in a plain Node environment.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isPathWithinRoots } from './utils/pathContainment'
import { isValidTrackId } from './utils/trackId'

export const MEDIA_SCHEME = 'media'

export const MEDIA_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true
} as const

/** Minimal structural request shape accepted by the handler (Electron's `Request` fits). */
export interface MediaRequestLike {
  url: string
  headers: {
    get(name: string): string | null
  }
}

export interface ResolvedMediaTrack {
  filePath: string
  roots: readonly string[]
}

export type MediaTrackResolver = (trackId: string) => Promise<ResolvedMediaTrack | null>

export interface MediaHandlerOptions {
  resolveTrack: MediaTrackResolver
  registry?: StreamRegistry
}

export interface ByteRange {
  start: number
  end: number
}

export interface AbortStreamsOptions {
  /** Renderer unload handshake; awaited before streams are closed. */
  requestUnload?: () => Promise<void>
  unloadTimeoutMs?: number
  closeTimeoutMs?: number
  registry?: StreamRegistry
}

const MIME_TYPES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

export function getMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Rejects a promise that does not settle within `timeoutMs`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out'
): Promise<T> {
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

/**
 * Parses a single-range `Range` header against a file size.
 *
 * Supported forms: `bytes=start-end`, `bytes=start-`, `bytes=-suffix`.
 * Multi-range requests and malformed/unsatisfiable ranges return `null`, which
 * the handler maps to 416.
 */
export function parseRangeHeader(rangeHeader: string, fileSize: number): ByteRange | null {
  if (!Number.isFinite(fileSize) || fileSize < 0) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null

  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return null

  if (startText === '') {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(endText, 10)
    if (!Number.isFinite(suffix) || suffix <= 0 || fileSize === 0) return null
    const start = Math.max(fileSize - suffix, 0)
    return { start, end: fileSize - 1 }
  }

  const start = Number.parseInt(startText, 10)
  if (!Number.isFinite(start) || start >= fileSize) return null

  if (endText === '') {
    return { start, end: fileSize - 1 }
  }

  const requestedEnd = Number.parseInt(endText, 10)
  if (!Number.isFinite(requestedEnd) || requestedEnd < start) return null

  return { start, end: Math.min(requestedEnd, fileSize - 1) }
}

interface TrackedStream {
  webStream: ReadableStream<Uint8Array>
  nodeStream: Readable
  handle: fs.FileHandle
  closedPromise: Promise<void>
}

/**
 * Tracks open response streams by normalized file path so an embed can close
 * every handle before the worker swaps the file on Windows.
 */
export class StreamRegistry {
  private readonly streams = new Map<string, Set<TrackedStream>>()

  private key(filePath: string): string {
    const resolved = path.resolve(filePath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  register(filePath: string, webStream: ReadableStream<Uint8Array>, nodeStream: Readable, handle: fs.FileHandle): void {
    const key = this.key(filePath)
    const closedPromise = new Promise<void>((resolve) => {
      const cleanup = () => resolve()
      nodeStream.once('close', cleanup)
      nodeStream.once('error', cleanup)
      nodeStream.once('end', cleanup)
    })

    const tracked: TrackedStream = { webStream, nodeStream, handle, closedPromise }
    const existing = this.streams.get(key)
    if (existing) {
      existing.add(tracked)
      return
    }
    this.streams.set(key, new Set([tracked]))
  }

  unregister(filePath: string, webStream: ReadableStream<Uint8Array>): void {
    const key = this.key(filePath)
    const existing = this.streams.get(key)
    if (!existing) return
    for (const tracked of existing) {
      if (tracked.webStream === webStream) {
        existing.delete(tracked)
        break
      }
    }
    if (existing.size === 0) {
      this.streams.delete(key)
    }
  }

  countForPath(filePath: string): number {
    return this.streams.get(this.key(filePath))?.size ?? 0
  }

  getActivePaths(): string[] {
    return [...this.streams.keys()]
  }

  /**
   * Cancels every tracked stream for `filePath` and waits (bounded) for the
   * close events. The registry entry is always removed afterwards.
   */
  async abortForPath(filePath: string, timeoutMs = 3000): Promise<void> {
    const key = this.key(filePath)
    const existing = this.streams.get(key)
    if (!existing || existing.size === 0) {
      this.streams.delete(key)
      return
    }

    const trackedStreams = [...existing]
    this.streams.delete(key)

    // Cancel web streams, destroy node streams, and close handles
    for (const tracked of trackedStreams) {
      try {
        await tracked.webStream.cancel()
      } catch {
        // Ignore cancellation errors
      }
      try {
        tracked.nodeStream.destroy()
      } catch {
        // Ignore destruction errors
      }
      try {
        await tracked.handle.close()
      } catch {
        // Ignore handle close errors
      }
    }

    // Wait for all closedPromises to settle, bounded by timeout
    const closePromises = trackedStreams.map((tracked) => tracked.closedPromise)
    try {
      await withTimeout(Promise.all(closePromises), timeoutMs, 'Stream close timed out')
    } catch {
      // Proceed after the bounded wait even if a stream never settles.
    }
  }
}

export const mediaStreamRegistry = new StreamRegistry()

function createTrackedStream(
  nodeStream: Readable,
  filePath: string,
  handle: fs.FileHandle,
  registry: StreamRegistry
): ReadableStream<Uint8Array> {
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  registry.register(filePath, webStream, nodeStream, handle)

  const done = (): void => {
    registry.unregister(filePath, webStream)
  }
  nodeStream.once('end', done)
  nodeStream.once('close', done)
  nodeStream.once('error', done)

  return webStream
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

/**
 * Builds the `media://` handler. The caller wires it into
 * `protocol.handle(MEDIA_SCHEME, handler)` after `app.whenReady()`.
 */
export function createMediaHandler(
  options: MediaHandlerOptions
): (request: MediaRequestLike) => Promise<Response> {
  const registry = options.registry ?? mediaStreamRegistry

  return async function handleMediaRequest(request: MediaRequestLike): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return errorResponse(400, 'Invalid media URL')
    }

    if (url.protocol !== `${MEDIA_SCHEME}:` || url.host !== 'track') {
      return errorResponse(400, 'Invalid media URL format')
    }

    let trackId: string
    try {
      trackId = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return errorResponse(400, 'Malformed track ID encoding')
    }

    if (trackId.length === 0 || trackId.includes('/')) {
      return errorResponse(400, 'Missing track ID')
    }

    // Validate trackId format: 32-char lowercase hex
    if (!isValidTrackId(trackId)) {
      return errorResponse(400, 'Invalid track ID format')
    }

    const resolved = await options.resolveTrack(trackId)
    if (!resolved) {
      return errorResponse(404, 'Track not found')
    }

    if (!isPathWithinRoots(resolved.filePath, resolved.roots)) {
      return errorResponse(403, 'Path not authorized')
    }

    let stat
    try {
      stat = await fs.stat(resolved.filePath)
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code
      if (errno === 'ENOENT') {
        return errorResponse(404, 'File not found on disk')
      }
      if (errno === 'EACCES' || errno === 'EPERM') {
        return errorResponse(403, 'Permission denied')
      }
      return errorResponse(500, 'File system error')
    }

    if (!stat.isFile()) {
      return errorResponse(400, 'Not a file')
    }

    const fileSize = stat.size
    const mimeType = getMimeType(resolved.filePath)
    const rangeHeader = request.headers.get('range')

    if (fileSize === 0) {
      if (rangeHeader) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': 'bytes */0',
            'Accept-Ranges': 'bytes'
          }
        })
      }
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': '0',
          'Accept-Ranges': 'bytes'
        }
      })
    }

    if (!rangeHeader) {
      const handle = await fs.open(resolved.filePath, 'r')
      try {
        const nodeStream = handle.createReadStream({
          start: 0,
          end: fileSize - 1,
          autoClose: true
        })
        const body = createTrackedStream(nodeStream, resolved.filePath, handle, registry)
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      } catch (error) {
        await handle.close().catch(() => undefined)
        throw error
      }
    }

    const range = parseRangeHeader(rangeHeader, fileSize)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }

    const contentLength = range.end - range.start + 1
    const handle = await fs.open(resolved.filePath, 'r')
    try {
      const nodeStream = handle.createReadStream({
        start: range.start,
        end: range.end,
        autoClose: true
      })
      const body = createTrackedStream(nodeStream, resolved.filePath, handle, registry)
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(contentLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }
}

/**
 * Full pre-embed handshake:
 * 1. Ask the renderer to unload the `<audio>` element (bounded wait).
 * 2. Cancel and close every tracked `media://` stream for the path (bounded wait).
 *
 * Only after this resolves may the worker stage and swap the file.
 */
export async function abortStreamsForPath(
  filePath: string,
  options: AbortStreamsOptions = {}
): Promise<void> {
  if (options.requestUnload) {
    try {
      await withTimeout(
        options.requestUnload(),
        options.unloadTimeoutMs ?? 2000,
        'Renderer unload acknowledgement timed out'
      )
    } catch {
      // Proceed: a missing renderer acknowledgement must not block embedding.
    }
  }

  await (options.registry ?? mediaStreamRegistry).abortForPath(
    filePath,
    options.closeTimeoutMs ?? 3000
  )
}
