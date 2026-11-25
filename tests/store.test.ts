import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeTrackId,
  createStore,
  readJson,
  writeJson,
  type JsonStore
} from '../src/main/store'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('atomic JSON primitives', () => {
  it('round-trips JSON and leaves no staging file behind', async () => {
    const dir = await makeTempDir()
    const target = path.join(dir, 'nested', 'value.json')

    await writeJson(target, { hello: 'world', count: 2 })
    expect(await readJson(target)).toEqual({ hello: 'world', count: 2 })

    const entries = await fs.readdir(path.dirname(target))
    expect(entries).toEqual(['value.json'])
  })

  it('returns null for a missing file and rejects corrupt JSON with the path', async () => {
    const dir = await makeTempDir()
    expect(await readJson(path.join(dir, 'missing.json'))).toBeNull()

    const corrupt = path.join(dir, 'corrupt.json')
    await fs.writeFile(corrupt, '{ not json', 'utf8')
    await expect(readJson(corrupt)).rejects.toThrow(/corrupt\.json/)
  })

  it('serializes concurrent atomic writes into valid JSON', async () => {
    const dir = await makeTempDir()
    const target = path.join(dir, 'concurrent.json')

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeJson(target, { index }))
    )

    const parsed = await readJson<{ index: number }>(target)
    expect(parsed).not.toBeNull()
    expect(typeof parsed!.index).toBe('number')

    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('library index persistence', () => {
  it('retries EBUSY/EPERM/EACCES rename failures with bounded backoff', async () => {
    const dir = await makeTempDir()
    let attempts = 0
    const codes = ['EBUSY', 'EPERM', 'EACCES']

    const store = createStore(dir, {
      retryOptions: { maxAttempts: 6, baseDelayMs: 1, maxDelayMs: 5 },
      rename: async (oldPath, newPath) => {
        attempts++
        if (attempts <= codes.length) {
          const error = new Error('locked') as NodeJS.ErrnoException
          error.code = codes[attempts - 1]
          throw error
        }
        await fs.rename(oldPath, newPath)
      }
    })

    await store.writeIndex({ roots: [], tracks: [] })
    expect(attempts).toBe(4)
    expect(await store.readIndex()).toEqual({ roots: [], tracks: [] })
  })

  it('adds, dedupes, and removes roots plus their tracks and drafts', async () => {
    const dir = await makeTempDir()
    const libraryRoot = await makeTempDir()
    const store = createStore(dir)

    const root = {
      id: computeTrackId(libraryRoot),
      path: libraryRoot,
      name: 'Music',
      addedAt: new Date().toISOString()
    }

    const first = await store.addRoot(root)
    const duplicate = await store.addRoot({ ...root, id: 'different-id', name: 'Duplicate' })
    expect(duplicate.id).toBe(first.id)
    expect(await store.getRoots()).toHaveLength(1)

    const trackId = 'a'.repeat(32)
    await store.upsertTracks([
      {
        id: trackId,
        filePath: path.join(libraryRoot, 'song.mp3'),
        format: 'MP3',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        durationSec: 10,
        lyrics: null,
        lyricsSource: 'none',
        existingLyricsKeys: [],
        libraryRootId: root.id,
        mtimeMs: 1
      }
    ])

    await store.saveDraft({ trackId, lyrics: '[00:01.00]Line' })
    expect(await store.getTrack(trackId)).not.toBeNull()

    expect(await store.removeRoot(root.id)).toBe(true)
    expect(await store.getRoots()).toEqual([])
    expect(await store.getTracks()).toEqual([])
    expect(await store.readDraft(trackId)).toBeNull()
  })
})

describe('per-track drafts', () => {
  it('stores drafts at drafts/<trackId>.json and supports CRUD', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Artist\\Track.flac')

    const saved = await store.saveDraft({ trackId, lyrics: '[00:00.00]Hello' })
    expect(saved.id).toBe(trackId)
    expect(saved.trackId).toBe(trackId)
    expect(saved.status).toBe('pending')

    const draftPath = path.join(dir, 'drafts', `${trackId}.json`)
    const onDisk = JSON.parse(await fs.readFile(draftPath, 'utf8'))
    expect(onDisk.lyrics).toBe('[00:00.00]Hello')

    const loaded = await store.readDraft(trackId)
    expect(loaded?.lyrics).toBe('[00:00.00]Hello')

    const updated = await store.saveDraft({ trackId, lyrics: 'new', status: 'synced' })
    expect(updated.status).toBe('synced')

    expect(await store.deleteDraft(trackId)).toBe(true)
    expect(await store.deleteDraft(trackId)).toBe(false)
    expect(await store.readDraft(trackId)).toBeNull()
  })

  it('rejects drafts without a track id', async () => {
    const dir = await makeTempDir()
    const store: JsonStore = createStore(dir)
    await expect(store.saveDraft({ trackId: '', lyrics: 'x' })).rejects.toThrow(/trackId/)
  })
})

describe('startup temp sweep', () => {
  it('recursively removes *.lrcembed.*.tmp.* only, without following symlinks', async () => {
    const dir = await makeTempDir()
    const libraryRoot = await makeTempDir()
    const nested = path.join(libraryRoot, 'nested')
    await fs.mkdir(nested)

    const stale = path.join(libraryRoot, 'song.lrcembed.123.tmp.mp3')
    const staleNested = path.join(nested, 'track.lrcembed.99999.tmp.flac')
    const keep = path.join(libraryRoot, 'song.tmp.mp3')
    await fs.writeFile(stale, 'x')
    await fs.writeFile(staleNested, 'x')
    await fs.writeFile(keep, 'x')

    const store = createStore(dir)
    await store.addRoot({
      id: computeTrackId(libraryRoot),
      path: libraryRoot,
      name: 'Root',
      addedAt: new Date().toISOString()
    })

    const removed = await store.initialize()
    expect(removed.sort()).toEqual([stale, staleNested].sort())
    await expect(fs.stat(stale)).rejects.toThrow()
    await expect(fs.stat(staleNested)).rejects.toThrow()
    expect((await fs.stat(keep)).isFile()).toBe(true)
    expect((await fs.stat(path.join(dir, 'drafts'))).isDirectory()).toBe(true)
  })
})
