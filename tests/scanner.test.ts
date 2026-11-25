import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAudioLibrary, walkAudioFiles, type ScanProgressUpdate } from '../src/main/scanner'
import { computeTrackId } from '../src/main/utils/trackId'
import type { TrackMetadata } from '../src/shared/ipc'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-scan-'))
  tempDirs.push(dir)
  return dir
}

async function writeFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, 'placeholder', 'utf8')
}

function fakeMetadata(filePath: string): TrackMetadata {
  return {
    filePath,
    format: path.extname(filePath).slice(1).toUpperCase(),
    title: path.basename(filePath),
    artist: 'Artist',
    album: 'Album',
    durationSec: 12,
    lyrics: null,
    lyricsSource: 'none',
    existingLyricsKeys: []
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('walkAudioFiles', () => {
  it('recurses, filters supported extensions case-insensitively, and sorts results', async () => {
    const root = await makeTempDir()
    const audioFiles = [
      path.join(root, 'a.mp3'),
      path.join(root, 'nested', 'b.flac'),
      path.join(root, 'nested', 'deep', 'c.OPUS'),
      path.join(root, 'd.m4a'),
      path.join(root, 'e.wav')
    ]
    const ignored = [
      path.join(root, 'notes.txt'),
      path.join(root, 'cover.jpg'),
      path.join(root, 'nested', 'track.lrc')
    ]

    for (const file of [...audioFiles, ...ignored]) {
      await writeFile(file)
    }

    const found = await walkAudioFiles(root)
    expect(found.sort()).toEqual(audioFiles.sort())
  })

  it('honors a custom extension filter', async () => {
    const root = await makeTempDir()
    await writeFile(path.join(root, 'a.mp3'))
    await writeFile(path.join(root, 'b.flac'))

    expect(await walkAudioFiles(root, ['.mp3'])).toEqual([path.join(root, 'a.mp3')])
  })

  it('does not follow directory symlinks', async (context) => {
    const root = await makeTempDir()
    const outside = await makeTempDir()
    await writeFile(path.join(root, 'inside.mp3'))
    await writeFile(path.join(outside, 'outside.mp3'))

    const linkPath = path.join(root, 'linked-outside')
    try {
      await fs.symlink(outside, linkPath, 'dir')
    } catch {
      context.skip()
      return
    }

    const found = await walkAudioFiles(root)
    expect(found).toEqual([path.join(root, 'inside.mp3')])
  })

  it('returns an empty array for a missing root', async () => {
    const root = await makeTempDir()
    expect(await walkAudioFiles(path.join(root, 'does-not-exist'))).toEqual([])
  })
})

describe('scanAudioLibrary', () => {
  it('builds deterministic TrackRecords and reports monotonic progress', async () => {
    const root = await makeTempDir()
    const files = [
      path.join(root, 'one.mp3'),
      path.join(root, 'sub', 'two.flac'),
      path.join(root, 'sub', 'three.m4a')
    ]
    for (const file of files) {
      await writeFile(file)
    }

    const progress: ScanProgressUpdate[] = []
    const tracks = await scanAudioLibrary(root, {
      rootId: 'root-1',
      readMetadata: async (filePath) => fakeMetadata(filePath),
      onProgress: (update) => progress.push(update)
    })

    expect(tracks).toHaveLength(3)
    expect(tracks.map((track) => track.filePath).sort()).toEqual(files.sort())
    for (const track of tracks) {
      expect(track.id).toBe(computeTrackId(track.filePath))
      expect(track.libraryRootId).toBe('root-1')
      expect(typeof track.mtimeMs).toBe('number')
      expect(track.title).toBe(path.basename(track.filePath))
    }

    expect(progress[0]).toMatchObject({ processed: 0, total: 3, errors: 0 })
    const last = progress.at(-1)!
    expect(last.processed).toBe(3)
    expect(last.total).toBe(3)
    expect(progress.map((entry) => entry.processed)).toEqual([0, 1, 2, 3])
  })

  it('counts unreadable files as errors and continues scanning', async () => {
    const root = await makeTempDir()
    const good = path.join(root, 'good.mp3')
    const bad = path.join(root, 'bad.flac')
    await writeFile(good)
    await writeFile(bad)

    let errors = 0
    const tracks = await scanAudioLibrary(root, {
      rootId: 'root-1',
      readMetadata: async (filePath) => {
        if (filePath === bad) throw new Error('corrupt')
        return fakeMetadata(filePath)
      },
      onProgress: (update) => {
        errors = update.errors
      }
    })

    expect(tracks).toHaveLength(1)
    expect(tracks[0]?.filePath).toBe(good)
    expect(errors).toBe(1)
  })
})

describe('walkAudioFiles excludes *.lrcembed.*.tmp.* files', () => {
  it('skips staging temp files matching *.lrcembed.*.tmp.* pattern', async () => {
    const root = await makeTempDir()
    const audioFiles = [
      path.join(root, 'track1.mp3'),
      path.join(root, 'track2.flac')
    ]
    const tempFiles = [
      path.join(root, 'track1.lrcembed.1234.tmp.mp3'),
      path.join(root, 'track2.lrcembed.5678.tmp.flac'),
      path.join(root, 'nested', 'track3.lrcembed.99999.tmp.mp3')
    ]

    for (const file of [...audioFiles, ...tempFiles]) {
      await writeFile(file)
    }

    const found = await walkAudioFiles(root)
    expect(found.sort()).toEqual(audioFiles.sort())
    for (const tempFile of tempFiles) {
      expect(found).not.toContain(tempFile)
    }
  })

  it('does not exclude unrelated .tmp files with non-audio extensions', async () => {
    const root = await makeTempDir()
    const audioFiles = [path.join(root, 'track.mp3')]
    // These have non-audio extensions so they won't be included anyway
    const unrelatedTemp = [path.join(root, 'track.tmp.txt'), path.join(root, 'song.lrcembed.txt')]

    for (const file of [...audioFiles, ...unrelatedTemp]) {
      await writeFile(file)
    }

    const found = await walkAudioFiles(root)
    expect(found.sort()).toEqual(audioFiles.sort())
    for (const tempFile of unrelatedTemp) {
      expect(found).not.toContain(tempFile)
    }
  })

  it('includes audio files with .tmp in name but valid audio extension', async () => {
    const root = await makeTempDir()
    const audioFiles = [
      path.join(root, 'track.mp3'),
      path.join(root, 'track.tmp.mp3')  // Valid audio extension, should be included
    ]
    const tempFiles = [
      path.join(root, 'track.lrcembed.1234.tmp.mp3')  // Should be excluded
    ]

    for (const file of [...audioFiles, ...tempFiles]) {
      await writeFile(file)
    }

    const found = await walkAudioFiles(root)
    expect(found.sort()).toEqual(audioFiles.sort())
    for (const tempFile of tempFiles) {
      expect(found).not.toContain(tempFile)
    }
  })
})
