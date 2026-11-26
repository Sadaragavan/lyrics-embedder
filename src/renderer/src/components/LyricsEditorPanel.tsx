import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileUp,
  Layers,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  XCircle
} from 'lucide-react'
import type { LyricsFetchProgress, LyricsSearchResult, TrackRecord } from '@shared/ipc'
import {
  formatTimestamp,
  normalizeLrc,
  parseLrc,
  shiftLrcOffset,
  stackLrcLayers
} from '@shared/lrc'
import { findActiveLineIndices, hasSyncedTimestamps } from '@shared/lyricsSync'
import type { TrackEmbedStatus } from '../types'

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
  /** Emits the live preview text (primary, or stacked when layers are present). */
  onPreviewTextChange: (trackId: string, text: string) => void
  // --- Candidate sifter ---
  sifterOpen: boolean
  onSifterOpenChange: (open: boolean) => void
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

type EditorTab = 'raw' | 'stack'
type PreviewMode = 'primary' | 'stacked'

interface CandidateResultRowProps {
  result: LyricsSearchResult
  focusedDurationSec: number
  onLoadPrimary: () => void
  onToTranslation: () => void
  onToRomanization: () => void
}

function providerLabel(providerId: LyricsSearchResult['providerId']): string {
  return providerId === 'lrclib' ? 'LRCLIB' : 'Local .lrc'
}

