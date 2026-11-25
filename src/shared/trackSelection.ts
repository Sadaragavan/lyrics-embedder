/**
 * Pure DOM-free track filtering and React-managed multi-selection helpers.
 *
 * Maintains Shift-click / Ctrl-click selection state in pure React state
 * rather than DOM nodes. Must stay free of Node-only and DOM-only imports.
 */

import { hasSyncedTimestamps } from './lyricsSync'
import type { TrackRecord } from './types'

export type TrackLyricsFilter = 'all' | 'missing' | 'synced' | 'plain' | 'sidecar' | 'draft'

export interface TrackFilterCriteria {
  search: string
  status: TrackLyricsFilter
  rootId?: string
  draftTrackIds?: ReadonlySet<string>
}

export interface TrackSelectionState {
  selectedIds: Set<string>
  anchorId: string | null
  focusedId: string | null
}

export interface SelectionClickModifiers {
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

function extractFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? filePath
}

function matchesStatusFilter(
  track: TrackRecord,
  status: TrackLyricsFilter,
  draftTrackIds?: ReadonlySet<string>
): boolean {
  switch (status) {
    case 'all':
      return true
    case 'missing':
      return track.lyricsSource === 'none' || !track.lyrics
    case 'synced':
      return Boolean(track.lyrics && hasSyncedTimestamps(track.lyrics))
    case 'plain':
      return Boolean(track.lyrics && !hasSyncedTimestamps(track.lyrics))
    case 'sidecar':
      return track.lyricsSource === 'sidecar'
    case 'draft':
      return Boolean(track.draftId || draftTrackIds?.has(track.id))
  }
}

/**
 * Filters tracks by optional library root, lyrics status, and case-insensitive search text.
 */
export function filterTracks(
  tracks: readonly TrackRecord[],
  criteria: TrackFilterCriteria
): TrackRecord[] {
  const query = criteria.search.trim().toLowerCase()
  const rootFilter = criteria.rootId?.trim()

  return tracks.filter((track) => {
    if (rootFilter && track.libraryRootId !== rootFilter) {
      return false
    }
    if (!matchesStatusFilter(track, criteria.status, criteria.draftTrackIds)) {
      return false
    }
    if (query.length === 0) {
      return true
    }
    const fileName = extractFileName(track.filePath).toLowerCase()
    return (
      track.title.toLowerCase().includes(query) ||
      track.artist.toLowerCase().includes(query) ||
      track.album.toLowerCase().includes(query) ||
      fileName.includes(query)
    )
  })
}

export function createEmptySelectionState(): TrackSelectionState {
  return {
    selectedIds: new Set<string>(),
    anchorId: null,
    focusedId: null
  }
}

/**
 * Applies a row click against `visibleTrackIds`:
 * - Plain click: selects only `clickedId`, sets anchor & focus.
 * - Ctrl/Meta click: toggles `clickedId`, updates anchor & focus.
 * - Shift click: selects contiguous range `[anchorId..clickedId]` (replacing selection).
 * - Ctrl/Meta + Shift click: unions contiguous range `[anchorId..clickedId]` with selection.
 */
export function applyTrackClick(
  state: TrackSelectionState,
  visibleTrackIds: readonly string[],
  clickedId: string,
  modifiers: SelectionClickModifiers = {}
): TrackSelectionState {
  const clickedIndex = visibleTrackIds.indexOf(clickedId)
  if (clickedIndex === -1) {
    return state
  }

  const toggle = Boolean(modifiers.ctrlKey || modifiers.metaKey)
  const shift = Boolean(modifiers.shiftKey)

  if (shift && state.anchorId !== null) {
    const anchorIndex = visibleTrackIds.indexOf(state.anchorId)
    if (anchorIndex !== -1) {
      const start = Math.min(anchorIndex, clickedIndex)
      const end = Math.max(anchorIndex, clickedIndex)
      const rangeIds = visibleTrackIds.slice(start, end + 1)
      const nextSelected = toggle ? new Set(state.selectedIds) : new Set<string>()
      for (const id of rangeIds) {
        nextSelected.add(id)
      }
      return {
        selectedIds: nextSelected,
        anchorId: state.anchorId,
        focusedId: clickedId
      }
    }
  }

  if (toggle) {
    const nextSelected = new Set(state.selectedIds)
    if (nextSelected.has(clickedId)) {
      nextSelected.delete(clickedId)
    } else {
      nextSelected.add(clickedId)
    }
    return {
      selectedIds: nextSelected,
      anchorId: clickedId,
      focusedId: clickedId
    }
  }

  return {
    selectedIds: new Set([clickedId]),
    anchorId: clickedId,
    focusedId: clickedId
  }
}

export function selectAllVisible(
  visibleTrackIds: readonly string[],
  preferredFocusId?: string | null
): TrackSelectionState {
  const selectedIds = new Set(visibleTrackIds)
  const fallbackFocus = visibleTrackIds[0] ?? null
  const focusedId =
    preferredFocusId && selectedIds.has(preferredFocusId) ? preferredFocusId : fallbackFocus
  return {
    selectedIds,
    anchorId: visibleTrackIds[0] ?? null,
    focusedId
  }
}

export function clearSelection(focusedId: string | null = null): TrackSelectionState {
  return {
    selectedIds: new Set<string>(),
    anchorId: null,
    focusedId
  }
}

/**
 * Reconciles selection state after track list / filter changes, dropping stale IDs.
 */
export function reconcileSelection(
  state: TrackSelectionState,
  existingTrackIds: readonly string[]
): TrackSelectionState {
  const valid = new Set(existingTrackIds)
  const nextSelected = new Set<string>()
  for (const id of state.selectedIds) {
    if (valid.has(id)) {
      nextSelected.add(id)
    }
  }
  const anchorId = state.anchorId && valid.has(state.anchorId) ? state.anchorId : null
  const focusedId = state.focusedId && valid.has(state.focusedId) ? state.focusedId : null
  return {
    selectedIds: nextSelected,
    anchorId,
    focusedId
  }
}
