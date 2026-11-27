import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

const ROW_HEIGHT = 48

interface UseVirtualTracksOptions {
  tracks: any[] // TrackRecord[]
  onRowClick: (trackId: string, modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  onClearSelection: () => void
  selection: any // TrackSelectionState
}

/**
 * Virtualized track list with row rendering helpers.
 */
export function useVirtualTracks({
  tracks,
  onRowClick: _onRowClick,
  onClearSelection,
  selection
}: UseVirtualTracksOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  const virtualRows = virtualizer.getVirtualItems()
  const hasSelection = selection.selectedIds.size > 0

  return {
    scrollRef,
    virtualizer,
    virtualRows,
    hasSelection,
    ROW_HEIGHT,
    onClearSelection
  }
}