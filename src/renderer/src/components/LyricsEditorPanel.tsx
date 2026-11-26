import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Clock,
  Download,
  FileUp,
  Layers,
  Loader2,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  XCircle
} from 'lucide-react'
import type {
  EditorLayout,
  LyricsFetchProgress,
  LyricsSearchResult,
  TrackRecord,
  WorkspaceMode
} from '@shared/ipc'
import {
  detectLyricsTimingKind,
  formatTimestamp,
  parseLrc,
  shiftLrcOffset,
  stackLrcLayers
} from '@shared/lrc'
import { findActiveLineIndices, hasSyncedTimestamps } from '@shared/lyricsSync'
import type { TrackEmbedStatus } from '../types'
import { resolveLyricsSourceChip, type LyricsSourceKind } from './lyricsSourceChip'

export interface LyricsEditorPanelProps {
  focusedTrack: TrackRecord | null
  selectedCount: number
  lyricsText: string
  hasDraft: boolean
  isDirty: boolean
  preserveWordTags: boolean
  onPreserveWordTagsChange: (value: boolean) => void
  onLyricsChange: (nextLyrics: string) => void
  fetchProgress: LyricsFetchProgress | undefined
  embedStatus: TrackEmbedStatus | undefined
  workerReady: boolean
  loadedTrackId: string | null
  playbackTimeMs: number
  onSeekToMs: (trackId: string, timeMs: number) => void
  onFetchFocused: () => void
  onCancelFetchFocused: () => void
  onImportLrc: () => void
  onSaveDraft: () => void
  onDiscardDraft: () => void
  onEmbedFocused: () => void
  onNormalize: () => void
  /** Emits the live preview text (primary, or stacked when layers are present). */
  onPreviewTextChange: (trackId: string, text: string) => void
  /** Workspace mode from the mode bar / native View menu. */
  mode: WorkspaceMode
  onModeChange: (mode: WorkspaceMode) => void
  /** Edit-mode layout from the layout toggle / native View menu. */
  editorLayout: EditorLayout
  /** Primary text copied into the translation layer (controlled by App/menu). */
  secondaryLayerText: string
  onSecondaryLayerChange: (text: string) => void
  /** Primary text copied into the romanization layer (controlled by App/menu). */
  romanizationLayerText: string
  onRomanizationLayerChange: (text: string) => void
  // --- Candidate sifter ---
  searchTitle: string
  onSearchTitleChange: (value: string) => void
  searchArtist: string
  onSearchArtistChange: (value: string) => void
  searchAlbum: string
  onSearchAlbumChange: (value: string) => void
  searchDuration: string
  onSearchDurationChange: (value: string) => void
  searchResults: LyricsSearchResult[]
  searchLoading: boolean
  searchError: string | null
  searchSearched: boolean
  onSearchCandidates: () => void
  onLoadCandidate: (result: LyricsSearchResult) => void
}

type PreviewMode = 'primary' | 'stacked'

interface CandidateSiftingRowProps {
  result: LyricsSearchResult
  focusedDurationSec: number
  selected: boolean
  onSelect: () => void
}

function providerLabel(providerId: LyricsSearchResult['providerId']): string {
  return providerId === 'lrclib' ? 'LRCLIB' : 'Local .lrc'
}

function timingBadge(result: LyricsSearchResult): { label: string; className: string } {
  const kind =
    result.timingKind ??
    detectLyricsTimingKind(result.syncedLyrics, result.plainLyrics)
  switch (kind) {
    case 'word':
      return { label: 'Word', className: 'border-fuchsia-800/70 bg-fuchsia-950/60 text-fuchsia-300' }
    case 'line':
      return { label: 'Synced', className: 'border-emerald-800/70 bg-emerald-950/60 text-emerald-300' }
    case 'plain':
      return { label: 'Plain', className: 'border-amber-800/70 bg-amber-950/60 text-amber-300' }
    case 'instrumental':
      return { label: 'Instrumental', className: 'border-zinc-700 bg-zinc-800 text-zinc-400' }
    default:
      return { label: 'None', className: 'border-zinc-700 bg-zinc-800 text-zinc-400' }
  }
}

