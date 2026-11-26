import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Clock,
  FileUp,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X
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
import {
  isValidInlineTimestamp,
  parseEditableRows,
  parseInlineTimestamp,
  serializeEditableLayer,
  serializeEditableRows,
  type EditableLrcRow
} from '@shared/lrcEditor'
import type { TrackEmbedStatus } from '../types'
import { resolveLyricsSourceChip, type LyricsSourceKind } from './lyricsSourceChip'

export interface LyricsEditorPanelProps {
  focusedTrack: TrackRecord | null
  selectedCount: number
  lyricsText: string
  hasDraft: boolean
  /** Auto-save indicator state (`idle` / `saving` / `saved` / `error`). */
  autoSaveState: 'idle' | 'saving' | 'saved' | 'error'
  preserveWordTags: boolean
  onPreserveWordTagsChange: (value: boolean) => void
  onLyricsChange: (nextLyrics: string) => void
  fetchProgress: LyricsFetchProgress | undefined
  embedStatus: TrackEmbedStatus | undefined
  workerReady: boolean
  loadedTrackId: string | null
  playbackTimeMs: number
  onSeekToMs: (trackId: string, timeMs: number) => void
  onImportLrc: () => void
  /** Revert to the lyrics embedded in the file (deletes the draft). */
  onRevert: () => void
  onEmbedFocused: () => void
  onNormalize: () => void
  /** Emits the live preview text (primary, or stacked when layers are present). */
  onPreviewTextChange: (trackId: string, text: string) => void
  /** Workspace mode from the mode bar / native View menu. */
  mode: WorkspaceMode
  onModeChange: (mode: WorkspaceMode) => void
  /** Edit-mode layout from the layout toggle / native View menu. */
  editorLayout: EditorLayout
  /** Layout toggle handler (the panel's Raw Text button drives App state). */
  onEditorLayoutChange: (layout: EditorLayout) => void
  /** Primary text copied into the translation layer (controlled by App/menu). */
  secondaryLayerText: string
  onSecondaryLayerChange: (text: string) => void
  /** Primary text copied into the romanization layer (controlled by App/menu). */
  romanizationLayerText: string
  onRomanizationLayerChange: (text: string) => void
  /** Layer visibility (preview + embed merging); never overwrites the primary. */
  showTranslationLayer: boolean
  onShowTranslationLayerChange: (value: boolean) => void
  showRomanizationLayer: boolean
  onShowRomanizationLayerChange: (value: boolean) => void
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
  /** Loads primary + every bundled layer of a candidate in one action. */
  onLoadAllLayers: (result: LyricsSearchResult) => void
  /** Active provider filter (`all` or a concrete provider id). */
  providerFilter: LyricsProviderFilter
  onProviderFilterChange: (filter: LyricsProviderFilter) => void
  /** Opens the AI Settings dialog (gear button in the Find/Layers header). */
  onOpenSettings: () => void
  /** Which AI generation (if any) is currently in flight for this track. */
  aiJob: AiJobState | null
  /** Starts an AI generation into a secondary layer. */
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  /** Cancels the in-flight AI generation. */
  onAiCancel: () => void
  /** True when the AI provider has a usable configuration (key or loopback). */
  aiConfigured: boolean
}

/** Provider filter for the Find sifter (`all` = no filtering). */
export type LyricsProviderFilter = 'all' | 'localSidecar' | 'lrclib' | 'netease'

/** In-flight AI generation state surfaced by `App`. */
export interface AiJobState {
  mode: 'translation' | 'romanization'
  jobId: string
}

interface CandidateSiftingRowProps {
  result: LyricsSearchResult
  focusedDurationSec: number
  selected: boolean
  onSelect: () => void
}

function providerLabel(providerId: LyricsSearchResult['providerId']): string {
  if (providerId === 'lrclib') return 'LRCLIB'
  if (providerId === 'netease') return 'NetEase'
  return 'Local .lrc'
}

