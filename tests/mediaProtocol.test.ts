import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-media-'))
  tempDirs.push(dir)
  return dir
}

async function makeAudioFile(size = 100): Promise<{ dir: string; filePath: string; bytes: Buffer }> {
  const dir = await makeTempDir()
  const filePath = path.join(dir, 'track.mp3')
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size; index++) {
    bytes[index] = index % 256
  }
  await fs.writeFile(filePath, bytes)
  return { dir, filePath, bytes }
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

function handlerFor(track: ResolvedMediaTrack | null, registry: StreamRegistry = new StreamRegistry()) {
  return createMediaHandler({
    resolveTrack: async () => track,
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

    const response = await handler(request('media://track/abc'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe(String(bytes.length))

    const body = Buffer.from(await response.arrayBuffer())
    expect(body.equals(bytes)).toBe(true)
  })

  it('serves bounded byte ranges (206) with Content-Range', async () => {
    const { dir, filePath, bytes } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const response = await handler(request('media://track/abc', { Range: 'bytes=10-19' }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(response.headers.get('content-length')).toBe('10')

    const body = Buffer.from(await response.arrayBuffer())
    expect(body.equals(bytes.subarray(10, 20))).toBe(true)
  })

  it('serves open-ended and suffix ranges', async () => {
    const { dir, filePath, bytes } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const openEnded = await handler(request('media://track/abc', { Range: 'bytes=90-' }))
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get('content-range')).toBe('bytes 90-99/100')
    expect(Buffer.from(await openEnded.arrayBuffer()).equals(bytes.subarray(90))).toBe(true)

    const suffix = await handler(request('media://track/abc', { Range: 'bytes=-10' }))
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 90-99/100')
    expect(Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(90))).toBe(true)
  })

  it('returns 416 with bytes */size for unsatisfiable ranges', async () => {
    const { dir, filePath } = await makeAudioFile()
    const handler = handlerFor({ filePath, roots: [dir] })

    const response = await handler(request('media://track/abc', { Range: 'bytes=200-300' }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })

  it('rejects malformed URLs, unknown tracks, and paths outside roots', async () => {
    const { filePath } = await makeAudioFile()
    const outside = await makeTempDir()

    expect((await handlerFor({ filePath, roots: [outside] })(request('media://track/abc'))).status).toBe(403)
    expect((await handlerFor(null)(request('media://track/abc'))).status).toBe(404)
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
    const stream = {
      cancel: async () => {
        cancelled = true
      }
    } as unknown as ReadableStream<Uint8Array>

    registry.register(filePath, stream)
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

    const response = await handler(request('media://track/abc'))
    expect(registry.countForPath(filePath)).toBe(1)
    await response.arrayBuffer()

    await new Promise((resolve) => setImmediate(resolve))
    expect(registry.countForPath(filePath)).toBe(0)
  })

  it('awaits the renderer unload acknowledgement before closing streams', async () => {
    const registry = new StreamRegistry()
    const filePath = path.join(await makeTempDir(), 'track.mp3')
    const events: string[] = []

    const stream = {
      cancel: async () => {
        events.push('stream-cancelled')
      }
    } as unknown as ReadableStream<Uint8Array>
    registry.register(filePath, stream)

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
    const stream = { cancel: async () => undefined } as unknown as ReadableStream<Uint8Array>
    registry.register(filePath, stream)

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
