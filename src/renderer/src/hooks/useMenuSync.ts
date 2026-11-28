import { useEffect, useRef, useMemo } from 'react'
import type { MenuAction, MenuSyncState, TrackRecord, TagEngineHealth } from '@shared/ipc'
import type { TrackSelectionState } from '@shared/trackSelection'

interface UseMenuSyncOptions {
  focusedTrack: TrackRecord | null
  focusedHasDraft: boolean
  focusedIsDirty: boolean
  focusedLyricsText: string
  health: TagEngineHealth | null
  sidebarVisible: boolean
  workspaceMode: 'lyrics' | 'text' | 'find'
  isPlaying: boolean
  loadedTrackId: string | null
  selection: TrackSelectionState
  embedding: boolean
  preserveWordTags: boolean
}

/**
 * Builds and syncs menu state to main process.
 */
export function useMenuSync({
  focusedTrack,
  focusedHasDraft,
  focusedIsDirty,
  focusedLyricsText,
  health,
  sidebarVisible,
  workspaceMode,
  isPlaying,
  loadedTrackId,
  selection,
  embedding,
  preserveWordTags
}: UseMenuSyncOptions) {
  const handleMenuActionRef = useRef<(action: MenuAction) => Promise<void>>(async () => undefined)

  const menuSyncState = useMemo<MenuSyncState>(() => ({
    hasFocusedTrack: focusedTrack !== null,
    hasDraft: focusedHasDraft,
    isDirty: focusedIsDirty,
    hasLyrics: Boolean(focusedLyricsText),
    workerReady: Boolean(health?.ready),
    preserveWordTags,
    sidebarVisible,
    mode: workspaceMode,
    isPlaying,
    canPlay: focusedTrack !== null,
    canStop: loadedTrackId !== null,
    selectedCount: selection.selectedIds.size,
    embedding
  }), [
    focusedTrack,
    focusedHasDraft,
    focusedIsDirty,
    focusedLyricsText,
    health,
    preserveWordTags,
    sidebarVisible,
    workspaceMode,
    isPlaying,
    loadedTrackId,
    selection.selectedIds.size,
    embedding
  ])

  useEffect(() => {
    window.api.syncMenuState(menuSyncState)
  }, [menuSyncState])

  return { handleMenuActionRef, menuSyncState }
}