function durationDeltaLabel(result: LyricsSearchResult, focusedDurationSec: number): string {
  if (!(result.durationSec > 0) || !(focusedDurationSec > 0)) return 'Δ ?'
  const delta = result.durationSec - focusedDurationSec
  const rounded = Math.round(delta)
  if (rounded === 0) return 'Δ ±0s'
  return `Δ ${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}s`
}

function CandidateSiftingRow({
  result,
  focusedDurationSec,
  selected,
  onSelect
}: CandidateSiftingRowProps) {
  const badge = timingBadge(result)
  const delta = result.durationSec > 0 && focusedDurationSec > 0 ? Math.round(result.durationSec - focusedDurationSec) : null

  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        title={`${result.title} — ${result.artist || 'Unknown Artist'}${
          result.album ? ` (${result.album})` : ''
        }`}
        className={`w-full space-y-0.5 rounded border px-2 py-1.5 text-left transition-colors ${
          selected
            ? 'border-emerald-700/80 bg-emerald-950/40'
            : 'border-zinc-800 bg-zinc-900/80 hover:bg-zinc-800/80'
        }`}
      >
        <div className="flex items-center gap-1">
          <span className="shrink-0 rounded border border-sky-800/70 bg-sky-950/60 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
            {providerLabel(result.providerId)}
          </span>
          <span
            className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
          <span
            title="Duration difference against the focused track"
            className={`ml-auto shrink-0 font-mono text-[10px] tabular-nums ${
              delta !== null && Math.abs(delta) > 30
                ? 'text-red-300'
                : delta !== null && Math.abs(delta) > 5
                  ? 'text-amber-300'
                  : 'text-zinc-400'
            }`}
          >
            {durationDeltaLabel(result, focusedDurationSec)}
          </span>
        </div>
        <div className="truncate text-[11px] font-medium leading-snug text-zinc-200">
          {result.title || 'Untitled'}
        </div>
        <div className="truncate text-[10px] leading-snug text-zinc-400">
          {[result.artist || 'Unknown Artist', result.album].filter(Boolean).join(' — ')}
        </div>
      </button>
    </li>
  )
}

