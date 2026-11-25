import { describe, it, expect } from 'vitest'
import {
  findActiveLineIndex,
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

describe('formatDuration', () => {
  it('formats durations as m:ss and handles invalid inputs', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(225.8)).toBe('3:45')
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})
