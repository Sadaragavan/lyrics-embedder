import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Volume2 } from 'lucide-react'
import type { LyricsFetchProgress, TrackRecord } from '@shared/ipc'
import { formatDuration, hasSyncedTimestamps } from '@shared/lyricsSync'
import type { SelectionClickModifiers, TrackSelectionState } from '@shared/trackSelection'
import type { TrackEmbedStatus } from '../../types'
import { StatusPill } from './StatusPill'

const ROW_HEIGHT = 48

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

function buildTrackRowTooltip(
  track: TrackRecord,
  hasDraft: boolean,
  synced: boolean
): string {
  const lyricsStatus =
    track.lyricsSource === 'none'
      ? 'none'
      : `${track.lyricsSource === 'sidecar' ? '.lrc sidecar' : 'embedded tag'} · ${synced ? 'synced' : 'plain'}`
  const modified = Number.isFinite(track.mtimeMs)
    ? new Date(track.mtimeMs).toLocaleString()
    : 'unknown'
  return [
    track.filePath,
    `Format: ${track.format}`,
    `Duration: ${formatDuration(track.durationSec)} (${track.durationSec.toFixed(1)}s)`,
    `Modified: ${modified}`,
    `Lyrics: ${lyricsStatus}`,
    hasDraft ? `Draft: saved${track.draftId ? ` (${track.draftId})` : ''}` : 'Draft: none'
  ].join('\n')
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
  const hasSelection = selection.selectedIds.size > 0

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium text-zinc-200">Tracks</span>
          <span className="truncate tabular-nums text-zinc-500">
            {hasSelection ? `${selection.selectedIds.size} selected` : `${tracks.length} shown`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={tracks.length === 0}
            className="shrink-0 text-[10px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selection.selectedIds.size === 0}
            className="shrink-0 text-[10px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-zinc-500">
          Scan a library folder to populate tracks.
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 select-none overflow-y-auto">
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
                  title={buildTrackRowTooltip(track, hasDraft, synced)}
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
                  className={`flex cursor-pointer items-center gap-1.5 border-b border-zinc-800/50 px-2 leading-snug transition-colors ${
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
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-600 text-white'
                        : 'border-zinc-600 bg-zinc-950 text-transparent hover:border-zinc-400'
                    }`}
                  >
                    <Check className="h-2.5 w-2.5" />
                  </button>

                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    <div className="flex min-w-0 items-center gap-1">
                      {isLoadedAudio && (
                        <Volume2
                          aria-hidden
                          className={`h-3 w-3 shrink-0 ${isPlaying ? 'text-emerald-400' : 'text-zinc-400'}`}
                        />
                      )}
                      <span className="min-w-0 truncate text-[11px] font-medium leading-snug text-zinc-100">
                        {track.title}
                      </span>
                      {hasDraft && (
                        <span
                          title="A saved draft differs from the lyrics embedded in the file"
                          className="shrink-0 rounded border border-amber-700/80 bg-amber-900/70 px-1 py-0.5 text-[9px] font-medium leading-none text-amber-200"
                        >
                          Draft
                        </span>
                      )}
                      {track.lyricsSource === 'none' ? (
                        <span className="shrink-0 rounded bg-zinc-800/80 px-1 py-0.5 text-[9px] leading-none text-zinc-500">
                          None
                        </span>
                      ) : (
                        <span
                          title={
                            track.lyricsSource === 'sidecar'
                              ? 'Lyrics loaded from a sibling .lrc sidecar file'
                              : 'Lyrics embedded in the track tag'
                          }
                          className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium leading-none ${
                            track.lyricsSource === 'sidecar'
                              ? 'border-violet-800/70 bg-violet-950/70 text-violet-300'
                              : synced
                                ? 'border-emerald-800/60 bg-emerald-950/70 text-emerald-300'
                                : 'border-amber-800/60 bg-amber-950/70 text-amber-300'
                          }`}
                        >
                          {track.lyricsSource === 'sidecar' ? 'LRC' : synced ? 'Sync' : 'Plain'}
                        </span>
                      )}
                    </div>

                    <div className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate text-[10px] leading-snug text-zinc-400">
                        {[track.artist || 'Unknown Artist', track.format.toUpperCase(), formatDuration(track.durationSec)].join(' · ')}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center">
                        <StatusPill fetchProgress={fetchProgress} embedStatus={embedStatus} />
                      </span>
                    </div>
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