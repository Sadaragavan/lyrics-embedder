import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findContainingRoot,
  isPathWithinRoots,
  validateAudioPathInRoots
} from '../src/main/utils/pathContainment'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lrcembed-paths-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('isPathWithinRoots (platform agnostic)', () => {
  it('accepts the root itself and nested paths, rejects traversal and sibling prefixes', async () => {
    const root = await makeTempDir()
    const nested = path.join(root, 'Artist', 'Album', 'track.flac')
    await fs.mkdir(path.dirname(nested), { recursive: true })
    await fs.writeFile(nested, 'x')

    expect(isPathWithinRoots(root, [root])).toBe(true)
    expect(isPathWithinRoots(nested, [root])).toBe(true)
    expect(isPathWithinRoots(path.join(root, '..', 'escape.mp3'), [root])).toBe(false)
    expect(isPathWithinRoots(`${root}Evil${path.sep}track.mp3`, [root])).toBe(false)
    expect(isPathWithinRoots('relative/track.mp3', [root])).toBe(false)
    expect(isPathWithinRoots(nested, [])).toBe(false)
  })

  it('ignores non-absolute roots', async () => {
    const root = await makeTempDir()
    expect(isPathWithinRoots(path.join(root, 'a.mp3'), ['relative-root'])).toBe(false)
  })

  it('finds the containing root and validates extensions', async () => {
    const root = await makeTempDir()
    const nested = path.join(root, 'song.flac')
    await fs.writeFile(nested, 'x')

    expect(findContainingRoot(nested, [root])).toBe(root)
    expect(findContainingRoot(nested, [])).toBeNull()

    expect(validateAudioPathInRoots(nested, [root], ['.flac'])).toBe(nested)
    expect(() => validateAudioPathInRoots(nested, [root], ['.mp3'])).toThrow(/extension/)
    expect(() => validateAudioPathInRoots(nested, [], ['.flac'])).toThrow(/outside/)
    expect(() => validateAudioPathInRoots('relative.flac', [root], ['.flac'])).toThrow()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows containment semantics', () => {
  it('compares case-insensitively', () => {
    expect(isPathWithinRoots('C:\\Music\\Sub\\Track.MP3', ['c:\\music'])).toBe(true)
    expect(isPathWithinRoots('c:\\MUSIC\\track.flac', ['C:\\Music'])).toBe(true)
  })

  it('rejects sibling-prefix bypasses', () => {
    expect(isPathWithinRoots('C:\\MusicEvil\\track.mp3', ['C:\\Music'])).toBe(false)
    expect(isPathWithinRoots('C:\\Music2\\track.mp3', ['C:\\Music'])).toBe(false)
  })

  it('rejects cross-drive paths', () => {
    expect(isPathWithinRoots('D:\\Music\\track.mp3', ['C:\\Music'])).toBe(false)
  })

  it('rejects .. traversal after normalization', () => {
    expect(isPathWithinRoots('C:\\Music\\..\\Windows\\System32\\x.mp3', ['C:\\Music'])).toBe(false)
    expect(isPathWithinRoots('C:\\Music\\Sub\\..\\..\\escape.mp3', ['C:\\Music'])).toBe(false)
  })
})