function CandidateResultRow({
  result,
  focusedDurationSec,
  onLoadPrimary,
  onToTranslation,
  onToRomanization
}: CandidateResultRowProps) {
  const [expanded, setExpanded] = useState(false)
  const lyrics = result.syncedLyrics ?? result.plainLyrics ?? ''
  const kind = result.syncedLyrics ? 'Synced' : result.plainLyrics ? 'Plain' : 'Instrumental'
  const kindClass = result.syncedLyrics
    ? 'border-emerald-800/70 bg-emerald-950/60 text-emerald-300'
    : result.plainLyrics
      ? 'border-amber-800/70 bg-amber-950/60 text-amber-300'
      : 'border-zinc-700 bg-zinc-800 text-zinc-400'

  const durationDelta =
    result.durationSec > 0 && focusedDurationSec > 0
      ? result.durationSec - focusedDurationSec
      : null
  const deltaLabel =
    durationDelta === null
      ? 'dur ?'
      : `${durationDelta > 0 ? '+' : durationDelta < 0 ? '-' : '±'}${Math.abs(
          Math.round(durationDelta)
        )}s`

  return (
    <li className="rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 rounded border border-sky-800/70 bg-sky-950/60 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
          {providerLabel(result.providerId)}
        </span>
        <span
          className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium ${kindClass}`}
          title={
            result.syncedLyrics
              ? 'Candidate has line-synced [mm:ss.xx] lyrics'
              : result.plainLyrics
                ? 'Candidate only has plain (untimed) lyrics'
                : 'Candidate reports instrumental (no lyrics payload)'
          }
        >
          {kind}
        </span>
        <span
          className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400"
          title="Duration difference against the focused track (seconds)"
        >
          {deltaLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-zinc-200" title={result.title}>
          {result.title || 'Untitled'}
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide candidate lyrics preview' : 'Show candidate lyrics preview'}
          title={expanded ? 'Hide this candidate lyric preview' : 'Expand this candidate lyric preview'}
          onClick={() => setExpanded((prev) => !prev)}
          className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      </div>

      <div className="truncate pl-0.5 text-[10px] text-zinc-400">
        {[result.artist || 'Unknown Artist', result.album].filter(Boolean).join(' — ')}
      </div>

      {expanded && (
        <pre className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950 p-1.5 font-mono text-[10px] leading-relaxed text-zinc-300">
          {lyrics.length > 0 ? lyrics : '(no lyrics payload — instrumental)'}
        </pre>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1">
        <button
          type="button"
          disabled={!lyrics}
          onClick={onLoadPrimary}
          title="Replace the primary LRC with this candidate's synced (or plain) lyrics and save it as a draft"
          className="rounded border border-emerald-700/80 bg-emerald-950/60 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Load Primary
        </button>
        <button
          type="button"
          disabled={!lyrics}
          onClick={onToTranslation}
          title="Put this candidate's lyrics into the translation layer (keeps the primary untouched)"
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          To Translation
        </button>
        <button
          type="button"
          disabled={!lyrics}
          onClick={onToRomanization}
          title="Put this candidate's lyrics into the romanization layer (keeps the primary untouched)"
          className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          To Romanization
        </button>
      </div>
    </li>
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
  onPreviewTextChange,
  sifterOpen,
  onSifterOpenChange,
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
  const [activeTab, setActiveTab] = useState<EditorTab>('raw')
  const [secondaryLayerText, setSecondaryLayerText] = useState('')
  const [romanizationLayerText, setRomanizationLayerText] = useState('')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('stacked')
  const activeLineRef = useRef<HTMLButtonElement | null>(null)

  const focusedTrackId = focusedTrack?.id ?? null

  useEffect(() => {
    setSecondaryLayerText('')
    setRomanizationLayerText('')
    setPreviewMode('stacked')
  }, [focusedTrackId])

  const primaryLines = useMemo(
    () => parseLrc(lyricsText, { preserveWordTags }),
    [lyricsText, preserveWordTags]
  )

  const stackedOutput = useMemo(() => {
    const layers = [lyricsText, secondaryLayerText, romanizationLayerText].filter(
      (layer) => layer.trim().length > 0
    )
    if (layers.length <= 1) return ''
    return stackLrcLayers(layers, { preserveWordTags })
  }, [lyricsText, secondaryLayerText, romanizationLayerText, preserveWordTags])

  const hasSecondaryLayers =
    secondaryLayerText.trim().length > 0 || romanizationLayerText.trim().length > 0

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

  function handleNudgeOffset(deltaMs: number) {
    onLyricsChange(shiftLrcOffset(lyricsText, deltaMs, { preserveWordTags }))
  }

  function handleNormalize() {
    onLyricsChange(normalizeLrc(lyricsText, { preserveWordTags }))
  }

  function handleSendToTranslation() {
    setSecondaryLayerText(lyricsText)
  }

  function handleSendToRomanization() {
    setRomanizationLayerText(lyricsText)
  }

  function handleSwapTranslation() {
    const nextPrimary = secondaryLayerText
    const nextTranslation = lyricsText
    onLyricsChange(nextPrimary)
    setSecondaryLayerText(nextTranslation)
  }

  function handleSwapRomanization() {
    const nextPrimary = romanizationLayerText
    const nextRomanization = lyricsText
    onLyricsChange(nextPrimary)
    setRomanizationLayerText(nextRomanization)
  }

  function handleApplyStackedLayers() {
    if (!stackedOutput) return
    onLyricsChange(stackedOutput)
    setSecondaryLayerText('')
    setRomanizationLayerText('')
    setActiveTab('raw')
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      <div className="shrink-0 space-y-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100">{focusedTrack.title}</h2>
            <p className="truncate text-xs text-zinc-400">
              {[focusedTrack.artist || 'Unknown Artist', focusedTrack.album]
                .filter(Boolean)
                .join(' — ')}
            </p>
            <p className="truncate font-mono text-[10px] text-zinc-500">
              {focusedTrack.format} · source: {focusedTrack.lyricsSource}
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
              onClick={onImportLrc}
              title="Import a local .lrc file as this track's draft (UTF-8, ≤1 MiB, symlinks rejected)"
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              <FileUp className="h-3.5 w-3.5" />
              Import .lrc
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('raw')}
              title="Edit the raw LRC and click timestamped lines to seek the preview"
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                activeTab === 'raw'
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Raw &amp; Sync ({primaryLines.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stack')}
              title="Add translation/romanization layers and merge same-timestamp lines"
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
                activeTab === 'stack'
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Layers className="h-3 w-3" />
              Stack Layers
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
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
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Primary Only
              </button>
              <button
                type="button"
                aria-pressed={previewMode === 'stacked'}
                onClick={() => setPreviewMode('stacked')}
                title="Preview primary + translation + romanization stacked; also feeds the audio player's active lines"
                className={`border-l border-zinc-700 px-1.5 py-1 text-[10px] font-medium ${
                  previewMode === 'stacked'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Stacked Preview
              </button>
            </div>

            <label
              title="Retain <mm:ss.xx> word-level A2 tags instead of stripping them"
              className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-zinc-300"
            >
              <input
                type="checkbox"
                checked={preserveWordTags}
                onChange={(event) => onPreserveWordTagsChange(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950 accent-emerald-500"
              />
              Preserve A2 &lt;mm:ss.xx&gt;
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="mr-0.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
              <Clock className="h-3 w-3" />
              Offset
            </span>
            {([-500, -100, 100, 500] as const).map((delta) => (
              <button
                key={delta}
                type="button"
                disabled={!hasSynced}
                onClick={() => handleNudgeOffset(delta)}
                title={`Shift every timestamp ${Math.abs(delta)}ms ${
                  delta > 0 ? 'later' : 'earlier'
                } (positive = later)`}
                className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {delta > 0 ? `+${delta}` : delta}ms
              </button>
            ))}
            <button
              type="button"
              disabled={!hasSynced}
              onClick={handleNormalize}
              title="Bake [offset:±ms] into the timestamps and strip [length:]/metadata headers"
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3" />
              Normalize
            </button>

            <div className="mx-0.5 h-3.5 w-px bg-zinc-700" />

            <button
              type="button"
              disabled={!hasPrimaryText}
              onClick={handleSendToTranslation}
              title="Copy the primary LRC into the translation layer (primary stays untouched)"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              → Translation
            </button>
            <button
              type="button"
              disabled={!hasPrimaryText}
              onClick={handleSendToRomanization}
              title="Copy the primary LRC into the romanization layer (primary stays untouched)"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              → Romanization
            </button>
            <button
              type="button"
              disabled={secondaryLayerText.trim().length === 0}
              onClick={handleSwapTranslation}
              title="Swap the primary LRC with the translation layer (primary becomes the translation text)"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ⇄ Translation
            </button>
            <button
              type="button"
              disabled={romanizationLayerText.trim().length === 0}
              onClick={handleSwapRomanization}
              title="Swap the primary LRC with the romanization layer (primary becomes the romanization text)"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ⇄ Romanization
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={!isDirty}
              title="Persist the current lyrics as a per-track draft (atomic JSON write)"
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save className="h-3 w-3" />
              Save Draft
            </button>
            <button
              type="button"
              onClick={onDiscardDraft}
              disabled={!hasDraft && !isDirty}
              title={
                hasDraft
                  ? 'Delete the saved draft and restore the lyrics embedded in the file'
                  : 'Revert the unsaved edits back to the embedded lyrics'
              }
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {hasDraft ? <Trash2 className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
              Discard
            </button>
            <button
              type="button"
              onClick={onEmbedFocused}
              disabled={isEmbedding || !workerReady}
              title="Atomically write lyrics to the file (stages a temp copy, verifies tags, unloads playback, closes media:// handles, restores mtime)"
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save className="h-3 w-3" />
              {isEmbedding ? 'Embedding...' : 'Embed'}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-800/80 pt-1.5">
          <button
            type="button"
            aria-expanded={sifterOpen}
            onClick={() => onSifterOpenChange(!sifterOpen)}
            title="Search LRCLIB for alternate matches and load them into the primary, translation, or romanization layer"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800"
          >
            {sifterOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Search className="h-3 w-3" />
            Candidate Sifter
            {searchResults.length > 0 && (
              <span className="rounded bg-zinc-800 px-1 text-[10px] tabular-nums text-zinc-300">
                {searchResults.length}
              </span>
            )}
          </button>
          <span className="truncate text-[10px] text-zinc-500">
            {sifterOpen ? 'LRCLIB interactive search' : 'Find alternate matches'}
          </span>
        </div>

        {sifterOpen && (
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/70 p-2">
            <div className="grid grid-cols-12 gap-1.5">
              <input
                type="text"
                value={searchTitle}
                onChange={(event) => onSearchTitleChange(event.target.value)}
                placeholder="Title"
                title="Search title override (pre-filled from the focused track)"
                className="col-span-4 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
              <input
                type="text"
                value={searchArtist}
                onChange={(event) => onSearchArtistChange(event.target.value)}
                placeholder="Artist"
                title="Search artist override (pre-filled from the focused track)"
                className="col-span-3 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
              <input
                type="text"
                value={searchAlbum}
                onChange={(event) => onSearchAlbumChange(event.target.value)}
                placeholder="Album"
                title="Search album override (pre-filled from the focused track)"
                className="col-span-3 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                value={searchDuration}
                onChange={(event) => onSearchDurationChange(event.target.value)}
                placeholder="Sec"
                title="Search duration in seconds (pre-filled from the focused track)"
                className="col-span-2 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSearchCandidates}
                disabled={searchLoading}
                title="Query LRCLIB with the fields above (sequential, paced requests with Retry-After handling)"
                className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {searchLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Search className="h-3 w-3" />
                )}
                {searchLoading ? 'Searching...' : 'Search Candidates'}
              </button>
              {searchLoading && (
                <span className="truncate text-[11px] text-zinc-400">
                  Querying LRCLIB (paced, concurrency 1)...
                </span>
              )}
              {!searchLoading && searchError && (
                <span className="min-w-0 truncate text-[11px] text-red-300" title={searchError}>
                  {searchError}
                </span>
              )}
            </div>

            {searchResults.length > 0 ? (
              <ul className="space-y-1 pr-0.5">
                {searchResults.map((result, index) => (
                  <CandidateResultRow
                    key={`${result.providerId}-${
                      result.sourceId ?? result.sourceRef ?? result.title
                    }-${index}`}
                    result={result}
                    focusedDurationSec={focusedTrack.durationSec}
                    onLoadPrimary={() => onLoadCandidate(result)}
                    onToTranslation={() => {
                      const text = result.syncedLyrics ?? result.plainLyrics
                      if (text) setSecondaryLayerText(text)
                    }}
                    onToRomanization={() => {
                      const text = result.syncedLyrics ?? result.plainLyrics
                      if (text) setRomanizationLayerText(text)
                    }}
                  />
                ))}
              </ul>
            ) : searchSearched && !searchLoading && !searchError ? (
              <p className="text-[11px] text-zinc-500">
                No candidates matched those fields. Adjust the search and try again.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {activeTab === 'raw' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
          <textarea
            aria-label="Lyrics LRC editor"
            value={lyricsText}
            onChange={(event) => onLyricsChange(event.target.value)}
            placeholder="[00:00.00] Paste or fetch synced LRC lines..."
            title="Raw LRC editor — edits the primary layer only"
            className="h-[45%] min-h-[96px] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/70">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2.5 py-1 text-[11px]">
              <span className="font-medium text-zinc-400">
                Timestamp Preview{isStackedLive ? ' · stacked' : ''} (click line to seek)
              </span>
              <span className="text-[10px] tabular-nums text-zinc-500">
                {previewLines.length} lines
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
              {previewLines.length === 0 ? (
                <p className="p-2 text-xs text-zinc-500">
                  No synced `[mm:ss.xx]` lines parsed yet.
                </p>
              ) : (
                previewLines.map((line, index) => {
                  const isActive =
                    activeTimestampMs !== null && line.timeMs === activeTimestampMs
                  const isFirstActive = isActive && index === firstActiveIndex
                  return (
                    <button
                      key={`${line.timeMs}-${index}`}
                      ref={isFirstActive ? activeLineRef : undefined}
                      type="button"
                      onClick={() => onSeekToMs(focusedTrack.id, line.timeMs)}
                      title={`Seek to ${formatTimestamp(line.timeMs)} and play the preview`}
                      className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
                        isActive
                          ? 'bg-emerald-950/80 text-emerald-200 ring-1 ring-inset ring-emerald-700/70'
                          : 'text-zinc-300 hover:bg-zinc-800/70'
                      }`}
                    >
                      <span className="shrink-0 font-mono text-[11px] text-emerald-400">
                        {formatTimestamp(line.timeMs)}
                      </span>
                      <span className="min-w-0 break-words">
                        {line.text || <span className="italic text-zinc-600">(instrumental)</span>}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-zinc-300">
              Translation Layer (LRC)
            </label>
            <textarea
              value={secondaryLayerText}
              onChange={(event) => setSecondaryLayerText(event.target.value)}
              rows={4}
              placeholder="[00:01.00] Translated line matching primary timestamps..."
              title="Translation layer — stacked with the primary at matching timestamps"
              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-zinc-300">
              Romanization Layer (optional LRC)
            </label>
            <textarea
              value={romanizationLayerText}
              onChange={(event) => setRomanizationLayerText(event.target.value)}
              rows={3}
              placeholder="[00:01.00] Romanized line (optional)..."
              title="Romanization layer — stacked after the translation at matching timestamps"
              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-400">
              Interleaves lines sharing the same `[mm:ss.xx]` timestamp.
              {hasSecondaryLayers && !isStackedLive ? ' Switch to Stacked Preview to see them.' : ''}
            </span>
            <button
              type="button"
              disabled={!stackedOutput}
              onClick={handleApplyStackedLayers}
              title="Merge primary + layers into the editor using same-timestamp stacking"
              className="inline-flex shrink-0 items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Layers className="h-3.5 w-3.5" />
              Apply Stacked Layers
            </button>
          </div>

          {stackedOutput && (
            <div className="min-h-[80px] flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
              {stackedOutput}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
