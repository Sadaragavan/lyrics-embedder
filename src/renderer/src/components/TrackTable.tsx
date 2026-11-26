import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Volume2 } from 'lucide-react'
import type { LyricsFetchProgress, TrackRecord } from '@shared/ipc'
import { formatDuration, hasSyncedTimestamps } from '@shared/lyricsSync'
import type { SelectionClickModifiers, TrackSelectionState } from '@shared/trackSelection'
import type { TrackEmbedStatus } from '../types'

/** Compact row height tuned for 360-440px library panes on 1366x768. */
const ROW_HEIGHT = 34

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

function providerLabel(providerId: string | undefined): string {
  if (providerId === 'lrclib') return 'LRCLIB'
  if (providerId === 'localSidecar') return 'Local .lrc'
  return 'provider'
}

function buildTrackRowTooltip(
  track: TrackRecord,
  hasDraft: boolean,
  synced: boolean
): string {
  const lyricsStatus =
    track.lyricsSource === 'none'
      ? 'none'
      : `${track.lyricsSource === 'sidecar' ? '.lrc sidecar' : 'embedded tag'} · ${
          synced ? 'synced' : 'plain'
        }`
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

function renderStatusPill(
  fetchProgress: LyricsFetchProgress | undefined,
  embedStatus: TrackEmbedStatus | undefined
) {
  if (embedStatus && embedStatus.phase !== 'idle') {
    if (embedStatus.phase === 'embedding') {
      return (
        <span
          title="Embedding lyrics: unloading the media:// preview, staging, writing, verifying, and swapping the file."
          className="rounded bg-blue-950/80 border border-blue-800/80 px-1.5 py-0.5 text-[10px] font-medium text-blue-300"
        >
          Embedding
        </span>
      )
    }
    if (embedStatus.phase === 'verified') {
      return (
        <span
          title={`Verified embed target: ${embedStatus.targetPath ?? 'track tag'} (${
            embedStatus.lyricsSource === 'sidecar' ? '.lrc sidecar' : 'embedded tag'
          })`}
          className="rounded bg-emerald-950/80 border border-emerald-800/80 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
        >
          Embedded
        </span>
      )
    }
    return (
      <span
        title={`Embed failed: ${embedStatus.error ?? 'unknown error'}`}
        className="rounded bg-red-950/80 border border-red-800/80 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
      >
        Embed Err
      </span>
    )
  }

  if (fetchProgress && fetchProgress.phase !== 'idle') {
    if (fetchProgress.phase === 'fetching') {
      return (
        <span
          title={`Fetching lyrics from ${providerLabel(fetchProgress.providerId)}...`}
          className="rounded bg-sky-950/80 border border-sky-800/80 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
        >
          {fetchProgress.providerId === 'lrclib' ? 'LRCLIB...' : 'Fetching'}
        </span>
      )
    }
    if (fetchProgress.phase === 'error') {
      return (
        <span
          title={`Fetch failed (${providerLabel(fetchProgress.providerId)}): ${
            fetchProgress.error ?? 'unknown error'
          }`}
          className="rounded bg-red-950/80 border border-red-800/80 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
        >
          Fetch Err
        </span>
      )
    }
    if (fetchProgress.phase === 'cancelled') {
      return (
        <span
          title={`Fetch cancelled (${providerLabel(fetchProgress.providerId)})`}
          className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
        >
          Cancelled
        </span>
      )
    }
    if (fetchProgress.phase === 'done') {
      return fetchProgress.candidate ? (
        <span
          title={`Fetched via ${providerLabel(fetchProgress.candidate.providerId)} · score ${
            fetchProgress.candidate.score
          }`}
          className="rounded bg-emerald-950/70 border border-emerald-800/70 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
        >
          Fetched
        </span>
      ) : (
        <span
          title={`No match from ${providerLabel(fetchProgress.providerId)}`}
          className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
        >
          No Match
        </span>
      )
    }
  }

  return <span className="text-[10px] text-zinc-600">—</span>
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
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-200">Tracks</span>
          <span className="text-zinc-500 tabular-nums">
            {hasSelection ? `${selection.selectedIds.size} selected` : `${tracks.length} shown`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={tracks.length === 0}
            className="text-[10px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40 shrink-0"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selection.selectedIds.size === 0}
            className="text-[10px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40 shrink-0"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-[28px_minmax(0,1fr)_56px_50px_110px_72px] items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-950/60 px-2.5 py-1 text-[9px] font-medium uppercase tracking-wider text-zinc-500">
        <span />
        <span>Track / Artist</span>
        <span>Format</span>
        <span className="text-right">Time</span>
        <span>Lyrics</span>
        <span className="text-right">Status</span>
      </div>

      {tracks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-zinc-500">
          Scan a library folder to populate tracks.
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
                  className={`grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_56px_50px_110px_72px] items-center gap-1.5 border-b border-zinc-800/50 px-2.5 text-[10px] transition-colors ${
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
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-600 text-white'
                        : 'border-zinc-600 bg-zinc-950 text-transparent hover:border-zinc-400'
                    }`}
                  >
                    <Check className="h-2.5 w-2.5" />
                  </button>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isLoadedAudio && (
                        <Volume2
                          className={`h-3 w-3 shrink-0 ${
                            isPlaying ? 'text-emerald-400' : 'text-zinc-400'
                          }`}
                        />
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium text-zinc-100 leading-none">
                          {track.title}
                        </div>
                        <div className="truncate text-[9px] text-zinc-400 leading-none">
                          {[track.artist || 'Unknown Artist', track.album]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                    </div>
                  </div>

                  <span className="font-mono text-[9px] text-zinc-300 truncate leading-none">
                    {track.format}
                  </span>

                  <span className="text-right font-mono text-[9px] tabular-nums text-zinc-400 leading-none">
                    {formatDuration(track.durationSec)}
                  </span>

                  <div className="flex items-center gap-1 overflow-hidden min-w-0">
                    {track.lyricsSource === 'none' ? (
                      <span className="rounded bg-zinc-800/80 px-1 py-0.5 text-[9px] text-zinc-500 leading-none">
                        None
                      </span>
                    ) : (
                      <>
                        <span
                          className={`rounded px-1 py-0.5 text-[9px] font-medium leading-none ${
                            track.lyricsSource === 'sidecar'
                              ? 'bg-violet-950/70 text-violet-300 border border-violet-800/70'
                              : 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                          }`}
                        >
                          {track.lyricsSource === 'sidecar' ? 'LRC' : 'Tag'}
                        </span>
                        <span
                          className={`rounded px-1 py-0.5 text-[9px] ${
                            synced
                              ? 'bg-emerald-950/70 text-emerald-300'
                              : 'bg-amber-950/70 text-amber-300'
                          } leading-none`}
                        >
                          {synced ? 'Sync' : 'Plain'}
                        </span>
                      </>
                    )}
                    {hasDraft && (
                      <span className="rounded bg-amber-900/70 border border-amber-700/80 px-1 py-0.5 text-[9px] font-medium text-amber-200 leading-none">
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
