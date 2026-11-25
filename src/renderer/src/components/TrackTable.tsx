import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Volume2 } from 'lucide-react'
import type { LyricsFetchProgress, TrackRecord } from '@shared/ipc'
import { formatDuration, hasSyncedTimestamps } from '@shared/lyricsSync'
import type { SelectionClickModifiers, TrackSelectionState } from '@shared/trackSelection'
import type { TrackEmbedStatus } from '../types'

const ROW_HEIGHT = 44

export interface TrackTableProps {
  tracks: TrackRecord[]
  selection: TrackSelectionState
  draftTrackIds: ReadonlySet<string>
  fetchProgressMap: ReadonlyMap<string, LyricsFetchProgress>
  embedStatusMap: ReadonlyMap<string, TrackEmbedStatus>
  loadedTrackId: string | null
  isPlaying: boolean
  onRowClick: (trackId: string, modifiers: SelectionClickModifiers) => void
  onSelectAll: () => void
  onClearSelection: () => void
}

function renderStatusPill(
  fetchProgress: LyricsFetchProgress | undefined,
  embedStatus: TrackEmbedStatus | undefined
) {
  if (embedStatus && embedStatus.phase !== 'idle') {
    if (embedStatus.phase === 'embedding') {
      return (
        <span className="rounded bg-blue-950/80 border border-blue-800/80 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
          Embedding
        </span>
      )
    }
    if (embedStatus.phase === 'verified') {
      return (
        <span className="rounded bg-emerald-950/80 border border-emerald-800/80 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
          Embedded
        </span>
      )
    }
    return (
      <span
        title={embedStatus.error}
        className="rounded bg-red-950/80 border border-red-800/80 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
      >
        Embed Err
      </span>
    )
  }

  if (fetchProgress && fetchProgress.phase !== 'idle') {
    if (fetchProgress.phase === 'fetching') {
      return (
        <span className="rounded bg-sky-950/80 border border-sky-800/80 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
          {fetchProgress.providerId === 'lrclib' ? 'LRCLIB...' : 'Fetching'}
        </span>
      )
    }
    if (fetchProgress.phase === 'error') {
      return (
        <span
          title={fetchProgress.error}
          className="rounded bg-red-950/80 border border-red-800/80 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
        >
          Fetch Err
        </span>
      )
    }
    if (fetchProgress.phase === 'cancelled') {
      return (
        <span className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
          Cancelled
        </span>
      )
    }
    if (fetchProgress.phase === 'done') {
      return fetchProgress.candidate ? (
        <span className="rounded bg-emerald-950/70 border border-emerald-800/70 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
          Fetched
        </span>
      ) : (
        <span className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
          No Match
        </span>
      )
    }
  }

  return <span className="text-[11px] text-zinc-600">—</span>
}

export function TrackTable({
  tracks,
  selection,
  draftTrackIds,
  fetchProgressMap,
  embedStatusMap,
  loadedTrackId,
  isPlaying,
  onRowClick,
  onSelectAll,
  onClearSelection
}: TrackTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  const virtualRows = virtualizer.getVirtualItems()

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-200">Library Tracks</span>
          <span className="text-zinc-500 tabular-nums">
            {selection.selectedIds.size > 0
              ? `${selection.selectedIds.size} selected`
              : `${tracks.length} shown`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={tracks.length === 0}
            className="text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selection.selectedIds.size === 0}
            className="text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-[28px_minmax(0,1fr)_64px_54px_124px_88px] items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        <span />
        <span>Track / Artist</span>
        <span>Format</span>
        <span className="text-right">Time</span>
        <span>Lyrics</span>
        <span className="text-right">Status</span>
      </div>

      {tracks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-zinc-500">
          Add a library folder and scan to populate tracks, or adjust your search/filter.
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto select-none">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualRows.map((virtualRow) => {
              const track = tracks[virtualRow.index]!
              const isSelected = selection.selectedIds.has(track.id)
              const isFocused = selection.focusedId === track.id
              const hasDraft = Boolean(track.draftId || draftTrackIds.has(track.id))
              const synced = hasSyncedTimestamps(track.lyrics)
              const fetchProgress = fetchProgressMap.get(track.id)
              const embedStatus = embedStatusMap.get(track.id)
              const isLoadedAudio = loadedTrackId === track.id

              return (
                <div
                  key={track.id}
                  role="row"
                  aria-selected={isSelected}
                  onClick={(event) =>
                    onRowClick(track.id, {
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      shiftKey: event.shiftKey
                    })
                  }
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                  className={`grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_64px_54px_124px_88px] items-center gap-2 border-b border-zinc-800/50 px-3 text-xs transition-colors ${
                    isFocused
                      ? 'bg-emerald-950/45 ring-1 ring-inset ring-emerald-700/70'
                      : isSelected
                        ? 'bg-zinc-800/80'
                        : 'hover:bg-zinc-800/40'
                  }`}
                >
                  <button
                    type="button"
                    aria-label={`Toggle selection for ${track.title}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRowClick(track.id, { ctrlKey: true })
                    }}
                    className={`flex h-4 w-4 items-center justify-center rounded border ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-600 text-white'
                        : 'border-zinc-600 bg-zinc-950 text-transparent hover:border-zinc-400'
                    }`}
                  >
                    <Check className="h-3 w-3" />
                  </button>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isLoadedAudio && (
                        <Volume2
                          className={`h-3.5 w-3.5 shrink-0 ${
                            isPlaying ? 'text-emerald-400' : 'text-zinc-400'
                          }`}
                        />
                      )}
                      <span className="truncate font-medium text-zinc-100">{track.title}</span>
                    </div>
                    <div className="truncate text-[11px] text-zinc-400">
                      {[track.artist || 'Unknown Artist', track.album].filter(Boolean).join(' · ')}
                    </div>
                  </div>

                  <span className="font-mono text-[11px] text-zinc-300 truncate">
                    {track.format}
                  </span>

                  <span className="text-right font-mono text-[11px] tabular-nums text-zinc-400">
                    {formatDuration(track.durationSec)}
                  </span>

                  <div className="flex items-center gap-1 overflow-hidden">
                    {track.lyricsSource === 'none' ? (
                      <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-500">
                        None
                      </span>
                    ) : (
                      <>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            track.lyricsSource === 'sidecar'
                              ? 'bg-violet-950/70 text-violet-300 border border-violet-800/70'
                              : 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                          }`}
                        >
                          {track.lyricsSource === 'sidecar' ? 'LRC' : 'Tag'}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            synced
                              ? 'bg-emerald-950/70 text-emerald-300'
                              : 'bg-amber-950/70 text-amber-300'
                          }`}
                        >
                          {synced ? 'Sync' : 'Plain'}
                        </span>
                      </>
                    )}
                    {hasDraft && (
                      <span className="rounded bg-amber-900/70 border border-amber-700/80 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                        Draft
                      </span>
                    )}
                  </div>

                  <div className="flex justify-end">
                    {renderStatusPill(fetchProgress, embedStatus)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