/** Popover that closes on outside click / Escape. */
function Popover({
  label,
  title,
  icon,
  disabled,
  children,
  align = 'left'
}: {
  label: string
  title: string
  icon: React.ReactNode
  disabled?: boolean
  children: (close: () => void) => React.ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {icon}
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 w-64 space-y-1.5 rounded-md border border-zinc-700 bg-zinc-900 p-2 shadow-xl shadow-black/50 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function LyricsEditorPanel({
  focusedTrack,
  selectedCount,
  lyricsText,
  hasDraft,
  isDirty,
  preserveWordTags,
  onPreserveWordTagsChange,
  onLyricsChange,
  fetchProgress,
  embedStatus,
  workerReady,
  loadedTrackId,
  playbackTimeMs,
  onSeekToMs,
  onFetchFocused,
  onCancelFetchFocused,
  onImportLrc,
  onSaveDraft,
  onDiscardDraft,
  onEmbedFocused,
  onNormalize,
  onPreviewTextChange,
  mode,
  onModeChange,
  editorLayout,
  secondaryLayerText,
  onSecondaryLayerChange,
  romanizationLayerText,
  onRomanizationLayerChange,
  searchTitle,
  onSearchTitleChange,
  searchArtist,
  onSearchArtistChange,
  searchAlbum,
  onSearchAlbumChange,
  searchDuration,
  onSearchDurationChange,
  searchResults,
  searchLoading,
  searchError,
  searchSearched,
  onSearchCandidates,
  onLoadCandidate
}: LyricsEditorPanelProps) {
  const [previewMode, setPreviewMode] = useState<PreviewMode>('stacked')
  const [offsetInput, setOffsetInput] = useState('')
  const [showTranslationLayer, setShowTranslationLayer] = useState(true)
  const [showRomanizationLayer, setShowRomanizationLayer] = useState(true)
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null)
  const activeLineRef = useRef<HTMLButtonElement | null>(null)

  const focusedTrackId = focusedTrack?.id ?? null

  // Reset transient view state when the focused track changes.
  useEffect(() => {
    setPreviewMode('stacked')
    setOffsetInput('')
    setSelectedCandidateKey(null)
    setShowTranslationLayer(true)
    setShowRomanizationLayer(true)
  }, [focusedTrackId])

  const primaryLines = useMemo(
    () => parseLrc(lyricsText, { preserveWordTags }),
    [lyricsText, preserveWordTags]
  )

  const hasTranslation = secondaryLayerText.trim().length > 0
  const hasRomanization = romanizationLayerText.trim().length > 0

  const stackedOutput = useMemo(() => {
    const layers = [
      lyricsText,
      showTranslationLayer ? secondaryLayerText : '',
      showRomanizationLayer ? romanizationLayerText : ''
    ].filter((layer) => layer.trim().length > 0)
    if (layers.length <= 1) return ''
    return stackLrcLayers(layers, { preserveWordTags })
  }, [
    lyricsText,
    secondaryLayerText,
    romanizationLayerText,
    preserveWordTags,
    showTranslationLayer,
    showRomanizationLayer
  ])

  const livePreviewText =
    previewMode === 'stacked' && stackedOutput.length > 0 ? stackedOutput : lyricsText
  const isStackedLive = livePreviewText !== lyricsText

  const previewLines = useMemo(
    () => parseLrc(livePreviewText, { preserveWordTags }),
    [livePreviewText, preserveWordTags]
  )

  useEffect(() => {
    if (!focusedTrackId) return
    onPreviewTextChange(focusedTrackId, livePreviewText)
  }, [focusedTrackId, livePreviewText, onPreviewTextChange])

  const isTrackPlayingOrLoaded = focusedTrack !== null && loadedTrackId === focusedTrack.id
  const activeIndices = isTrackPlayingOrLoaded
    ? findActiveLineIndices(previewLines, playbackTimeMs)
    : []
  const activeIndexSet = new Set(activeIndices)
  const firstActiveIndex = activeIndices.length > 0 ? activeIndices[0]! : -1
  const activeTimestampMs =
    firstActiveIndex >= 0 ? previewLines[firstActiveIndex]!.timeMs : null

  useEffect(() => {
    if (activeLineRef.current && isTrackPlayingOrLoaded) {
      activeLineRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeTimestampMs, isTrackPlayingOrLoaded])

  if (!focusedTrack) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/70 p-6 text-center">
        <p className="text-sm font-medium text-zinc-300">No track focused</p>
        <p className="mt-1 text-xs text-zinc-500">
          Click a track row to inspect, edit, preview timing, or embed synced lyrics.
          {selectedCount > 1 ? ` (${selectedCount} tracks selected for batch actions)` : ''}
        </p>
      </section>
    )
  }

  const isFetching = fetchProgress?.phase === 'fetching'
  const isEmbedding = embedStatus?.phase === 'embedding'
  const hasSynced = hasSyncedTimestamps(lyricsText)
  const hasPrimaryText = lyricsText.trim().length > 0
  /** Plain (untimed) lyrics still preview as readable text, never an empty box. */
  const hasTimedLines = primaryLines.length > 0
  const plainOnlyText = hasPrimaryText && !hasTimedLines

  function handleNudgeOffset(deltaMs: number) {
    if (!Number.isFinite(deltaMs) || deltaMs === 0) return
    onLyricsChange(shiftLrcOffset(lyricsText, deltaMs, { preserveWordTags }))
  }

  function handleApplyCustomOffset() {
    const parsed = Number.parseFloat(offsetInput)
    if (!Number.isFinite(parsed) || parsed === 0) return
    handleNudgeOffset(Math.round(parsed))
    setOffsetInput('')
  }

  function handleSendToTranslation() {
    onSecondaryLayerChange(lyricsText)
  }

  function handleSendToRomanization() {
    onRomanizationLayerChange(lyricsText)
  }

  function handleSwapTranslation() {
    const nextPrimary = secondaryLayerText
    const nextTranslation = lyricsText
    onLyricsChange(nextPrimary)
    onSecondaryLayerChange(nextTranslation)
  }

  function handleSwapRomanization() {
    const nextPrimary = romanizationLayerText
    const nextRomanization = lyricsText
    onLyricsChange(nextPrimary)
    onRomanizationLayerChange(nextRomanization)
  }

  function handleApplyStackedLayers() {
    if (!stackedOutput) return
    onLyricsChange(stackedOutput)
    onSecondaryLayerChange('')
    onRomanizationLayerChange('')
    onModeChange('edit')
  }

  // --- Active lyrics source chip (Limusic-style footer, left side) ---
  const sourceChip = resolveLyricsSourceChip({
    hasDraft,
    trackLyricsSource: focusedTrack.lyricsSource,
    hasFetchedCandidate: Boolean(fetchProgress?.candidate),
    hasSyncedTimestamps: hasSynced
  })
  const sourceKind: LyricsSourceKind = sourceChip.kind

  const candidateKey = (result: LyricsSearchResult, index: number): string =>
    `${result.providerId}-${result.sourceId ?? result.sourceRef ?? result.title}-${index}`

  const selectedCandidateIndex = (() => {
    if (searchResults.length === 0) return -1
    const found = searchResults.findIndex(
      (result, index) => candidateKey(result, index) === selectedCandidateKey
    )
    return found >= 0 ? found : 0
  })()
  const selectedCandidate =
    selectedCandidateIndex >= 0 ? searchResults[selectedCandidateIndex] : null
  const selectedCandidateLyrics =
    selectedCandidate?.syncedLyrics ?? selectedCandidate?.plainLyrics ?? ''

  const previewIsClickable = hasTimedLines
  // Captured after the null-guard above so the preview closure keeps a non-null type.
  const focusedTrackIdSafe = focusedTrack.id

  function renderSyncedPreview(extraClassName: string, showHeader = true) {
    return (
      <div
        className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/70 ${extraClassName}`}
      >
        {showHeader && (
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2.5 py-1 text-[11px]">
            <span className="font-medium text-zinc-400">
              Synced Preview{isStackedLive ? ' · stacked' : ''}
              {previewIsClickable ? ' (click line to seek)' : ''}
            </span>
            <span className="text-[10px] tabular-nums text-zinc-500">
              {previewLines.length} lines
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
          {previewLines.length === 0 ? (
            plainOnlyText ? (
              // No valid [mm:ss.xx] tags: show the plain text cleanly instead of
              // an empty "No synced lines" placeholder box.
              <pre className="whitespace-pre-wrap break-words p-1 font-sans text-xs leading-snug text-zinc-300">
                {lyricsText}
              </pre>
            ) : (
              <p className="p-2 text-xs text-zinc-500">
                No lyrics yet. Fetch, search (Find), or paste `[mm:ss.xx]` lines.
              </p>
            )
          ) : (
            previewLines.map((line, index) => {
              const isActive = activeTimestampMs !== null && line.timeMs === activeTimestampMs
              const isFirstActive = isActive && index === firstActiveIndex
              // Stacked layers share one timestamp: later lines are secondary.
              const isSecondaryStack = activeIndices.length > 1 && activeIndexSet.has(index) && index !== firstActiveIndex
              const interactive = previewIsClickable
              return (
                <button
                  key={`${line.timeMs}-${index}`}
                  ref={isFirstActive ? activeLineRef : undefined}
                  type="button"
                  disabled={!interactive}
                  onClick={() => interactive && onSeekToMs(focusedTrackIdSafe, line.timeMs)}
                  title={
                    interactive
                      ? `Seek to ${formatTimestamp(line.timeMs)} and play the preview`
                      : 'Plain lyrics have no timestamp to seek to'
                  }
                  className={`flex w-full items-baseline gap-2 rounded px-2 text-left transition-colors ${
                    isSecondaryStack ? 'py-0.5 text-[11px]' : 'py-1 text-xs'
                  } ${
                    isActive
                      ? isSecondaryStack
                        ? 'bg-emerald-950/50 text-emerald-300/80 ring-1 ring-inset ring-emerald-800/50'
                        : 'bg-emerald-950/80 text-emerald-200 ring-1 ring-inset ring-emerald-700/70'
                      : interactive
                        ? 'text-zinc-300 hover:bg-zinc-800/70'
                        : 'cursor-default text-zinc-300'
                  }`}
                >
                  <span
                    className={`shrink-0 font-mono text-[11px] ${
                      isSecondaryStack ? 'text-emerald-500/70' : 'text-emerald-400'
                    }`}
                  >
                    {formatTimestamp(line.timeMs)}
                  </span>
                  <span
                    className={`min-w-0 break-words leading-snug ${
                      isSecondaryStack ? 'text-zinc-400/90' : ''
                    }`}
                  >
                    {line.text || <span className="italic text-zinc-600">(instrumental)</span>}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    )
  }

  const rawEditor = (
    <textarea
      aria-label="Lyrics LRC editor"
      value={lyricsText}
      onChange={(event) => onLyricsChange(event.target.value)}
      placeholder="[00:00.00] Paste or fetch synced LRC lines..."
      title="Raw LRC editor — edits the primary layer only"
      className="h-full min-h-[120px] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
    />
  )

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      {/* Header: track identity + primary actions + Offset/Actions popovers */}
      <div className="shrink-0 space-y-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-snug text-zinc-100">
              {focusedTrack.title}
            </h2>
            <p className="truncate text-xs leading-snug text-zinc-400">
              {[focusedTrack.artist || 'Unknown Artist', focusedTrack.album]
                .filter(Boolean)
                .join(' — ')}
            </p>
            <p className="truncate font-mono text-[10px] text-zinc-500">
              {focusedTrack.format.toUpperCase()} · source: {focusedTrack.lyricsSource}
              {hasDraft ? ' · draft saved' : ''}
              {isDirty ? ' · unsaved edits' : ''}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isFetching ? (
              <button
                type="button"
                onClick={onCancelFetchFocused}
                title="Cancel the in-flight lyrics fetch for this track (LRCLIB or sibling .lrc)"
                className="inline-flex items-center gap-1 rounded border border-red-800 bg-red-950/70 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-900/70"
              >
                <XCircle className="h-3.5 w-3.5" />
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={onFetchFocused}
                title="Fetch lyrics for this track from LRCLIB or a sibling .lrc (sequential, paced requests)"
                className="inline-flex items-center gap-1 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500"
              >
                <Download className="h-3.5 w-3.5" />
                Fetch
              </button>
            )}

            <button
              type="button"
              onClick={onSaveDraft}
              disabled={!isDirty}
              title="Persist the current lyrics as a per-track draft (atomic JSON write)"
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onEmbedFocused}
              disabled={isEmbedding || !workerReady}
              title="Atomically write lyrics to the file (stages a temp copy, verifies tags, unloads playback, closes media:// handles, restores mtime)"
              className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isEmbedding ? 'Embedding...' : 'Embed'}
            </button>
          </div>
        </div>

        {/* Compact tool strip: single Offset popover + Actions popover */}
        <div className="flex flex-wrap items-center gap-1">
          <Popover
            label="Offset"
            title="Shift every timestamp in the primary LRC (positive = later)"
            icon={<Clock className="h-3 w-3" />}
            disabled={!hasSynced}
          >
            {(close) => (
              <>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    inputMode="numeric"
                    step={10}
                    value={offsetInput}
                    onChange={(event) => setOffsetInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        handleApplyCustomOffset()
                        close()
                      }
                    }}
                    placeholder="ms (e.g. 250)"
                    aria-label="Custom offset in milliseconds"
                    title="Custom offset in milliseconds applied to every timestamp"
                    className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      handleApplyCustomOffset()
                      close()
                    }}
                    disabled={!hasSynced}
                    title="Apply the custom millisecond offset"
                    className="shrink-0 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Apply
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1 border-t border-zinc-800 pt-1.5">
                  {([-500, -100, 100, 500] as const).map((delta) => (
                    <button
                      key={delta}
                      type="button"
                      onClick={() => {
                        handleNudgeOffset(delta)
                        close()
                      }}
                      disabled={!hasSynced}
                      title={`Shift every timestamp ${Math.abs(delta)}ms ${
                        delta > 0 ? 'later' : 'earlier'
                      }`}
                      className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 font-mono text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {delta > 0 ? `+${delta}` : delta} ms
                    </button>
                  ))}
                </div>
              </>
            )}
          </Popover>

          <Popover
            label="Actions"
            title="Secondary tools (also available in the native File / Edit menus)"
            icon={<SlidersHorizontal className="h-3 w-3" />}
          >
            {(close) => (
              <div className="space-y-1">
                <button
                  type="button"
                  disabled={!hasSynced}
                  onClick={() => {
                    onNormalize()
                    close()
                  }}
                  title="Bake [offset:±ms] into the timestamps and strip [length:]/metadata headers"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Sparkles className="h-3 w-3" />
                  Normalize
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onImportLrc()
                    close()
                  }}
                  title="Import a local .lrc file as this track's draft (UTF-8, ≤1 MiB, symlinks rejected)"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800"
                >
                  <FileUp className="h-3 w-3" />
                  Import .lrc
                </button>
                <label
                  title="Retain <mm:ss.xx> word-level A2 tags instead of stripping them"
                  className="flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                >
                  <input
                    type="checkbox"
                    checked={preserveWordTags}
                    onChange={(event) => onPreserveWordTagsChange(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950 accent-emerald-500"
                  />
                  Preserve A2 &lt;mm:ss.xx&gt;
                </label>
                <div className="my-1 border-t border-zinc-800" />
                <button
                  type="button"
                  disabled={!hasPrimaryText}
                  onClick={() => {
                    handleSendToTranslation()
                    onModeChange('layers')
                    close()
                  }}
                  title="Copy the primary LRC into the translation layer (primary stays untouched)"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  → Send to Translation
                </button>
                <button
                  type="button"
                  disabled={!hasPrimaryText}
                  onClick={() => {
                    handleSendToRomanization()
                    onModeChange('layers')
                    close()
                  }}
                  title="Copy the primary LRC into the romanization layer (primary stays untouched)"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  → Send to Romanization
                </button>
                <button
                  type="button"
                  disabled={!hasTranslation}
                  onClick={() => {
                    handleSwapTranslation()
                    close()
                  }}
                  title="Swap the primary LRC with the translation layer"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ⇄ Swap Translation
                </button>
                <button
                  type="button"
                  disabled={!hasRomanization}
                  onClick={() => {
                    handleSwapRomanization()
                    close()
                  }}
                  title="Swap the primary LRC with the romanization layer"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ⇄ Swap Romanization
                </button>
                <div className="my-1 border-t border-zinc-800" />
                <button
                  type="button"
                  disabled={!hasDraft && !isDirty}
                  onClick={() => {
                    onDiscardDraft()
                    close()
                  }}
                  title={
                    hasDraft
                      ? 'Delete the saved draft and restore the lyrics embedded in the file'
                      : 'Revert the unsaved edits back to the embedded lyrics'
                  }
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3 w-3" />
                  Discard Draft
                </button>
              </div>
            )}
          </Popover>

          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-500">
            {primaryLines.length} lines
            {isStackedLive ? ' · stacked' : ''}
          </span>
        </div>
      </div>

      {/* Workspace body */}
      {mode === 'edit' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5">
          {editorLayout === 'raw' && <div className="flex min-h-0 flex-1">{rawEditor}</div>}
          {editorLayout === 'split' && (
            <div className="flex min-h-0 flex-1 gap-2">
              <div className="flex min-h-0 w-1/2 min-w-0">{rawEditor}</div>
              <div className="flex min-h-0 w-1/2 min-w-0">
                {renderSyncedPreview('h-full w-full')}
              </div>
            </div>
          )}
          {editorLayout === 'preview' && (
            <div className="flex min-h-0 flex-1">{renderSyncedPreview('h-full w-full')}</div>
          )}
        </div>
      )}

      {mode === 'layers' && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2.5">
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
            {(
              [
                {
                  key: 'primary',
                  label: 'Primary',
                  value: lyricsText,
                  onChange: onLyricsChange,
                  // Swapping the primary column swaps it with the layer that has
                  // content (translation first, then romanization).
                  onSwap: hasTranslation
                    ? handleSwapTranslation
                    : hasRomanization
                      ? handleSwapRomanization
                      : null,
                  onClear: () => onLyricsChange('')
                },
                {
                  key: 'translation',
                  label: 'Translation',
                  value: secondaryLayerText,
                  onChange: onSecondaryLayerChange,
                  onSwap: handleSwapTranslation,
                  onClear: () => onSecondaryLayerChange('')
                },
                {
                  key: 'romanization',
                  label: 'Romanization',
                  value: romanizationLayerText,
                  onChange: onRomanizationLayerChange,
                  onSwap: handleSwapRomanization,
                  onClear: () => onRomanizationLayerChange('')
                }
              ] as const
            ).map((column) => (
              <div key={column.key} className="flex min-h-0 min-w-0 flex-col gap-1">
                <div className="flex shrink-0 items-center justify-between gap-1">
                  <span className="truncate text-[11px] font-medium text-zinc-300">
                    {column.label}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {column.onSwap && (
                      <button
                        type="button"
                        disabled={column.value.trim().length === 0}
                        onClick={column.onSwap}
                        title={`Swap ${column.label} with the primary LRC`}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Swap
                      </button>
                    )}
                    {column.onClear && (
                      <button
                        type="button"
                        disabled={column.value.trim().length === 0}
                        onClick={column.onClear}
                        title={`Clear the ${column.label} layer`}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  aria-label={`${column.label} layer LRC editor`}
                  value={column.value}
                  onChange={(event) => column.onChange(event.target.value)}
                  placeholder={
                    column.key === 'primary'
                      ? '[00:01.00] Primary line...'
                      : `[00:01.00] ${column.label} line matching primary timestamps...`
                  }
                  title={`${column.label} layer — stacked with the primary at matching timestamps`}
                  className="min-h-0 w-full flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap shrink-0 items-center justify-between gap-1.5">
            <div
              className="inline-flex overflow-hidden rounded border border-zinc-700"
              role="group"
              aria-label="Preview mode"
            >
              <button
                type="button"
                aria-pressed={previewMode === 'primary'}
                onClick={() => setPreviewMode('primary')}
                title="Preview only the primary LRC in the clickable list and the audio player"
                className={`px-1.5 py-1 text-[10px] font-medium ${
                  previewMode === 'primary'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                Preview: Primary
              </button>
              <button
                type="button"
                aria-pressed={previewMode === 'stacked'}
                onClick={() => setPreviewMode('stacked')}
                title="Preview primary + translation + romanization stacked; also feeds the audio player's active lines"
                className={`border-l border-zinc-700 px-1.5 py-1 text-[10px] font-medium ${
                  previewMode === 'stacked'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                Stacked
              </button>
            </div>

            <button
              type="button"
              disabled={!stackedOutput}
              onClick={handleApplyStackedLayers}
              title="Merge primary + layers into the editor using same-timestamp stacking"
              className="inline-flex shrink-0 items-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Layers className="h-3 w-3" />
              Apply Stacked to Primary
            </button>
          </div>
        </div>
      )}

      {mode === 'find' && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2.5">
          {/* Single-row query bar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <input
              type="text"
              value={searchTitle}
              onChange={(event) => onSearchTitleChange(event.target.value)}
              placeholder="Title"
              title="Search title override (pre-filled from the focused track)"
              className="min-w-0 flex-[2] rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <input
              type="text"
              value={searchArtist}
              onChange={(event) => onSearchArtistChange(event.target.value)}
              placeholder="Artist"
              title="Search artist override (pre-filled from the focused track)"
              className="min-w-0 flex-[1.5] rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <input
              type="text"
              value={searchAlbum}
              onChange={(event) => onSearchAlbumChange(event.target.value)}
              placeholder="Album"
              title="Search album override (pre-filled from the focused track)"
              className="min-w-0 flex-[1.5] rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <input
              type="text"
              inputMode="decimal"
              value={searchDuration}
              onChange={(event) => onSearchDurationChange(event.target.value)}
              placeholder="Sec"
              title="Search duration in seconds (pre-filled from the focused track)"
              className="w-14 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={onSearchCandidates}
              disabled={searchLoading}
              title="Query the sibling .lrc and LRCLIB (sequential, paced requests with Retry-After handling)"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {searchLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Search className="h-3 w-3" />
              )}
              {searchLoading ? 'Searching...' : 'Search'}
            </button>
          </div>

          {!searchLoading && searchError && (
            <p className="shrink-0 truncate text-[11px] text-red-300" title={searchError}>
              {searchError}
            </p>
          )}

          {/* Two-column candidate sifter: list on the left, live preview right */}
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-2">
            <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
                <span>Candidates</span>
                <span className="tabular-nums">
                  {searchLoading ? 'searching…' : `${searchResults.length}`}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {searchResults.length > 0 ? (
                  <ul className="space-y-1">
                    {searchResults.map((result, index) => {
                      const key = candidateKey(result, index)
                      return (
                        <CandidateSiftingRow
                          key={key}
                          result={result}
                          focusedDurationSec={focusedTrack.durationSec}
                          selected={index === selectedCandidateIndex}
                          onSelect={() => setSelectedCandidateKey(key)}
                        />
                      )
                    })}
                  </ul>
                ) : searchSearched && !searchLoading ? (
                  <p className="p-2 text-[11px] text-zinc-500">
                    No candidates matched those fields. Adjust the search and try again.
                  </p>
                ) : (
                  <p className="p-2 text-[11px] text-zinc-500">
                    Press Search to list a sibling `.lrc` first, then LRCLIB matches.
                  </p>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-2 py-1">
                <span className="min-w-0 truncate text-[11px] font-medium text-zinc-300">
                  {selectedCandidate
                    ? `${providerLabel(selectedCandidate.providerId)} — ${selectedCandidate.title}`
                    : 'Live lyric preview'}
                </span>
                {selectedCandidate && (
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                    {durationDeltaLabel(selectedCandidate, focusedTrack.durationSec)}
                  </span>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
                  {selectedCandidate
                    ? selectedCandidateLyrics || '(no lyrics payload — instrumental)'
                    : 'Select a candidate to preview its lyrics here.'}
                </pre>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-zinc-800 p-1.5">
                <button
                  type="button"
                  disabled={!selectedCandidateLyrics}
                  onClick={() => selectedCandidate && onLoadCandidate(selectedCandidate)}
                  title="Replace the primary LRC with this candidate's synced (or plain) lyrics and save it as a draft"
                  className="rounded border border-emerald-700/80 bg-emerald-950/60 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Load Primary
                </button>
                <button
                  type="button"
                  disabled={!selectedCandidateLyrics}
                  onClick={() => {
                    if (selectedCandidateLyrics) onSecondaryLayerChange(selectedCandidateLyrics)
                  }}
                  title="Put this candidate's lyrics into the translation layer (keeps the primary untouched)"
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  To Translation
                </button>
                <button
                  type="button"
                  disabled={!selectedCandidateLyrics}
                  onClick={() => {
                    if (selectedCandidateLyrics) onRomanizationLayerChange(selectedCandidateLyrics)
                  }}
                  title="Put this candidate's lyrics into the romanization layer (keeps the primary untouched)"
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  To Romanization
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Limusic-style footer strip: source chip + layer visibility toggles */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-800 bg-zinc-950/60 px-2 py-1">
        <button
          type="button"
          onClick={() => onModeChange('find')}
          title="Active lyrics source — click to open Find and pick another candidate"
          className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${sourceChip.className}`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              sourceKind === 'none' ? 'bg-red-400' : 'bg-current'
            }`}
          />
          <span className="truncate">{sourceChip.label}</span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {hasTranslation && (
            <button
              type="button"
              aria-pressed={showTranslationLayer}
              onClick={() => setShowTranslationLayer((prev) => !prev)}
              title="Toggle whether the translation layer appears in the live stacked preview (never overwrites the primary)"
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                showTranslationLayer
                  ? 'border-emerald-800/70 bg-emerald-950/60 text-emerald-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Translation
            </button>
          )}
          {hasRomanization && (
            <button
              type="button"
              aria-pressed={showRomanizationLayer}
              onClick={() => setShowRomanizationLayer((prev) => !prev)}
              title="Toggle whether the romanization layer appears in the live stacked preview (never overwrites the primary)"
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                showRomanizationLayer
                  ? 'border-emerald-800/70 bg-emerald-950/60 text-emerald-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Romanization
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
