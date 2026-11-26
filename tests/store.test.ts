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

  it('persists translation + romanization layers alongside the primary lyrics', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Layers.flac')

    await store.saveDraft({
      trackId,
      lyrics: '[00:01.00]Hello',
      translation: '[00:01.00]Hola',
      romanization: '[00:01.00]Haro'
    })

    const draftPath = path.join(dir, 'drafts', `${trackId}.json`)
    const onDisk = JSON.parse(await fs.readFile(draftPath, 'utf8'))
    expect(onDisk.translation).toBe('[00:01.00]Hola')
    expect(onDisk.romanization).toBe('[00:01.00]Haro')

    const loaded = await store.readDraft(trackId)
    expect(loaded).toMatchObject({
      lyrics: '[00:01.00]Hello',
      translation: '[00:01.00]Hola',
      romanization: '[00:01.00]Haro'
    })

    // Empty layers are not written at all, so a single-layer draft stays small.
    await store.saveDraft({ trackId, lyrics: 'x', translation: '', romanization: '  ' })
    const cleared = JSON.parse(await fs.readFile(draftPath, 'utf8'))
    expect(cleared.translation).toBeUndefined()
    expect(cleared.romanization).toBeUndefined()
  })

  it('reads legacy single-layer drafts without layer fields', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Legacy.flac')
    const draftDir = path.join(dir, 'drafts')
    await fs.mkdir(draftDir, { recursive: true })
    await fs.writeFile(
      path.join(draftDir, `${trackId}.json`),
      JSON.stringify({ id: trackId, trackId, lyrics: '[00:02.00]Old', status: 'pending' }),
      'utf8'
    )

    const loaded = await store.readDraft(trackId)
    expect(loaded?.lyrics).toBe('[00:02.00]Old')
    expect(loaded?.translation).toBeUndefined()
    expect(loaded?.romanization).toBeUndefined()
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

describe('trackId validation in store operations', () => {
  it('rejects invalid trackId in draftPath', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)

    await expect(store.readDraft('invalid')).rejects.toThrow(/Invalid trackId format/)
    await expect(store.saveDraft({ trackId: 'invalid', lyrics: 'x' })).rejects.toThrow(/Invalid trackId format/)
    await expect(store.deleteDraft('invalid')).rejects.toThrow(/Invalid trackId format/)
    await expect(store.getTrack('invalid')).resolves.toBeNull() // getTrack doesn't validate format
  })

  it('accepts valid trackId format', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const validTrackId = 'a'.repeat(32)

    // Should not throw
    await store.saveDraft({ trackId: validTrackId, lyrics: 'test' })
    expect(await store.readDraft(validTrackId)).not.toBeNull()
    expect(await store.deleteDraft(validTrackId)).toBe(true)
  })
})

describe('JsonStore concurrent write serialization', () => {
  it('serializes concurrent writes via internal promise queue', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Track.flac')

    // Fire multiple concurrent upsertTracks calls
    const promises = Array.from({ length: 10 }, (_, i) =>
      store.upsertTracks([{
        id: trackId,
        filePath: `C:\\Music\\Track${i}.flac`,
        format: 'FLAC',
        title: `Track ${i}`,
        artist: 'Artist',
        album: 'Album',
        durationSec: 10,
        lyrics: null,
        lyricsSource: 'none',
        existingLyricsKeys: [],
        libraryRootId: 'root-1',
        mtimeMs: 1
      }])
    )

    await Promise.all(promises)

    const tracks = await store.getTracks()
    expect(tracks).toHaveLength(1)
  })

  it('serializes concurrent root additions', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const rootPath = await makeTempDir()

    const promises = Array.from({ length: 5 }, (_, i) =>
      store.addRoot({
        id: `root-${i}`,
        path: rootPath,
        name: `Root ${i}`,
        addedAt: new Date().toISOString()
      })
    )

    const roots = await Promise.all(promises)
    expect(roots).toHaveLength(5)
    expect(roots.every(r => r.id === roots[0].id)).toBe(true)
    expect((await store.getRoots())).toHaveLength(1)
  })
})

describe('JsonStore draftId preservation', () => {
  it('preserves existing draftId when upserting tracks without draftId', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Track.flac')

    // First, create a track with a draftId
    await store.upsertTracks([{
      id: trackId,
      filePath: 'C:\\Music\\Track.flac',
      format: 'FLAC',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      durationSec: 10,
      lyrics: null,
      lyricsSource: 'none',
      existingLyricsKeys: [],
      libraryRootId: 'root-1',
      mtimeMs: 1,
      draftId: 'existing-draft-id'
    }])

    // Then upsert the same track without draftId
    await store.upsertTracks([{
      id: trackId,
      filePath: 'C:\\Music\\Track.flac',
      format: 'FLAC',
      title: 'Updated Track',
      artist: 'Artist',
      album: 'Album',
      durationSec: 10,
      lyrics: null,
      lyricsSource: 'none',
      existingLyricsKeys: [],
      libraryRootId: 'root-1',
      mtimeMs: 2
      // no draftId
    }])

    const track = await store.getTrack(trackId)
    expect(track?.draftId).toBe('existing-draft-id')
  })

  it('updates draftId when upserting track with new draftId', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Track.flac')

    await store.upsertTracks([{
      id: trackId,
      filePath: 'C:\\Music\\Track.flac',
      format: 'FLAC',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      durationSec: 10,
      lyrics: null,
      lyricsSource: 'none',
      existingLyricsKeys: [],
      libraryRootId: 'root-1',
      mtimeMs: 1,
      draftId: 'old-draft-id'
    }])

    await store.upsertTracks([{
      id: trackId,
      filePath: 'C:\\Music\\Track.flac',
      format: 'FLAC',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      durationSec: 10,
      lyrics: null,
      lyricsSource: 'none',
      existingLyricsKeys: [],
      libraryRootId: 'root-1',
      mtimeMs: 2,
      draftId: 'new-draft-id'
    }])

    const track = await store.getTrack(trackId)
    expect(track?.draftId).toBe('new-draft-id')
  })

  it('clears track.draftId when deleteDraft is called', async () => {
    const dir = await makeTempDir()
    const store = createStore(dir)
    const trackId = computeTrackId('C:\\Music\\Track.flac')

    await store.upsertTracks([{
      id: trackId,
      filePath: 'C:\\Music\\Track.flac',
      format: 'FLAC',
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      durationSec: 10,
      lyrics: null,
      lyricsSource: 'none',
      existingLyricsKeys: [],
      libraryRootId: 'root-1',
      mtimeMs: 1,
      draftId: 'draft-to-delete'
    }])

    await store.saveDraft({ trackId, lyrics: '[00:01.00]Test' })
    await store.deleteDraft(trackId)

    const track = await store.getTrack(trackId)
    expect(track?.draftId).toBeUndefined()
  })
})

describe('initialize purges orphaned *.tmp files in userData', () => {
  it('removes *.lrcembed.*.tmp.* from userData on initialize', async () => {
    const dir = await makeTempDir()
    const draftsDir = path.join(dir, 'drafts')
    await fs.mkdir(draftsDir, { recursive: true })

    const stale = path.join(draftsDir, 'song.lrcembed.123.tmp.json')
    const keep = path.join(draftsDir, 'normal.json')
    await fs.writeFile(stale, 'x')
    await fs.writeFile(keep, 'x')

    const store = createStore(dir)
    const removed = await store.initialize()

    expect(removed).toContain(stale)
    await expect(fs.stat(stale)).rejects.toThrow()
    expect((await fs.stat(keep)).isFile()).toBe(true)
  })
})
