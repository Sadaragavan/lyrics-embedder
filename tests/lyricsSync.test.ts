import { describe, it, expect } from 'vitest'
import {
  findActiveLineIndex,
  findActiveLineIndices,
  formatDuration,
  hasSyncedTimestamps
} from '../src/shared/lyricsSync'
import type { LrcLine } from '../src/shared/lrc'

describe('hasSyncedTimestamps', () => {
  it('detects synced LRC timestamps', () => {
    expect(hasSyncedTimestamps('[00:01.00]Hello')).toBe(true)
    expect(hasSyncedTimestamps('[01:23:45]Alt format')).toBe(true)
    expect(hasSyncedTimestamps('[00:10]Short format')).toBe(true)
  })

  it('returns false for plain text, headers only, or empty input', () => {
    expect(hasSyncedTimestamps(null)).toBe(false)
    expect(hasSyncedTimestamps(undefined)).toBe(false)
    expect(hasSyncedTimestamps('')).toBe(false)
    expect(hasSyncedTimestamps('[ti:Song Title]\nJust plain words')).toBe(false)
  })
})

describe('findActiveLineIndex', () => {
  const lines: LrcLine[] = [
    { timeMs: 1_000, text: 'Line 1' },
    { timeMs: 3_000, text: 'Line 2' },
    { timeMs: 3_000, text: 'Line 2 translation' },
    { timeMs: 7_500, text: 'Line 3' }
  ]

  it('returns -1 for empty lines, non-finite time, or playback before first line', () => {
    expect(findActiveLineIndex([], 1_000)).toBe(-1)
    expect(findActiveLineIndex(lines, Number.NaN)).toBe(-1)
    expect(findActiveLineIndex(lines, 0)).toBe(-1)
    expect(findActiveLineIndex(lines, 999)).toBe(-1)
  })

  it('matches exact timestamp boundary and mid-line timestamps', () => {
    expect(findActiveLineIndex(lines, 1_000)).toBe(0)
    expect(findActiveLineIndex(lines, 2_500)).toBe(0)
    expect(findActiveLineIndex(lines, 7_500)).toBe(3)
    expect(findActiveLineIndex(lines, 20_000)).toBe(3)
  })

  it('returns last matching index for duplicate stacked timestamps', () => {
    expect(findActiveLineIndex(lines, 3_000)).toBe(2)
    expect(findActiveLineIndex(lines, 5_000)).toBe(2)
  })
})

describe('findActiveLineIndices', () => {
  const lines: LrcLine[] = [
    { timeMs: 1_000, text: 'Line 1' },
    { timeMs: 3_000, text: 'Line 2' },
    { timeMs: 3_000, text: 'Line 2 translation' },
    { timeMs: 3_000, text: 'Line 2 romanization' },
    { timeMs: 7_500, text: 'Line 3' }
  ]

  it('returns all indices sharing the active timestamp', () => {
    expect(findActiveLineIndices(lines, 3_000)).toEqual([1, 2, 3])
    expect(findActiveLineIndices(lines, 5_000)).toEqual([1, 2, 3])
    expect(findActiveLineIndices(lines, 1_500)).toEqual([0])
    expect(findActiveLineIndices(lines, 9_000)).toEqual([4])
  })

  it('stays backwards-compatible with findActiveLineIndex', () => {
    for (const time of [0, 1_000, 2_500, 3_000, 5_000, 7_500, 20_000]) {
      const indices = findActiveLineIndices(lines, time)
      const last = indices.length > 0 ? indices[indices.length - 1] : -1
      expect(last).toBe(findActiveLineIndex(lines, time))
    }
  })

  it('returns an empty array for empty input, non-finite time, or before the first line', () => {
    expect(findActiveLineIndices([], 1_000)).toEqual([])
    expect(findActiveLineIndices(lines, Number.NaN)).toEqual([])
    expect(findActiveLineIndices(lines, Number.POSITIVE_INFINITY)).toEqual([])
    expect(findActiveLineIndices(lines, 999)).toEqual([])
  })
})

describe('formatDuration', () => {
  it('formats durations as m:ss and handles invalid inputs', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(225.8)).toBe('3:45')
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})
