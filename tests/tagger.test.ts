import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TagLib } from 'taglib-wasm'
import {
  AudioTagger,
  buildTempPath,
  cleanupStaleTempFiles,
  getSidecarLrcPath,
  isLrcEmbedTempFile,
  retryOnLockError
} from '../src/main/tagger'
import { resolveTaglibWasmPath } from '../src/main/wasmPath'

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures')

function makeUsltFrameBody(lang: string, description: string, text: string): Uint8Array {
  const encoding = Buffer.from([0x03]) // UTF-8
  const langBytes = Buffer.from(lang.padEnd(3, ' ').slice(0, 3), 'ascii')
  const descBytes = Buffer.from(`${description}\0`, 'utf8')
  const textBytes = Buffer.from(text, 'utf8')
  return new Uint8Array(Buffer.concat([encoding, langBytes, descBytes, textBytes]))
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

describe('wasmPath resolution', () => {
  it('resolves existing taglib-wasi.wasm in dev mode without unexported subpath imports', async () => {
    const wasmPath = resolveTaglibWasmPath({ isPackaged: false })
    expect(path.basename(wasmPath)).toBe('taglib-wasi.wasm')
    const stat = await fs.stat(wasmPath)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(100_000)
  })

  it('resolves app.asar.unpacked path in packaged mode', () => {
    const resourcesPath = path.join('C:', 'Program Files', 'App', 'resources')
    const packagedPath = resolveTaglibWasmPath({
      isPackaged: true,
      resourcesPath
    })
    expect(packagedPath).toBe(
      path.join(
        resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'taglib-wasm',
        'dist',
        'taglib-wasi.wasm'
      )
    )
  })

  it('throws in packaged mode when resourcesPath is missing', () => {
    expect(() => resolveTaglibWasmPath({ isPackaged: true })).toThrow(/resourcesPath/)
  })
})

describe('AudioTagger WASI round-trip & Windows safety', () => {
  let tagger: AudioTagger
  let rawTaglib: TagLib
  const tempDirs: string[] = []

  async function createTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-test-'))
    tempDirs.push(dir)
    return dir
  }

  beforeAll(async () => {
    const wasmUrl = resolveTaglibWasmPath()
    tagger = await AudioTagger.create({ wasmUrl })
    rawTaglib = await TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })
  })

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    // TagLib instances hold no persistent background handles.
  })

  it.each([
    { fileName: 'sample.flac', expectedFormat: 'FLAC' },
    { fileName: 'sample.opus', expectedFormat: 'OPUS' },
    { fileName: 'sample.m4a', expectedFormat: 'MP4' },
    { fileName: 'sample.mp3', expectedFormat: 'MP3' }
  ])(
    'round-trips synced lyrics, preserves metadata & mtime, and leaves no temp files for $fileName',
    async ({ fileName, expectedFormat }) => {
      const dir = await createTempDir()
      const trackPath = path.join(dir, fileName)
      await fs.copyFile(path.join(FIXTURES_DIR, fileName), trackPath)

      const oldAtime = new Date('2022-03-10T08:00:00.000Z')
      const oldMtime = new Date('2022-05-15T14:22:33.000Z')
      await fs.utimes(trackPath, oldAtime, oldMtime)
      const statBefore = await fs.stat(trackPath)

      const initial = await tagger.readTrackMetadata(trackPath)
      expect(initial.format).toBe(expectedFormat)
      expect(initial.title).toBe('Fixture Track')
      expect(initial.artist).toBe('Fixture Artist')
      expect(initial.lyrics).toBeNull()
      expect(initial.lyricsSource).toBe('none')

      const lrcPayload = '[00:01.25]First line\n[00:04.50]Second line 日本語'
      const writeResult = await tagger.embedLyrics(trackPath, lrcPayload)
      expect(writeResult.verified).toBe(true)
      expect(writeResult.lyricsSource).toBe('tag')
      expect(writeResult.targetPath).toBe(trackPath)

      const statAfter = await fs.stat(trackPath)
      expect(Math.abs(statAfter.mtimeMs - statBefore.mtimeMs)).toBeLessThan(10)

      const afterWrite = await tagger.readTrackMetadata(trackPath)
      expect(afterWrite.title).toBe('Fixture Track')
      expect(afterWrite.artist).toBe('Fixture Artist')
      expect(afterWrite.lyrics).toBe(lrcPayload)
      expect(afterWrite.lyricsSource).toBe('tag')

      const updatedPayload = '[00:00.50]Updated lyric line'
      await tagger.embedLyrics(trackPath, updatedPayload)
      const afterUpdate = await tagger.readTrackMetadata(trackPath)
      expect(afterUpdate.lyrics).toBe(updatedPayload)

      await tagger.embedLyrics(trackPath, '')
      const afterClear = await tagger.readTrackMetadata(trackPath)
      expect(afterClear.lyrics).toBeNull()
      expect(afterClear.lyricsSource).toBe('none')
      expect(afterClear.existingLyricsKeys).toEqual([])

      const dirEntries = await fs.readdir(dir)
      expect(dirEntries).toEqual([fileName])
    }
  )

  it('strips custom LYRICS:* USLT frames on MP3 and replaces without duplicates', async () => {
    const dir = await createTempDir()
    const mp3Path = path.join(dir, 'custom-uslt.mp3')
    await fs.copyFile(path.join(FIXTURES_DIR, 'sample.mp3'), mp3Path)

    const seeded = await rawTaglib.open(mp3Path)
    try {
      seeded.setId3v2Frames('USLT', [
        makeUsltFrameBody('eng', 'custom', '[00:02.00]Legacy custom frame'),
        makeUsltFrameBody('jpn', 'alt', '[00:03.00]Legacy alt frame')
      ])
      await seeded.saveToFile()
    } finally {
      seeded.dispose()
    }

    const before = await tagger.readTrackMetadata(mp3Path)
    expect(before.lyricsSource).toBe('tag')
    expect(before.existingLyricsKeys.some((k) => k.startsWith('LYRICS:'))).toBe(true)

    const replacement = '[00:01.00]Clean Poweramp Line'
    await tagger.embedLyrics(mp3Path, replacement)

    const after = await tagger.readTrackMetadata(mp3Path)
    expect(after.lyrics).toBe(replacement)
    expect(after.existingLyricsKeys).toEqual(['LYRICS'])

    const inspected = await rawTaglib.open(mp3Path)
    try {
      const remainingCustomKeys = Object.keys(inspected.properties()).filter((k) =>
        k.toUpperCase().startsWith('LYRICS:')
      )
      expect(remainingCustomKeys).toEqual([])
      expect(inspected.getLyrics().map((entry) => entry.text)).toEqual([replacement])
      expect(inspected.getId3v2Frames('USLT')).toHaveLength(1)
    } finally {
      inspected.dispose()
    }
  })

  it('writes UTF-8 sibling .lrc sidecar for .wav without mutating WAV bytes or mtime', async () => {
    const dir = await createTempDir()
    const wavPath = path.join(dir, 'sample.wav')
    await fs.copyFile(path.join(FIXTURES_DIR, 'sample.wav'), wavPath)

    const oldTime = new Date('2021-11-20T09:15:00.000Z')
    await fs.utimes(wavPath, oldTime, oldTime)
    const wavStatBefore = await fs.stat(wavPath)
    const wavHashBefore = await sha256File(wavPath)

    const lrcText = '[00:01.00]WAV sidecar line\n[00:05.00]Line two'
    const result = await tagger.embedLyrics(wavPath, lrcText)

    const expectedSidecar = getSidecarLrcPath(wavPath)
    expect(result.lyricsSource).toBe('sidecar')
    expect(result.targetPath).toBe(expectedSidecar)
    expect(await fs.readFile(expectedSidecar, 'utf8')).toBe(lrcText)

    const wavStatAfter = await fs.stat(wavPath)
    const wavHashAfter = await sha256File(wavPath)
    expect(wavHashAfter).toBe(wavHashBefore)
    expect(wavStatAfter.mtimeMs).toBe(wavStatBefore.mtimeMs)

    const metadata = await tagger.readTrackMetadata(wavPath)
    expect(metadata.lyrics).toBe(lrcText)
    expect(metadata.lyricsSource).toBe('sidecar')
  })

  it('serializes concurrent writes sequentially without corrupting tags', async () => {
    const dir = await createTempDir()
    const files = await Promise.all(
      ['a.flac', 'b.mp3', 'c.m4a'].map(async (targetName, idx) => {
        const srcName = idx === 0 ? 'sample.flac' : idx === 1 ? 'sample.mp3' : 'sample.m4a'
        const dest = path.join(dir, targetName)
        await fs.copyFile(path.join(FIXTURES_DIR, srcName), dest)
        return dest
      })
    )

    await Promise.all([
      tagger.embedLyrics(files[0], '[00:01.00]Track A'),
      tagger.embedLyrics(files[1], '[00:01.00]Track B'),
      tagger.embedLyrics(files[2], '[00:01.00]Track C')
    ])

    expect((await tagger.readTrackMetadata(files[0])).lyrics).toBe('[00:01.00]Track A')
    expect((await tagger.readTrackMetadata(files[1])).lyrics).toBe('[00:01.00]Track B')
    expect((await tagger.readTrackMetadata(files[2])).lyrics).toBe('[00:01.00]Track C')
  })

  it('retries EBUSY/EPERM/EACCES with bounded exponential backoff and stops on non-lock errors', async () => {
    let lockAttempts = 0
    const lockCodes = ['EBUSY', 'EPERM', 'EACCES']
    const recovered = await retryOnLockError(
      async () => {
        lockAttempts++
        if (lockAttempts <= lockCodes.length) {
          const err = new Error('locked') as NodeJS.ErrnoException
          err.code = lockCodes[lockAttempts - 1]
          throw err
        }
        return 'ok'
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 }
    )
    expect(recovered).toBe('ok')
    expect(lockAttempts).toBe(4)

    let nonLockAttempts = 0
    await expect(
      retryOnLockError(
        async () => {
          nonLockAttempts++
          const err = new Error('missing') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toThrow('missing')
    expect(nonLockAttempts).toBe(1)

    const dir = await createTempDir()
    const flacPath = path.join(dir, 'retry.flac')
    await fs.copyFile(path.join(FIXTURES_DIR, 'sample.flac'), flacPath)
    let renameCalls = 0
    const retryingTagger = new AudioTagger(rawTaglib, {
      retryOptions: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 },
      swapOps: {
        rename: async (oldPath, newPath) => {
          renameCalls++
          if (renameCalls < 3) {
            const err = new Error('busy') as NodeJS.ErrnoException
            err.code = 'EBUSY'
            throw err
          }
          await fs.rename(oldPath, newPath)
        },
        utimes: (filePath, atime, mtime) => fs.utimes(filePath, atime, mtime)
      }
    })
    await retryingTagger.embedLyrics(flacPath, '[00:01.00]After retry')
    expect(renameCalls).toBe(3)
    expect((await retryingTagger.readTrackMetadata(flacPath)).lyrics).toBe(
      '[00:01.00]After retry'
    )
  })

  it('restricts temp staging paths and cleanup strictly to *.lrcembed.*.tmp.*', async () => {
    const dir = await createTempDir()
    const nestedDir = path.join(dir, 'nested')
    await fs.mkdir(nestedDir)

    const stagedExample = buildTempPath(path.join(dir, 'song.mp3'), 4242)
    expect(path.basename(stagedExample)).toBe('song.lrcembed.4242.tmp.mp3')
    expect(isLrcEmbedTempFile(path.basename(stagedExample))).toBe(true)

    const shouldDelete = [
      path.join(dir, 'song.lrcembed.1234.tmp.mp3'),
      path.join(nestedDir, 'track.lrcembed.99999.tmp.flac')
    ]
    const shouldKeep = [
      path.join(dir, 'unrelated.tmp'),
      path.join(dir, 'song.tmp.mp3'),
      path.join(dir, 'song.lrcembed.txt'),
      path.join(dir, 'song.lrcembed.1234.tmp'),
      path.join(nestedDir, 'other.bak.tmp.mp3')
    ]

    for (const file of [...shouldDelete, ...shouldKeep]) {
      await fs.writeFile(file, 'placeholder', 'utf8')
    }

    const removed = await cleanupStaleTempFiles(dir, { recursive: true })
    expect(removed.sort()).toEqual(shouldDelete.slice().sort())

    for (const deleted of shouldDelete) {
      await expect(fs.stat(deleted)).rejects.toThrow()
    }
    for (const kept of shouldKeep) {
      const stat = await fs.stat(kept)
      expect(stat.isFile()).toBe(true)
    }
  })
})