/** True when the candidate ships a usable same-timestamp translation layer. */
export function hasTranslationLayer(result: LyricsSearchResult): boolean {
  return typeof result.translatedLyrics === 'string' && result.translatedLyrics.trim().length > 0
}

/** True when the candidate ships a usable same-timestamp romanization layer. */
export function hasRomanizationLayer(result: LyricsSearchResult): boolean {
  return typeof result.romanizedLyrics === 'string' && result.romanizedLyrics.trim().length > 0
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
          {hasTranslationLayer(result) && (
            <span
              title="Ships a bundled translation layer"
              className="shrink-0 rounded border border-sky-800/70 bg-sky-950/60 px-1 py-0.5 text-[9px] font-semibold text-sky-300"
            >
              +T
            </span>
          )}
          {hasRomanizationLayer(result) && (
            <span
              title="Ships a bundled romanization layer"
              className="shrink-0 rounded border border-violet-800/70 bg-violet-950/60 px-1 py-0.5 text-[9px] font-semibold text-violet-300"
            >
              +R
            </span>
          )}
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

/**
 * Opt-in AI layer action. While its job runs it turns into an inline Cancel so
 * the user never has to hunt for the abort control.
 */
function AiLayerButton({
  mode,
  label,
  aiJob,
  disabled,
  aiConfigured,
  onAiGenerate,
  onAiCancel,
  className
}: {
  mode: 'translation' | 'romanization'
  label: string
  aiJob: AiJobState | null
  disabled: boolean
  aiConfigured: boolean
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  onAiCancel: () => void
  className: string
}): React.JSX.Element {
  const running = aiJob?.mode === mode
  const otherRunning = aiJob !== null && !running

  if (running) {
    return (
      <button
        type="button"
        onClick={onAiCancel}
        title="Cancel the in-flight AI request"
        className={`${className} border-amber-700/80 bg-amber-950/60 text-amber-200 hover:bg-amber-900/60`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Cancel
      </button>
    )
  }

  return (
    <button
      type="button"
      disabled={disabled || otherRunning}
      onClick={() => onAiGenerate(mode)}
      title={
        aiConfigured
          ? `${label} with the configured AI provider (writes only the ${mode} layer)`
          : 'Configure an AI provider first (Settings…)'
      }
      className={`${className} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <Sparkles className="h-3 w-3" />
      {label}
    </button>
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
  autoSaveState,
  preserveWordTags,
  onPreserveWordTagsChange,
  onLyricsChange,
  fetchProgress,
  embedStatus,
  workerReady,
  loadedTrackId,
  playbackTimeMs,
  onSeekToMs,
  onImportLrc,
  onRevert,
  onEmbedFocused,
  onNormalize,
  onPreviewTextChange,
  mode,
  onModeChange,
  editorLayout,
  onEditorLayoutChange,
  secondaryLayerText,
  onSecondaryLayerChange,
  romanizationLayerText,
  onRomanizationLayerChange,
  showTranslationLayer,
  onShowTranslationLayerChange,
  showRomanizationLayer,
  onShowRomanizationLayerChange,
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
  onLoadCandidate,
  onLoadAllLayers,
  providerFilter,
  onProviderFilterChange,
  onOpenSettings,
  aiJob,
  onAiGenerate,
  onAiCancel,
  aiConfigured
}: LyricsEditorPanelProps) {
  const [offsetInput, setOffsetInput] = useState('')
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null)
  /** Timestamp currently open for inline editing (row key), if any. */
  const [editingTimestampKey, setEditingTimestampKey] = useState<number | null>(null)
  const [timestampDraft, setTimestampDraft] = useState('')
  const activeRowRef = useRef<HTMLDivElement | null>(null)
  /**
   * Rows the user inserted but has not typed into yet. They are serialized into
   * the primary layer as empty lines so the new row survives the round-trip
   * instead of vanishing on the next keystroke.
   */
  const pendingEmptyRowKeysRef = useRef<Set<number>>(new Set())

  const focusedTrackId = focusedTrack?.id ?? null

  // Reset transient view state when the focused track changes.
  useEffect(() => {
    setOffsetInput('')
    setSelectedCandidateKey(null)
    setEditingTimestampKey(null)
    setTimestampDraft('')
    pendingEmptyRowKeysRef.current.clear()
  }, [focusedTrackId])

  const primaryLines = useMemo(
    () => parseLrc(lyricsText, { preserveWordTags }),
    [lyricsText, preserveWordTags]
  )

  const hasSynced = hasSyncedTimestamps(lyricsText)
  const hasPrimaryText = lyricsText.trim().length > 0
  /** Plain (untimed) lyrics still get a clean editable textarea, never an empty box. */
  const hasTimedLines = primaryLines.length > 0

  const hasTranslation = secondaryLayerText.trim().length > 0
  const hasRomanization = romanizationLayerText.trim().length > 0

  /**
   * Layer text that is currently *enabled*: only enabled, non-empty layers are
   * stacked into the preview (and later into an embed). The primary is never
   * modified by these toggles.
   */
  const enabledLayers = useMemo(() => {
    const layers: string[] = []
    if (showTranslationLayer && hasTranslation) layers.push(secondaryLayerText)
    if (showRomanizationLayer && hasRomanization) layers.push(romanizationLayerText)
    return layers
  }, [
    showTranslationLayer,
    hasTranslation,
    secondaryLayerText,
    showRomanizationLayer,
    hasRomanization,
    romanizationLayerText
  ])

  const stackedOutput = useMemo(() => {
    if (enabledLayers.length === 0) return ''
    return stackLrcLayers([lyricsText, ...enabledLayers], { preserveWordTags })
  }, [lyricsText, enabledLayers, preserveWordTags])

  const livePreviewText = stackedOutput.length > 0 ? stackedOutput : lyricsText
  const isStackedLive = livePreviewText !== lyricsText

  const previewLines = useMemo(
    () => parseLrc(livePreviewText, { preserveWordTags }),
    [livePreviewText, preserveWordTags]
  )

  // Editable rows: the single source of truth for the live editor.
  const editableRows = useMemo(
    () => parseEditableRows(lyricsText, secondaryLayerText, romanizationLayerText, { preserveWordTags }),
    [lyricsText, secondaryLayerText, romanizationLayerText, preserveWordTags]
  )
  // Write-back helpers: rows -> primary/translation/romanization text.
  const commitRows = useCallback(
    (rows: EditableLrcRow[]) => {
      const pending = pendingEmptyRowKeysRef.current
      for (const row of rows) {
        if (row.text.trim().length > 0) pending.delete(row.key)
      }
      // Keep freshly inserted empty rows; drop untouched layer-only rows from
      // the primary so stacking never duplicates content into it.
      onLyricsChange(
        serializeEditableRows(
          rows.filter((row) => row.text.trim().length > 0 || pending.has(row.key)),
          { preserveWordTags }
        )
      )
      onSecondaryLayerChange(serializeEditableLayer(rows, 'translation', { preserveWordTags }))
      onRomanizationLayerChange(serializeEditableLayer(rows, 'romanization', { preserveWordTags }))
    },
    [onLyricsChange, onSecondaryLayerChange, onRomanizationLayerChange, preserveWordTags]
  )

  function updateRow(
    row: EditableLrcRow,
    patch: Partial<Pick<EditableLrcRow, 'timeMs' | 'text' | 'translation' | 'romanization'>>
  ) {
    const nextKey = patch.timeMs !== undefined ? Math.round(patch.timeMs / 10) : row.key
    if (nextKey !== row.key && pendingEmptyRowKeysRef.current.delete(row.key)) {
      pendingEmptyRowKeysRef.current.add(nextKey)
    }
    const next = editableRows.map((candidate) =>
      candidate.key === row.key ? { ...candidate, ...patch, key: nextKey } : candidate
    )
    next.sort((a, b) => a.timeMs - b.timeMs)
    commitRows(next)
  }

  function insertRowAfter(row: EditableLrcRow | null) {
    let nextTimeMs = row ? row.timeMs + 1000 : 0
    // Nudge forward until the timestamp is free (rows are keyed by centiseconds).
    const taken = new Set(editableRows.map((candidate) => Math.round(candidate.timeMs / 10)))
    while (taken.has(Math.round(nextTimeMs / 10))) nextTimeMs += 10
    const inserted: EditableLrcRow = {
      key: Math.round(nextTimeMs / 10),
      timeMs: nextTimeMs,
      text: '',
      translation: '',
      romanization: '',
      createsOnlyFromLayers: false
    }
    pendingEmptyRowKeysRef.current.add(inserted.key)
    const next = [...editableRows, inserted].sort((a, b) => a.timeMs - b.timeMs)
    commitRows(next)
  }

  function removeRow(row: EditableLrcRow) {
    pendingEmptyRowKeysRef.current.delete(row.key)
    commitRows(editableRows.filter((candidate) => candidate.key !== row.key))
  }

  function commitTimestampEdit(row: EditableLrcRow) {
    const parsed = parseInlineTimestamp(timestampDraft)
    setEditingTimestampKey(null)
    setTimestampDraft('')
    if (!parsed || parsed.timeMs === row.timeMs) return
    updateRow(row, { timeMs: parsed.timeMs })
  }

  useEffect(() => {
    if (!focusedTrackId) return
    onPreviewTextChange(focusedTrackId, livePreviewText)
  }, [focusedTrackId, livePreviewText, onPreviewTextChange])

  const isTrackPlayingOrLoaded = focusedTrack !== null && loadedTrackId === focusedTrack.id
  const activeIndices = isTrackPlayingOrLoaded
    ? findActiveLineIndices(previewLines, playbackTimeMs)
    : []
  const firstActiveIndex = activeIndices.length > 0 ? activeIndices[0]! : -1
  const activeTimestampMs =
    firstActiveIndex >= 0 ? previewLines[firstActiveIndex]!.timeMs : null
  /** Rows highlighted together (same timestamp after stacking). */
  const activeRowKeys = useMemo(() => {
    if (activeTimestampMs === null) return new Set<number>()
    return new Set(
      activeIndices.map((index) => previewLines[index]!.timeMs)
    )
  }, [activeIndices, activeTimestampMs, previewLines])

  // Auto-scroll only when the active timestamp changes AND the user is not
  // typing inside the editor.
  useEffect(() => {
    if (!isTrackPlayingOrLoaded || activeTimestampMs === null) return
    const activeElement = document.activeElement
    const isEditing =
      activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
    if (isEditing) return
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeTimestampMs, isTrackPlayingOrLoaded])

  /**
   * Provider filter is applied client-side: results come from one search pass
   * so switching pills is instant and never re-queries the network.
   *
   * NOTE: this hook must stay above the `!focusedTrack` early return. Placing it
   * after the return changes the hook order between renders and triggers React
   * error #310 ("Rendered more hooks than during the previous render").
   */
  const visibleResults = useMemo(
    () =>
      providerFilter === 'all'
        ? searchResults
        : searchResults.filter((result) => result.providerId === providerFilter),
    [searchResults, providerFilter]
  )

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

  const isEmbedding = embedStatus?.phase === 'embedding'

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

  /** Footer toggles change preview/embed visibility only, never the primary. */
  function handleToggleTranslationLayer() {
    onShowTranslationLayerChange(!showTranslationLayer)
  }

  function handleToggleRomanizationLayer() {
    onShowRomanizationLayerChange(!showRomanizationLayer)
  }

  /** Revert deletes the draft, restores the embedded tags, and clears layers. */
  function handleRevert() {
    setEditingTimestampKey(null)
    onRevert()
  }

  // --- Active lyrics source chip (Limusic-style footer, left side) ---
  const hasDraftForTrack = hasDraft
  const trackLyricsSource = focusedTrack.lyricsSource
  const hasFetchedCandidate = Boolean(fetchProgress?.candidate)
  const sourceChip = resolveLyricsSourceChip({
    hasDraft: hasDraftForTrack,
    trackLyricsSource,
    hasFetchedCandidate,
    hasSyncedTimestamps: hasSynced
  })
  const sourceKind: LyricsSourceKind = sourceChip.kind

  const candidateKey = (result: LyricsSearchResult, index: number): string =>
    `${result.providerId}-${result.sourceId ?? result.sourceRef ?? result.title}-${index}`

  const selectedCandidateIndex = (() => {
    if (visibleResults.length === 0) return -1
    const found = visibleResults.findIndex(
      (result, index) => candidateKey(result, index) === selectedCandidateKey
    )
    return found >= 0 ? found : 0
  })()
  const selectedCandidate =
    selectedCandidateIndex >= 0 ? visibleResults[selectedCandidateIndex] : null
  const selectedCandidateLyrics =
    selectedCandidate?.syncedLyrics ?? selectedCandidate?.plainLyrics ?? ''

  const previewIsClickable = hasTimedLines

  /** Editable text cell used for the primary line and its indented layers. */
  function renderTextInput(
    row: EditableLrcRow,
    field: 'text' | 'translation' | 'romanization',
    extraClassName: string
  ) {
    const value = row[field]
    return (
      <input
        type="text"
        value={value}
        aria-label={`${field === 'text' ? 'Primary' : field === 'translation' ? 'Translation' : 'Romanization'} line at ${formatTimestamp(row.timeMs)}`}
        placeholder={
          field === 'text'
            ? '(instrumental / empty line)'
            : field === 'translation'
              ? 'Translation…'
              : 'Romanization…'
        }
        onChange={(event) => updateRow(row, { [field]: event.target.value })}
        className={`min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-zinc-100 placeholder:text-zinc-600 hover:border-zinc-700 focus:border-emerald-500 focus:bg-zinc-950/70 focus:outline-none ${extraClassName}`}
      />
    )
  }

  /** Unified live synced editor: one editable row per timestamp. */
  function renderLiveRows() {
    const seekTrackId = focusedTrack?.id
    if (!seekTrackId) return null
    return (
      <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/70">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2.5 py-1 text-[11px]">
          <span className="font-medium text-zinc-400">
            Live Editor{isStackedLive ? ' · stacked' : ''}
            {previewIsClickable ? ' (click a timestamp to seek, double-click to edit)' : ''}
          </span>
          <span className="text-[10px] tabular-nums text-zinc-500">
            {editableRows.length} rows
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {editableRows.length === 0 ? (
            <div className="space-y-2 p-2">
              <p className="text-xs text-zinc-500">
                No `[mm:ss.xx]` timestamps yet. Open <span className="text-zinc-300">Find</span> to
                load synced lyrics, or switch to <span className="text-zinc-300">Raw Text</span> to
                paste plain text.
              </p>
            </div>
          ) : (
            editableRows.map((row) => {
              const isActive = activeRowKeys.has(row.timeMs)
              const isEditingTimestamp = editingTimestampKey === row.key
              return (
                <div
                  key={row.key}
                  ref={isActive && row.timeMs === activeTimestampMs ? activeRowRef : undefined}
                  className={`group flex gap-1 rounded px-1 py-0.5 ${
                    isActive
                      ? 'bg-emerald-950/70 ring-1 ring-inset ring-emerald-700/60'
                      : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex shrink-0 items-start gap-1 pt-0.5">
                    {isEditingTimestamp ? (
                      <input
                        type="text"
                        autoFocus
                        value={timestampDraft}
                        onChange={(event) => setTimestampDraft(event.target.value)}
                        onBlur={() => commitTimestampEdit(row)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            commitTimestampEdit(row)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            setEditingTimestampKey(null)
                            setTimestampDraft('')
                          }
                        }}
                        aria-label={`Edit timestamp for row at ${formatTimestamp(row.timeMs)}`}
                        className={`w-[72px] rounded border px-0.5 py-0 font-mono text-[11px] text-zinc-100 focus:outline-none ${
                          isValidInlineTimestamp(timestampDraft)
                            ? 'border-emerald-500 bg-zinc-950'
                            : 'border-red-600 bg-zinc-950'
                        }`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSeekToMs(seekTrackId, row.timeMs)}
                        onDoubleClick={() => {
                          setTimestampDraft(formatTimestamp(row.timeMs))
                          setEditingTimestampKey(row.key)
                        }}
                        title="Click to seek the audio preview; double-click to edit this timestamp"
                        className="rounded px-0.5 font-mono text-[11px] text-emerald-400 hover:bg-zinc-800"
                      >
                        {formatTimestamp(row.timeMs)}
                      </button>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-center gap-1">
                      {renderTextInput(
                        row,
                        'text',
                        isActive ? 'font-medium text-emerald-100' : 'text-[12.5px]'
                      )}
                    </div>

                    {showTranslationLayer && hasTranslation && (
                      <div className="flex min-w-0 items-center gap-1 pl-3">
                        <span
                          aria-hidden
                          className="w-1 shrink-0 self-stretch rounded bg-sky-800/60"
                        />
                        {renderTextInput(row, 'translation', 'text-[11px] text-sky-200/90')}
                      </div>
                    )}
                    {showRomanizationLayer && hasRomanization && (
                      <div className="flex min-w-0 items-center gap-1 pl-3">
                        <span
                          aria-hidden
                          className="w-1 shrink-0 self-stretch rounded bg-violet-800/60"
                        />
                        {renderTextInput(row, 'romanization', 'text-[11px] text-violet-200/90')}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-start gap-0.5 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => insertRowAfter(row)}
                      title="Insert a new line one second below"
                      aria-label={`Insert a line after ${formatTimestamp(row.timeMs)}`}
                      className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-emerald-300"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(row)}
                      title="Remove this line (all layers)"
                      aria-label={`Remove the line at ${formatTimestamp(row.timeMs)}`}
                      className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-red-300"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    )
  }

  const rawEditor = (
    <textarea
      aria-label="Raw LRC editor"
      value={lyricsText}
      onChange={(event) => onLyricsChange(event.target.value)}
      placeholder="[00:00.00] Paste or fetch synced LRC lines..."
      title="Raw LRC editor — edits the primary layer as plain monospace text"
      className="h-full min-h-[120px] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
    />
  )

  const embedLabel =
    (showTranslationLayer && hasTranslation) || (showRomanizationLayer && hasRomanization)
      ? 'Embed Stacked'
      : 'Embed'

  const autoSaveLabel =
    autoSaveState === 'saving'
      ? 'Saving...'
      : autoSaveState === 'saved'
        ? 'Draft saved'
        : autoSaveState === 'error'
          ? 'Save failed'
          : ''
  const autoSaveClass =
    autoSaveState === 'saving'
      ? 'text-amber-400/90'
      : autoSaveState === 'error'
        ? 'text-red-400/90'
        : 'text-emerald-400/80'

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      {/* Header: track identity, auto-save indicator, Revert + Embed */}
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
            <p className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] text-zinc-500">
              <span className="truncate">
                {focusedTrack.format.toUpperCase()} · source: {focusedTrack.lyricsSource}
                {hasDraft ? ' · draft' : ''}
              </span>
              <span
                role="status"
                aria-live="polite"
                title={
                  autoSaveState === 'error'
                    ? 'The draft could not be saved. Your edits are still in the editor; retry by editing again.'
                    : undefined
                }
                className={`shrink-0 ${autoSaveClass}`}
              >
                {autoSaveLabel}
              </span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleRevert}
              disabled={!hasDraft}
              title="Delete the draft, restore the lyrics embedded in the file, and clear the translation/romanization layers"
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Revert
            </button>
            <button
              type="button"
              onClick={onEmbedFocused}
              disabled={isEmbedding || !workerReady}
              title="Atomically write lyrics to the file (stages a temp copy, verifies tags, unloads playback, closes media:// handles, restores mtime)"
              className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isEmbedding ? 'Embedding...' : embedLabel}
            </button>
          </div>
        </div>

        {/* Mode bar: workspace modes + Raw Text toggle + Offset/Actions popovers */}
        <div className="flex flex-wrap items-center gap-1">
          <div
            className="inline-flex overflow-hidden rounded border border-zinc-700"
            role="group"
            aria-label="Workspace mode"
          >
            {(
              [
                { id: 'edit', label: 'Edit' },
                { id: 'layers', label: 'Layers' },
                { id: 'find', label: 'Find' }
              ] as const
            ).map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={mode === entry.id}
                onClick={() => onModeChange(entry.id)}
                title={
                  entry.id === 'edit'
                    ? 'Edit: live synced rows (Ctrl+1)'
                    : entry.id === 'layers'
                      ? 'Layers: translation + romanization columns (Ctrl+2)'
                      : 'Find: candidate sifter (Ctrl+3)'
                }
                className={`${index > 0 ? 'border-l border-zinc-700 ' : ''}px-2 py-0.5 text-[11px] font-medium ${
                  mode === entry.id
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-pressed={editorLayout === 'raw'}
            onClick={() => onEditorLayoutChange(editorLayout === 'raw' ? 'live' : 'raw')}
            title={
              editorLayout === 'raw'
                ? 'Raw Text is on — switch back to the live editable rows'
                : 'Switch to a single monospace Raw Text editor'
            }
            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
              editorLayout === 'raw'
                ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
                : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            }`}
          >
            Raw Text
          </button>

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
                <AiLayerButton
                  mode="translation"
                  label="AI Translate → Translation"
                  aiJob={aiJob}
                  disabled={!hasSynced}
                  aiConfigured={aiConfigured}
                  onAiGenerate={(mode) => {
                    onAiGenerate(mode)
                    close()
                  }}
                  onAiCancel={onAiCancel}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] font-medium"
                />
                <AiLayerButton
                  mode="romanization"
                  label="AI Romanize → Romanization"
                  aiJob={aiJob}
                  disabled={!hasSynced}
                  aiConfigured={aiConfigured}
                  onAiGenerate={(mode) => {
                    onAiGenerate(mode)
                    close()
                  }}
                  onAiCancel={onAiCancel}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] font-medium"
                />
                {!aiConfigured && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSettings()
                      close()
                    }}
                    title="Configure an OpenAI-compatible provider for AI layers"
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-amber-300 hover:bg-zinc-800"
                  >
                    <Settings className="h-3 w-3" />
                    Configure AI provider…
                  </button>
                )}
                <div className="my-1 border-t border-zinc-800" />
                <button
                  type="button"
                  disabled={!hasDraft}
                  onClick={() => {
                    handleRevert()
                    close()
                  }}
                  title="Delete the draft and restore the lyrics embedded in the file"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3 w-3" />
                  Revert to Embedded File
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
          {editorLayout === 'raw' ? (
            <div className="flex min-h-0 flex-1">{rawEditor}</div>
          ) : hasTimedLines ? (
            <div className="flex min-h-0 flex-1">{renderLiveRows()}</div>
          ) : (
            // Plain or empty lyrics: a clean editable textarea plus a hint.
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <p className="shrink-0 text-[11px] text-zinc-500">
                No synced `[mm:ss.xx]` timestamps yet — open{' '}
                <button
                  type="button"
                  onClick={() => onModeChange('find')}
                  className="text-emerald-400 hover:underline"
                >
                  Find
                </button>{' '}
                to load synced lyrics, or switch to{' '}
                <button
                  type="button"
                  onClick={() => onEditorLayoutChange('raw')}
                  className="text-emerald-400 hover:underline"
                >
                  Raw Text
                </button>{' '}
                to paste plain text.
              </p>
              <textarea
                aria-label="Plain lyrics editor"
                value={lyricsText}
                onChange={(event) => onLyricsChange(event.target.value)}
                placeholder="Plain lyrics without timestamps…"
                className="min-h-0 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2.5 text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>
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

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5">
            <span className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-500">
              Layers interleave at matching `[mm:ss.xx]` timestamps; the primary is never
              overwritten until you apply.
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <AiLayerButton
                mode="translation"
                label="AI Translate"
                aiJob={aiJob}
                disabled={!hasSynced}
                aiConfigured={aiConfigured}
                onAiGenerate={onAiGenerate}
                onAiCancel={onAiCancel}
                className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium"
              />
              <AiLayerButton
                mode="romanization"
                label="AI Romanize"
                aiJob={aiJob}
                disabled={!hasSynced}
                aiConfigured={aiConfigured}
                onAiGenerate={onAiGenerate}
                onAiCancel={onAiCancel}
                className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium"
              />
              <button
                type="button"
                onClick={onOpenSettings}
                title="AI provider settings"
                aria-label="Open AI settings"
                className="rounded border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
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
              title="Query the sibling .lrc, LRCLIB, and NetEase (sequential, paced requests with Retry-After handling)"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {searchLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Search className="h-3 w-3" />
              )}
              {searchLoading ? 'Searching...' : 'Search'}
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              title="AI provider settings (base URL, model, API key, target language)"
              aria-label="Open AI settings"
              className="shrink-0 rounded border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Provider filter pills */}
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'localSidecar', label: 'Local' },
                { id: 'lrclib', label: 'LRCLIB' },
                { id: 'netease', label: 'NetEase' }
              ] as const
            ).map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={providerFilter === entry.id}
                onClick={() => onProviderFilterChange(entry.id)}
                title={
                  entry.id === 'all'
                    ? 'Search every provider'
                    : `Search only ${entry.label}`
                }
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  providerFilter === entry.id
                    ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {entry.label}
              </button>
            ))}
            {visibleResults.length !== searchResults.length && (
              <span className="ml-1 text-[10px] text-zinc-500">
                {visibleResults.length} of {searchResults.length}
              </span>
            )}
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
                  {searchLoading ? 'searching…' : `${visibleResults.length}`}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {visibleResults.length > 0 ? (
                  <ul className="space-y-1">
                    {visibleResults.map((result, index) => {
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
                    {searchResults.length > 0
                      ? 'No candidates from this provider. Try the All filter.'
                      : 'No candidates matched those fields. Adjust the search and try again.'}
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
                  title="Replace the primary LRC with this candidate's synced (or plain) lyrics and save the draft"
                  className="rounded border border-emerald-700/80 bg-emerald-950/60 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Load Primary
                </button>
                {selectedCandidate &&
                  (hasTranslationLayer(selectedCandidate) ||
                    hasRomanizationLayer(selectedCandidate)) && (
                    <button
                      type="button"
                      onClick={() => onLoadAllLayers(selectedCandidate)}
                      title="Load this candidate's primary lyrics plus its bundled translation and romanization layers, then save the draft"
                      className="rounded border border-sky-700/80 bg-sky-950/60 px-2 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Load All Layers
                      {hasTranslationLayer(selectedCandidate) ? ' +T' : ''}
                      {hasRomanizationLayer(selectedCandidate) ? ' +R' : ''}
                    </button>
                  )}
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
              onClick={handleToggleTranslationLayer}
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
              onClick={handleToggleRomanizationLayer}
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
