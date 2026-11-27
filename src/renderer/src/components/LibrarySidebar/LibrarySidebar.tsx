import { Download, Save, XCircle } from 'lucide-react'
import type { ScanProgress, TagEngineHealth } from '@shared/ipc'
import type { TrackSelectionState, SelectionClickModifiers } from '@shared/trackSelection'
import type { LyricsFetchProgress } from '@shared/ipc'
import type { TrackEmbedStatus } from '../../types'
import { TrackTable } from '../TrackTable/TrackTable'

export interface LibrarySidebarProps {
  health: TagEngineHealth | null
  scanning: boolean
  scanProgress: ScanProgress | null
  filteredTracks: any[] // TrackRecord[]
  selection: TrackSelectionState
  activeFetchCount: number
  lastFetchError?: string | null
  embedding: boolean
  draftTrackIds: ReadonlySet<string>
  fetchProgressMap: ReadonlyMap<string, LyricsFetchProgress>
  embedStatusMap: ReadonlyMap<string, TrackEmbedStatus>
  loadedTrackId: string | null
  isPlaying: boolean
  onRowClick: (trackId: string, modifiers: SelectionClickModifiers) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onFetchSelected: () => void
  onCancelActiveFetches: () => void
  onEmbedSelected: () => void
}

/**
 * Library sidebar with virtualized track list and contextual batch bar.
 */
export function LibrarySidebar({
  health,
  scanning,
  scanProgress,
  filteredTracks,
  selection,
  activeFetchCount,
  lastFetchError,
  embedding,
  draftTrackIds,
  fetchProgressMap,
  embedStatusMap,
  loadedTrackId,
  isPlaying,
  onRowClick,
  onSelectAll,
  onClearSelection,
  onFetchSelected,
  onCancelActiveFetches,
  onEmbedSelected
}: LibrarySidebarProps) {
  const workerReady = Boolean(health?.ready)

  const progressTotal = scanProgress?.total ?? 0
  const progressProcessed = scanProgress?.processed ?? 0
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressProcessed / progressTotal) * 100)) : 0

  return (
    <div className="flex flex-col min-h-0 flex-1 border-r border-zinc-800 bg-zinc-900/50">
      {/* Virtualized Track Table */}
      <TrackTable
        tracks={filteredTracks}
        selection={selection}
        draftTrackIds={draftTrackIds}
        fetchProgressMap={fetchProgressMap}
        embedStatusMap={embedStatusMap}
        loadedTrackId={loadedTrackId}
        isPlaying={isPlaying}
        onRowClick={onRowClick}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
      />

      {/* Scan Progress */}
      {scanning && scanProgress && (
        <div className="shrink-0 space-y-0.5 border-t border-zinc-800 bg-zinc-900/95 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400">
            <span className="min-w-0 flex-1 truncate">
              Scanning: {scanProgress.currentPath ?? '...'}
            </span>
            <span className="shrink-0 tabular-nums">
              {progressProcessed}
              {progressTotal > 0 ? ` / ${progressTotal}` : ''}
              {scanProgress.errors ? ` (${scanProgress.errors} errors)` : ''}
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${progressTotal > 0 ? progressPercent : 35}%` }}
            />
          </div>
        </div>
      )}

      {/* Contextual Batch Bar */}
      {selection.selectedIds.size >= 2 && (
        <div className="shrink-0 flex flex-wrap items-center gap-1 rounded-md border border-sky-900/70 bg-sky-950/40 px-1.5 py-1 border-t border-zinc-800">
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-sky-200">
            {selection.selectedIds.size} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onFetchSelected}
              disabled={activeFetchCount > 0}
              title={`Fetch lyrics for ${selection.selectedIds.size} selected track(s) from LRCLIB or a sibling .lrc file`}
              className="inline-flex items-center gap-1 rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-3 w-3" />
              Fetch Selected
            </button>
            {activeFetchCount > 0 && (
              <button
                type="button"
                onClick={onCancelActiveFetches}
                title={`Cancel ${activeFetchCount} in-flight lyrics fetch(es).${lastFetchError ? `\nLast fetch error — ${lastFetchError}` : ''}`}
                className="inline-flex items-center gap-1 rounded border border-red-800 bg-red-950/70 px-1.5 py-0.5 text-[10px] font-medium text-red-200 hover:bg-red-900/70"
              >
                <XCircle className="h-3 w-3" />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={onEmbedSelected}
              disabled={embedding || !workerReady}
              title="Atomically write lyrics to the selected files (unloads playback, closes media:// handles, restores mtime)"
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              {embedding ? 'Embedding...' : 'Embed Selected'}
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              title="Clear the current selection"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}