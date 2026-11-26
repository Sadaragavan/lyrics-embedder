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
 * Returns every index sharing the active timestamp (stacked translations /
 * romanization lines). Backwards-compatible with `findActiveLineIndex`: the
 * returned array always ends at that function's result.
 */
export function findActiveLineIndices(
  lines: readonly LrcLine[],
  currentTimeMs: number
): number[] {
  const lastIndex = findActiveLineIndex(lines, currentTimeMs)
  if (lastIndex < 0) return []

  const activeTimeMs = lines[lastIndex]!.timeMs
  let firstIndex = lastIndex
  while (firstIndex > 0 && lines[firstIndex - 1]!.timeMs === activeTimeMs) {
    firstIndex--
  }
  // Guard against unsorted input: include any equal-timestamp lines after the
  // binary-search hit as well.
  let endIndex = lastIndex
  while (endIndex + 1 < lines.length && lines[endIndex + 1]!.timeMs === activeTimeMs) {
    endIndex++
  }

  const indices: number[] = []
  for (let index = firstIndex; index <= endIndex; index++) {
    indices.push(index)
  }
  return indices
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
