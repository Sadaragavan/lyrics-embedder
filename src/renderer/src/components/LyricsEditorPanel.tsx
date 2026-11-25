import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  Download,
  FileUp,
  Layers,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  XCircle
} from 'lucide-react'
import type { LyricsFetchProgress, TrackRecord } from '@shared/ipc'
import {
  formatTimestamp,
  normalizeLrc,
  parseLrc,
  shiftLrcOffset,
  stackLrcLayers
} from '@shared/lrc'
import { findActiveLineIndex, hasSyncedTimestamps } from '@shared/lyricsSync'
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
}

type EditorTab = 'raw' | 'stack'

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
  onEmbedFocused
}: LyricsEditorPanelProps) {
  const [activeTab, setActiveTab] = useState<EditorTab>('raw')
  const [secondaryLayerText, setSecondaryLayerText] = useState('')
  const [romanizationLayerText, setRomanizationLayerText] = useState('')
  const activeLineRef = useRef<HTMLButtonElement | null>(null)

  const focusedTrackId = focusedTrack?.id ?? null
  useEffect(() => {
    setSecondaryLayerText('')
    setRomanizationLayerText('')
  }, [focusedTrackId])

  const parsedLines = useMemo(
    () => parseLrc(lyricsText, { preserveWordTags }),
    [lyricsText, preserveWordTags]
  )

  const isTrackPlayingOrLoaded =
    focusedTrack !== null && loadedTrackId === focusedTrack.id
  const activeLineIndex = isTrackPlayingOrLoaded
    ? findActiveLineIndex(parsedLines, playbackTimeMs)
    : -1
  const activeTimestampMs =
    activeLineIndex >= 0 ? parsedLines[activeLineIndex]!.timeMs : null

  useEffect(() => {
    if (activeLineRef.current && isTrackPlayingOrLoaded) {
      activeLineRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeLineIndex, isTrackPlayingOrLoaded])

  const stackedPreview = useMemo(() => {
    const layers = [lyricsText, secondaryLayerText, romanizationLayerText].filter(
      (layer) => layer.trim().length > 0
    )
    if (layers.length <= 1) return ''
    return stackLrcLayers(layers, { preserveWordTags })
  }, [lyricsText, secondaryLayerText, romanizationLayerText, preserveWordTags])

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

  function handleNudgeOffset(deltaMs: number) {
    onLyricsChange(shiftLrcOffset(lyricsText, deltaMs, { preserveWordTags }))
  }

  function handleNormalize() {
    onLyricsChange(normalizeLrc(lyricsText, { preserveWordTags }))
  }

  function handleApplyStackedLayers() {
    if (!stackedPreview) return
    onLyricsChange(stackedPreview)
    setSecondaryLayerText('')
    setRomanizationLayerText('')
    setActiveTab('raw')
  }

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900 px-3 py-2 space-y-2">
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
                className="inline-flex items-center gap-1 rounded border border-red-800 bg-red-950/70 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-900/70"
              >
                <XCircle className="h-3.5 w-3.5" />
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={onFetchFocused}
                className="inline-flex items-center gap-1 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500"
              >
                <Download className="h-3.5 w-3.5" />
                Fetch
              </button>
            )}

            <button
              type="button"
              onClick={onImportLrc}
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
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                activeTab === 'raw'
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Raw &amp; Sync ({parsedLines.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stack')}
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

          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-300 select-none">
            <input
              type="checkbox"
              checked={preserveWordTags}
              onChange={(event) => onPreserveWordTagsChange(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950 accent-emerald-500"
            />
            Preserve A2 &lt;mm:ss.xx&gt;
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 mr-0.5">
              <Clock className="h-3 w-3" />
              Offset
            </span>
            {([-500, -100, 100, 500] as const).map((delta) => (
              <button
                key={delta}
                type="button"
                disabled={!hasSynced}
                onClick={() => handleNudgeOffset(delta)}
                className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {delta > 0 ? `+${delta}` : delta}ms
              </button>
            ))}
            <button
              type="button"
              disabled={!hasSynced}
              onClick={handleNormalize}
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3" />
              Normalize
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={!isDirty}
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save className="h-3 w-3" />
              Save Draft
            </button>
            <button
              type="button"
              onClick={onDiscardDraft}
              disabled={!hasDraft && !isDirty}
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {hasDraft ? <Trash2 className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
              Discard
            </button>
            <button
              type="button"
              onClick={onEmbedFocused}
              disabled={isEmbedding || !workerReady}
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save className="h-3 w-3" />
              {isEmbedding ? 'Embedding...' : 'Embed'}
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'raw' ? (
        <div className="flex flex-1 min-h-0 flex-col gap-2 p-3 overflow-hidden">
          <textarea
            aria-label="Lyrics LRC editor"
            value={lyricsText}
            onChange={(event) => onLyricsChange(event.target.value)}
            placeholder="[00:00.00] Paste or fetch synced LRC lines..."
            className="h-1/2 min-h-[120px] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />

          <div className="flex flex-1 min-h-0 flex-col rounded-md border border-zinc-800 bg-zinc-950/70 overflow-hidden">
            <div className="shrink-0 border-b border-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-400">
              Timestamp Preview (click line to seek)
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
              {parsedLines.length === 0 ? (
                <p className="p-2 text-xs text-zinc-500">
                  No synced `[mm:ss.xx]` lines parsed yet.
                </p>
              ) : (
                parsedLines.map((line, index) => {
                  const isActive =
                    activeTimestampMs !== null && line.timeMs === activeTimestampMs
                  const isFirstActive = isActive && index === activeLineIndex
                  return (
                    <button
                      key={`${line.timeMs}-${index}`}
                      ref={isFirstActive ? activeLineRef : undefined}
                      type="button"
                      onClick={() => onSeekToMs(focusedTrack.id, line.timeMs)}
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
        <div className="flex flex-1 min-h-0 flex-col gap-2.5 p-3 overflow-y-auto">
          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-zinc-300">
              Translation Layer (LRC)
            </label>
            <textarea
              value={secondaryLayerText}
              onChange={(event) => setSecondaryLayerText(event.target.value)}
              rows={4}
              placeholder="[00:01.00] Translated line matching primary timestamps..."
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
              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-400">
              Interleaves lines sharing the same `[mm:ss.xx]` timestamp.
            </span>
            <button
              type="button"
              disabled={!stackedPreview}
              onClick={handleApplyStackedLayers}
              className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Layers className="h-3.5 w-3.5" />
              Apply Stacked Layers
            </button>
          </div>

          {stackedPreview && (
            <div className="flex-1 min-h-[100px] rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300 overflow-y-auto whitespace-pre-wrap">
              {stackedPreview}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
