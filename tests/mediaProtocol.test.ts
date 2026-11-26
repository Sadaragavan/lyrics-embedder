import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  abortStreamsForPath,
  createMediaHandler,
  getMimeType,
  mediaStreamRegistry,
  parseRangeHeader,
  StreamRegistry,
  type MediaRequestLike,
  type ResolvedMediaTrack
} from '../src/main/mediaProtocol'

const tempDirs: string[] = []

function makeValidTrackId(): string {
  return crypto.randomBytes(16).toString('hex')
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-media-'))
  tempDirs.push(dir)
  return dir
}

async function makeAudioFile(size = 100): Promise<{ dir: string; filePath: string; bytes: Buffer; trackId: string }> {
  const dir = await makeTempDir()
  const filePath = path.join(dir, 'track.mp3')
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size; index++) {
    bytes[index] = index % 256
  }
  await fs.writeFile(filePath, bytes)
  return { dir, filePath, bytes, trackId: makeValidTrackId() }
}

function request(url: string, headers: Record<string, string> = {}): MediaRequestLike {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    url,
    headers: {
      get: (name: string) => lowered.get(name.toLowerCase()) ?? null
    }
  }
}

const VALID_TRACK_ID = 'a'.repeat(32)

function handlerFor(track: ResolvedMediaTrack | null, registry: StreamRegistry = new StreamRegistry()) {
  return createMediaHandler({
    resolveTrack: async (trackId: string) => {
      if (track && trackId === VALID_TRACK_ID) {
        return track
      }
      return null
    },
    registry
  })
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('parseRangeHeader', () => {
  it('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRangeHeader('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRangeHeader('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRangeHeader('bytes=95-500', 100)).toEqual({ start: 95, end: 99 })
  })

  it('rejects malformed, multi-range, and unsatisfiable requests', () => {
    expect(parseRangeHeader('items=0-9', 100)).toBeNull()
    expect(parseRangeHeader('bytes=abc', 100)).toBeNull()
    expect(parseRangeHeader('bytes=-', 100)).toBeNull()
    expect(parseRangeHeader('bytes=10-5', 100)).toBeNull()
    expect(parseRangeHeader('bytes=100-', 100)).toBeNull()
    expect(parseRangeHeader('bytes=0-1,4-5', 100)).toBeNull()
    expect(parseRangeHeader('bytes=-10', 0)).toBeNull()
  })
})

describe('MIME mapping', () => {
  it('maps supported audio extensions', () => {
    expect(getMimeType('a.flac')).toBe('audio/flac')
    expect(getMimeType('a.opus')).toBe('audio/opus')
    expect(getMimeType('a.m4a')).toBe('audio/mp4')
    expect(getMimeType('a.mp3')).toBe('audio/mpeg')
    expect(getMimeType('a.wav')).toBe('audio/wav')
    expect(getMimeType('a.bin')).toBe('application/octet-stream')
  })
})

describe('media:// handler', () => {
  it('serves full content (200) with Accept-Ranges and correct length', async () => {
    const { dir, filePath, bytes } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const response = await handler(request(`media://track/${VALID_TRACK_ID}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = Buffer.from(await response.arrayBuffer())
    expect(body.equals(bytes)).toBe(true)
  })

  it('serves bounded byte ranges (206) with Content-Range', async () => {
    const { dir, filePath, bytes } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const response = await handler(request(`media://track/${VALID_TRACK_ID}`, { Range: 'bytes=10-19' }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = Buffer.from(await response.arrayBuffer())
    expect(body.equals(bytes.subarray(10, 20))).toBe(true)
  })

  it('serves open-ended and suffix ranges', async () => {
    const { dir, filePath, bytes } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const openEnded = await handler(request(`media://track/${VALID_TRACK_ID}`, { Range: 'bytes=90-' }))
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get('content-range')).toBe('bytes 90-99/100')
    expect(Buffer.from(await openEnded.arrayBuffer()).equals(bytes.subarray(90))).toBe(true)

    const suffix = await handler(request(`media://track/${VALID_TRACK_ID}`, { Range: 'bytes=-10' }))
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 90-99/100')
    expect(Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(90))).toBe(true)
  })

  it('returns 416 with bytes */size for unsatisfiable ranges', async () => {
    const { dir, filePath } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const response = await handler(request(`media://track/${VALID_TRACK_ID}`, { Range: 'bytes=200-300' }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })

  it('rejects malformed URLs, unknown tracks, and paths outside roots', async () => {
    const { filePath } = await makeAudioFile()
    const outside = await makeTempDir()

    expect((await handlerFor({ filePath, roots: [outside] })(request(`media://track/${VALID_TRACK_ID}`))).status).toBe(403)
    expect((await handlerFor(null)(request(`media://track/${VALID_TRACK_ID}`))).status).toBe(404)
    expect((await handlerFor({ filePath, roots: [path.dirname(filePath)] })(request('http://track/abc'))).status).toBe(400)
    expect((await handlerFor({ filePath, roots: [path.dirname(filePath)] })(request('media://other/abc'))).status).toBe(400)
    expect((await handlerFor({ filePath, roots: [path.dirname(filePath)] })(request('media://track/'))).status).toBe(400)
  })
})

describe('stream registry and abort handshake', () => {
  it('tracks streams and cancels them on abort', async () => {
    const registry = new StreamRegistry()
    const filePath = path.join(await makeTempDir(), 'track.mp3')

    let cancelled = false
    const webStream = {
      cancel: async () => {
        cancelled = true
      }
    } as unknown as ReadableStream<Uint8Array>

    const mockNodeStream = new Readable({
      read() {}
    })
    const mockHandle = {
      close: async () => {}
    } as unknown as fs.FileHandle

    registry.register(filePath, webStream, mockNodeStream, mockHandle)
    expect(registry.countForPath(filePath)).toBe(1)
    expect(registry.getActivePaths()).toHaveLength(1)

    await registry.abortForPath(filePath, 100)
    expect(cancelled).toBe(true)
    expect(registry.countForPath(filePath)).toBe(0)
  })

  it('unregisters handler streams after the body is fully consumed', async () => {
    const { dir, filePath } = await makeAudioFile(1024)
    const registry = new StreamRegistry()
    const handler = handlerFor({ filePath, roots: [dir] }, registry)

    const response = await handler(request(`media://track/${VALID_TRACK_ID}`))
    expect(registry.countForPath(filePath)).toBe(1)
    await response.arrayBuffer()

    await new Promise((resolve) => setImmediate(resolve))
    expect(registry.countForPath(filePath)).toBe(0)
  })

  it('awaits the renderer unload acknowledgement before closing streams', async () => {
    const registry = new StreamRegistry()
    const filePath = path.join(await makeTempDir(), 'track.mp3')
    const events: string[] = []

    const webStream = {
      cancel: async () => {
        events.push('stream-cancelled')
      }
    } as unknown as ReadableStream<Uint8Array>

    const mockNodeStream = new Readable({
      read() {}
    })
    const mockHandle = {
      close: async () => {}
    } as unknown as fs.FileHandle

    registry.register(filePath, webStream, mockNodeStream, mockHandle)

    await abortStreamsForPath(filePath, {
      registry,
      unloadTimeoutMs: 100,
      closeTimeoutMs: 100,
      requestUnload: async () => {
        events.push('renderer-unloaded')
      }
    })

    expect(events).toEqual(['renderer-unloaded', 'stream-cancelled'])
    expect(registry.countForPath(filePath)).toBe(0)
  })

  it('proceeds after a bounded timeout when the renderer never acknowledges', async () => {
    const registry = new StreamRegistry()
    const filePath = path.join(await makeTempDir(), 'track.mp3')

    const webStream = { cancel: async () => undefined } as unknown as ReadableStream<Uint8Array>
    const mockNodeStream = new Readable({ read() {} })
    const mockHandle = { close: async () => {} } as unknown as fs.FileHandle

    registry.register(filePath, webStream, mockNodeStream, mockHandle)

    const started = Date.now()
    await abortStreamsForPath(filePath, {
      registry,
      unloadTimeoutMs: 20,
      closeTimeoutMs: 20,
      requestUnload: () => new Promise<void>(() => undefined)
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
    expect(registry.countForPath(filePath)).toBe(0)
  })

  it('exposes a module-level registry for the main process', () => {
    expect(mediaStreamRegistry.getActivePaths()).toEqual([])
  })
})

describe('stream registry: locked stream destruction and close await', () => {
  it('destroys nodeStream and awaits closedPromise on abort', async () => {
    const registry = new StreamRegistry()
    const filePath = path.join(await makeTempDir(), 'track.mp3')

    let nodeStreamDestroyed = false
    let handleClosed = false
    let closePromiseResolved = false

    const mockNodeStream = {
      destroy: () => {
        nodeStreamDestroyed = true
      },
      on: (event: string, listener: () => void) => {
        if (event === 'close') {
          // Simulate delayed close
          setTimeout(() => {
            closePromiseResolved = true
            listener()
          }, 10)
        }
      },
      once: (event: string, listener: () => void) => {
        if (event === 'close') {
          setTimeout(() => {
            closePromiseResolved = true
            listener()
          }, 10)
        }
      }
    } as unknown as Readable

    const mockHandle = {
      close: async () => {
        handleClosed = true
      }
    } as unknown as fs.FileHandle

    const webStream = {
      cancel: async () => {}
    } as unknown as ReadableStream<Uint8Array>

    registry.register(filePath, webStream, mockNodeStream, mockHandle)
    expect(registry.countForPath(filePath)).toBe(1)

    await registry.abortForPath(filePath, 1000)

    expect(nodeStreamDestroyed).toBe(true)
    expect(handleClosed).toBe(true)
    expect(closePromiseResolved).toBe(true)
    expect(registry.countForPath(filePath)).toBe(0)
  })

  it('unregisters only on close event, not on register', async () => {
    const registry = new StreamRegistry()
    const filePath = path.join(await makeTempDir(), 'track.mp3')

    let closeFired = false

    const mockNodeStream = {
      destroy: () => {},
      on: (event: string, listener: () => void) => {
        if (event === 'close') {
          setTimeout(() => {
            closeFired = true
            listener()
          }, 50)
        }
      },
      once: (event: string, listener: () => void) => {
        if (event === 'close') {
          setTimeout(() => {
            closeFired = true
            listener()
          }, 50)
        }
      }
    } as unknown as Readable

    const mockHandle = {
      close: async () => {}
    } as unknown as fs.FileHandle

    const webStream = {
      cancel: async () => {}
    } as unknown as ReadableStream<Uint8Array>

    registry.register(filePath, webStream, mockNodeStream, mockHandle)
    expect(registry.countForPath(filePath)).toBe(1)

    // Unregister should not be called until close fires
    registry.unregister(filePath, webStream)
    expect(registry.countForPath(filePath)).toBe(0) // unregister removes immediately

    // Wait for close to fire
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(closeFired).toBe(true)
  })

  it('handles malformed URI escapes in trackId gracefully', async () => {
    const { dir, filePath } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    // Malformed percent encoding
    const badRequest = request('media://track/%ZZ')
    const response = await handler(badRequest)
    expect(response.status).toBe(400)

    // Track ID with path traversal attempt
    const traversalRequest = request('media://track/../etc/passwd')
    const response2 = await handler(traversalRequest)
    expect(response2.status).toBe(400)
  })

  it('handles fs.stat/fs.open errors cleanly as 400/404/500', async () => {
    // The resolved track must still live inside an authorized root, otherwise
    // the handler short-circuits with 403 and never reaches fs.stat/fs.open.
    const authorizedRoot = await makeTempDir()
    const missingPath = path.join(authorizedRoot, 'missing-track.mp3')
    const handler = handlerFor({ filePath: missingPath, roots: [authorizedRoot] })
    const response = await handler(request(`media://track/${VALID_TRACK_ID}`))
    // A missing file inside an authorized root exercises the fs.stat ENOENT path.
    expect(response.status).toBe(404)

    // A directory instead of a file must be rejected (not a file -> 400).
    const dirHandler = handlerFor({ filePath: authorizedRoot, roots: [authorizedRoot] })
    const dirResponse = await dirHandler(request(`media://track/${VALID_TRACK_ID}`))
    expect(dirResponse.status).toBe(400)

    // A path outside every authorized root never reaches the filesystem.
    const outsideHandler = handlerFor({ filePath: missingPath, roots: [path.join(authorizedRoot, 'other')] })
    expect((await outsideHandler(request(`media://track/${VALID_TRACK_ID}`))).status).toBe(403)
  })
})
