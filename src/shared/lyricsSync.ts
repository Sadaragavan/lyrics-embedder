/**
 * Pure DOM-free lyric timing & playback sync helpers.
 *
 * This module must stay free of Node-only and DOM-only imports.
 */

import type { LrcLine } from './lrc'

const TIMESTAMP_PATTERN = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/

/**
 * Returns true if the given lyric text contains at least one synced timestamp tag.
 */
export function hasSyncedTimestamps(text: string | null | undefined): boolean {
  if (!text) return false
  return TIMESTAMP_PATTERN.test(text)
}

/**
 * Binary-searches sorted `LrcLine[]` and returns the last index whose `timeMs`
 * is `<= currentTimeMs`, or `-1` when playback is before the first lyric line.
 */
export function findActiveLineIndex(lines: readonly LrcLine[], currentTimeMs: number): number {
  if (lines.length === 0 || !Number.isFinite(currentTimeMs)) {
    return -1
  }
  if (currentTimeMs < lines[0]!.timeMs) {
    return -1
  }

  let low = 0
  let high = lines.length - 1
  let result = -1

  while (low <= high) {
    const mid = (low + high) >>> 1
    if (lines[mid]!.timeMs <= currentTimeMs) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
}

/**
 * Formats seconds as `m:ss` for track duration and player elapsed display.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00'
  }
  const wholeSeconds = Math.floor(seconds)
  const mins = Math.floor(wholeSeconds / 60)
  const secs = wholeSeconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}
