import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  LocalSidecarProvider,
  importLrcFile,
  getSidecarPath
} from '../src/main/providers/localSidecar'
import type { LyricsQuery } from '../src/shared/types'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-sidecar-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

function makeQuery(overrides: Partial<LyricsQuery> = {}): LyricsQuery {
  return {
    trackId: 'b'.repeat(32),
    title: 'Test Song',
    artist: 'Test Artist',
    album: 'Test Album',
    durationSec: 180,
    filePath: path.join(path.sep, 'music', 'song.flac'),
    ...overrides
  }
}

function makeStat(
  overrides: Partial<{ isSymbolicLink: boolean; isFile: boolean; size: number }> = {}
) {
  return {
    isSymbolicLink: () => overrides.isSymbolicLink ?? false,
    isFile: () => overrides.isFile ?? true,
    size: overrides.size ?? 100
  }
}

describe('getSidecarPath', () => {
  it('replaces audio extension with .lrc using native path separators', () => {
    const flac = path.join('music', 'song.flac')
    const mp3 = path.join('music', 'track.mp3')
    expect(getSidecarPath(flac)).toBe(path.join('music', 'song.lrc'))
    expect(getSidecarPath(mp3)).toBe(path.join('music', 'track.lrc'))
  })
})

describe('LocalSidecarProvider', () => {
  it('returns synced lyrics from sibling .lrc file with higher score than remote', async () => {
    const provider = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('[00:01.00]Hello'),
      lstat: vi.fn().mockResolvedValue(makeStat())
    })

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.providerId).toBe('localSidecar')
    expect(result!.syncedLyrics).toBe('[00:01.00]Hello')
    expect(result!.plainLyrics).toBeNull()
    expect(result!.score).toBe(100)
  })

  it('returns plain lyrics when no timestamps found', async () => {
    const provider = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('Just plain text lyrics'),
      lstat: vi.fn().mockResolvedValue(makeStat())
    })

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBeNull()
    expect(result!.plainLyrics).toBe('Just plain text lyrics')
    expect(result!.score).toBe(6)
    expect(result!.timingKind).toBe('plain')
  })

  it('reads real UTF-8 BOM sibling .lrc file from disk', async () => {
    const dir = await makeTempDir()
    const audioPath = path.join(dir, 'track.flac')
    const lrcPath = path.join(dir, 'track.lrc')
    await fs.writeFile(audioPath, 'audio')
    await fs.writeFile(lrcPath, '\uFEFF[00:01.00]Disk BOM line', 'utf8')

    const provider = new LocalSidecarProvider()
    const result = await provider.fetch(makeQuery({ filePath: audioPath }))
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBe('[00:01.00]Disk BOM line')
  })

  it('returns null when sidecar does not exist', async () => {
    const provider = new LocalSidecarProvider({
      readFile: vi.fn(),
      lstat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const result = await provider.fetch(makeQuery())
    expect(result).toBeNull()
  })

  it('rejects symlinks', async () => {
    const provider = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('[00:01.00]Hello'),
      lstat: vi.fn().mockResolvedValue(makeStat({ isSymbolicLink: true }))
    })

    const result = await provider.fetch(makeQuery())
    expect(result).toBeNull()
  })

  it('rejects files > 1 MiB (by stat size or byte length)', async () => {
    const providerByStat = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('x'),
      lstat: vi.fn().mockResolvedValue(makeStat({ size: 1024 * 1024 + 1 }))
    })
    expect(await providerByStat.fetch(makeQuery())).toBeNull()

    const providerByBytes = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('x'.repeat(1024 * 1024 + 1)),
      lstat: vi.fn().mockResolvedValue(makeStat({ size: 10 }))
    })
    expect(await providerByBytes.fetch(makeQuery())).toBeNull()
  })

  it('strips UTF-8 BOM', async () => {
    const provider = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('\uFEFF[00:01.00]BOM line'),
      lstat: vi.fn().mockResolvedValue(makeStat())
    })

    const result = await provider.fetch(makeQuery())
    expect(result).not.toBeNull()
    expect(result!.syncedLyrics).toBe('[00:01.00]BOM line')
  })

  it('returns null for empty sidecar', async () => {
    const provider = new LocalSidecarProvider({
      readFile: vi.fn().mockResolvedValue('  \n  '),
      lstat: vi.fn().mockResolvedValue(makeStat())
    })

    const result = await provider.fetch(makeQuery())
    expect(result).toBeNull()
  })
})

describe('importLrcFile', () => {
  it('reads a valid .lrc file', async () => {
    const result = await importLrcFile('/path/to/lyrics.lrc', {
      readFile: vi.fn().mockResolvedValue('\uFEFF[00:01.00]Imported'),
      lstat: vi.fn().mockResolvedValue(makeStat())
    })
    expect(result).toBe('[00:01.00]Imported')
  })

  it('rejects non-.lrc extensions', async () => {
    const result = await importLrcFile('/path/to/lyrics.txt', {
      readFile: vi.fn().mockResolvedValue('content'),
      lstat: vi.fn().mockResolvedValue(makeStat())
    })
    expect(result).toBeNull()
  })

  it('rejects symlinks', async () => {
    const result = await importLrcFile('/path/to/lyrics.lrc', {
      readFile: vi.fn().mockResolvedValue('content'),
      lstat: vi.fn().mockResolvedValue(makeStat({ isSymbolicLink: true }))
    })
    expect(result).toBeNull()
  })

  it('rejects files > 1 MiB', async () => {
    const result = await importLrcFile('/path/to/lyrics.lrc', {
      readFile: vi.fn().mockResolvedValue('content'),
      lstat: vi.fn().mockResolvedValue(makeStat({ size: 2 * 1024 * 1024 }))
    })
    expect(result).toBeNull()
  })

  it('returns null when file does not exist', async () => {
    const result = await importLrcFile('/path/to/lyrics.lrc', {
      readFile: vi.fn(),
      lstat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })
    expect(result).toBeNull()
  })
})
