import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findContainingRoot,
  isPathWithinRoots,
  validateAudioPathInRoots
} from '../src/main/utils/pathContainment'
import { isValidTrackId } from '../src/main/utils/trackId'

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

describe('trackId validation', () => {
  it('accepts valid 32-char lowercase hex trackIds', () => {
    expect(isValidTrackId('a'.repeat(32))).toBe(true)
    expect(isValidTrackId('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isValidTrackId('ffffffffffffffffffffffffffffffff')).toBe(true)
  })

  it('rejects invalid trackIds (wrong length, uppercase, non-hex, traversal)', () => {
    expect(isValidTrackId('')).toBe(false)
    expect(isValidTrackId('a'.repeat(31))).toBe(false)
    expect(isValidTrackId('a'.repeat(33))).toBe(false)
    expect(isValidTrackId('A'.repeat(32))).toBe(false)
    expect(isValidTrackId('g'.repeat(32))).toBe(false)
    expect(isValidTrackId('0123456789abcdef0123456789abcde/')).toBe(false)
    expect(isValidTrackId('../etc/passwd')).toBe(false)
    expect(isValidTrackId('0123456789abcdef0123456789abcdef\n')).toBe(false)
  })
})

describe('symlink and empty-roots containment rejection', () => {
  it('rejects symlink escapes outside roots when resolved', async () => {
    const root = await makeTempDir()
    const outside = await makeTempDir()
    await fs.writeFile(path.join(root, 'inside.mp3'), 'x')
    await fs.writeFile(path.join(outside, 'outside.mp3'), 'x')

    const linkPath = path.join(root, 'linked.mp3')
    try {
      await fs.symlink(path.join(outside, 'outside.mp3'), linkPath)
    } catch {
      // Symlinks may not be available in test environment
      return
    }

    // The symlink target is outside the root - containment check should reject
    // when the real path is resolved
    const realLinkPath = await fs.realpath(linkPath)
    expect(isPathWithinRoots(realLinkPath, [root])).toBe(false)
  })

  it('rejects paths when roots array is empty', () => {
    expect(isPathWithinRoots('/absolute/path/track.mp3', [])).toBe(false)
    expect(() => validateAudioPathInRoots('/absolute/path/track.mp3', [], ['.mp3'])).toThrow('outside')
  })
})
