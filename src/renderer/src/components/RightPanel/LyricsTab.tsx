import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { EditorState } from '@shared/editorState'
import type { TrackRecord } from '@shared/ipc'
import type { AiJobState, LyricsFetchProgress } from '@shared/ipc'
import {
  parseLrc,
  stackLrcLayers,
  formatTimestamp
} from '@shared/lrc'
import { findActiveLineIndices, hasSyncedTimestamps } from '@shared/lyricsSync'
import {
  parseEditableRows,
  parseInlineTimestamp,
  serializeEditableLayer,
  serializeEditableRows,
  isValidInlineTimestamp,
  type EditableLrcRow
} from '@shared/lrcEditor'
import { resolveLyricsSourceChip, type LyricsSourceKind } from '../lyricsSourceChip'
import { ContextualToolbar } from './ContextualToolbar'

interface LyricsTabProps {
  focusedTrack: TrackRecord | null
  editorState: EditorState | null
  playbackTimeMs: number
  loadedTrackId: string | null
  preserveWordTags: boolean
  onPreserveWordTagsChange: (value: boolean) => void
  onLyricsChange: (nextLyrics: string) => void
  onTranslationChange: (text: string) => void
  onRomanizationChange: (text: string) => void
  onSeekToMs: (trackId: string, timeMs: number) => void
  onImportLrc: () => void
  onNormalize: () => void
  onPreviewTextChange: (trackId: string, text: string) => void
  fetchProgress: LyricsFetchProgress | undefined
  aiJob: AiJobState | null
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  onAiCancel: () => void
  onOpenSettings: () => void
  aiConfigured: boolean
  showTranslationLayer: boolean
  onShowTranslationLayerChange: (value: boolean) => void
  showRomanizationLayer: boolean
  onShowRomanizationLayerChange: (value: boolean) => void
}

export function LyricsTab({
  focusedTrack,
  editorState,
  playbackTimeMs,
  loadedTrackId,
  preserveWordTags,
  onPreserveWordTagsChange,
  onLyricsChange,
  onTranslationChange,
  onRomanizationChange,
  onSeekToMs,
  onImportLrc,
  onNormalize,
  onPreviewTextChange,
  fetchProgress,
  aiJob,
  onAiGenerate,
  onAiCancel,
  onOpenSettings,
  aiConfigured,
  showTranslationLayer,
  onShowTranslationLayerChange,
  showRomanizationLayer,
  onShowRomanizationLayerChange
}: LyricsTabProps) {
  const [editingTimestampKey, setEditingTimestampKey] = useState<number | null>(null)
  const [timestampDraft, setTimestampDraft] = useState('')
  const activeRowRef = useRef<HTMLDivElement | null>(null)
  const pendingEmptyRowKeysRef = useRef<Set<number>>(new Set())

  const focusedTrackId = focusedTrack?.id ?? null
  const lyricsText = editorState?.primary ?? ''
  const secondaryLayerText = editorState?.translation.text ?? ''
  const romanizationLayerText = editorState?.romanization.text ?? ''
  const hasTranslation = secondaryLayerText.trim().length > 0
  const hasRomanization = romanizationLayerText.trim().length > 0
  const hasPrimaryText = lyricsText.trim().length > 0
  const hasSynced = hasSyncedTimestamps(lyricsText)

  // Reset transient view state when the focused track changes.
  useEffect(() => {
    setEditingTimestampKey(null)
    setTimestampDraft('')
    pendingEmptyRowKeysRef.current.clear()
  }, [focusedTrackId])

  const primaryLines = useMemo(
    () => parseLrc(lyricsText, { preserveWordTags }),
    [lyricsText, preserveWordTags]
  )

  const hasTimedLines = primaryLines.length > 0

  const enabledLayers = useMemo(() => {
    const layers: string[] = []
    if (showTranslationLayer && hasTranslation) layers.push(secondaryLayerText)
    if (showRomanizationLayer && hasRomanization) layers.push(romanizationLayerText)
    return layers
  }, [showTranslationLayer, hasTranslation, secondaryLayerText, showRomanizationLayer, hasRomanization, romanizationLayerText])

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

  // Editable rows
  const editableRows = useMemo(
    () => parseEditableRows(lyricsText, secondaryLayerText, romanizationLayerText, { preserveWordTags }),
    [lyricsText, secondaryLayerText, romanizationLayerText, preserveWordTags]
  )

  const commitRows = useCallback(
    (rows: EditableLrcRow[]) => {
      const pending = pendingEmptyRowKeysRef.current
      for (const row of rows) {
        if (row.text.trim().length > 0) pending.delete(row.key)
      }
      onLyricsChange(
        serializeEditableRows(
          rows.filter((row) => row.text.trim().length > 0 || pending.has(row.key)),
          { preserveWordTags }
        )
      )
      onTranslationChange(serializeEditableLayer(rows, 'translation', { preserveWordTags }))
      onRomanizationChange(serializeEditableLayer(rows, 'romanization', { preserveWordTags }))
    },
    [onLyricsChange, onTranslationChange, onRomanizationChange, preserveWordTags]
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
  const activeTimestampMs = firstActiveIndex >= 0 ? previewLines[firstActiveIndex]!.timeMs : null

  const activeRowKeys = useMemo(() => {
    if (activeTimestampMs === null) return new Set<number>()
    return new Set(activeIndices.map((index) => previewLines[index]!.timeMs))
  }, [activeIndices, activeTimestampMs, previewLines])

  useEffect(() => {
    if (!isTrackPlayingOrLoaded || activeTimestampMs === null) return
    const activeElement = document.activeElement
    const isEditing = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
    if (isEditing) return
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeTimestampMs, isTrackPlayingOrLoaded])

  if (!focusedTrack) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/70 p-6 text-center">
        <p className="text-sm font-medium text-zinc-300">No track focused</p>
        <p className="mt-1 text-xs text-zinc-500">
          Click a track row to inspect, edit, preview timing, or embed synced lyrics.
        </p>
      </section>
    )
  }

  function handleSendToTranslation() {
    onTranslationChange(lyricsText)
  }

  function handleSendToRomanization() {
    onRomanizationChange(lyricsText)
  }

  function handleSwapTranslation() {
    const nextPrimary = secondaryLayerText
    const nextTranslation = lyricsText
    onLyricsChange(nextPrimary)
    onTranslationChange(nextTranslation)
  }

  function handleSwapRomanization() {
    const nextPrimary = romanizationLayerText
    const nextRomanization = lyricsText
    onLyricsChange(nextPrimary)
    onRomanizationChange(nextRomanization)
  }

  function handleApplyStackedLayers() {
    if (!stackedOutput) return
    onLyricsChange(stackedOutput)
    onTranslationChange('')
    onRomanizationChange('')
  }

  function handleToggleTranslationLayer() {
    onShowTranslationLayerChange(!showTranslationLayer)
  }

  function handleToggleRomanizationLayer() {
    onShowRomanizationLayerChange(!showRomanizationLayer)
  }

  // Source chip
  const trackLyricsSource = focusedTrack.lyricsSource
  const hasFetchedCandidate = Boolean(fetchProgress?.candidate)
  const sourceChip = resolveLyricsSourceChip({
    hasDraft: Boolean(focusedTrack.draftId),
    trackLyricsSource,
    hasFetchedCandidate,
    hasSyncedTimestamps: hasSynced
  })
  const sourceKind: LyricsSourceKind = sourceChip.kind

  const previewIsClickable = hasTimedLines

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
                load synced lyrics, or switch to <span className="text-zinc-300">Text</span> to
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
                      {renderTextInput(row, 'text', isActive ? 'font-medium text-emerald-100' : 'text-[12.5px]')}
                    </div>

                    {showTranslationLayer && hasTranslation && (
                      <div className="flex min-w-0 items-center gap-1 pl-3">
                        <span aria-hidden className="w-1 shrink-0 self-stretch rounded bg-sky-800/60" />
                        {renderTextInput(row, 'translation', 'text-[11px] text-sky-200/90')}
                      </div>
                    )}
                    {showRomanizationLayer && hasRomanization && (
                      <div className="flex min-w-0 items-center gap-1 pl-3">
                        <span aria-hidden className="w-1 shrink-0 self-stretch rounded bg-violet-800/60" />
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

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      {/* Header is now in TrackHeader */}
      {/* Toolbar */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <ContextualToolbar
          editorState={editorState}
          hasSynced={hasSynced}
          hasPrimaryText={hasPrimaryText}
          preserveWordTags={preserveWordTags}
          onPreserveWordTagsChange={onPreserveWordTagsChange}
          onLyricsChange={onLyricsChange}
          onImportLrc={onImportLrc}
          onNormalize={onNormalize}
          onSendToTranslation={handleSendToTranslation}
          onSendToRomanization={handleSendToRomanization}
          onSwapTranslation={handleSwapTranslation}
          onSwapRomanization={handleSwapRomanization}
          onApplyStacked={handleApplyStackedLayers}
          onAiGenerate={onAiGenerate}
          onAiCancel={onAiCancel}
          onOpenSettings={onOpenSettings}
          aiJob={aiJob}
          aiConfigured={aiConfigured}
          stackedOutput={stackedOutput}
          hasTranslation={hasTranslation}
          hasRomanization={hasRomanization}
        />
      </div>

      {/* Workspace body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5">
        {hasTimedLines ? (
          <div className="flex min-h-0 flex-1">{renderLiveRows()}</div>
        ) : (
          // Plain or empty lyrics
          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <p className="shrink-0 text-[11px] text-zinc-500">
              No synced `[mm:ss.xx]` timestamps yet — open{' '}
              <button type="button" onClick={() => {}} className="text-emerald-400 hover:underline">
                Find
              </button>{' '}
              to load synced lyrics, or switch to{' '}
              <button type="button" onClick={() => {}} className="text-emerald-400 hover:underline">
                Text
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

      {/* Footer: source chip + layer visibility toggles */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-800 bg-zinc-950/60 px-2 py-1">
        <button
          type="button"
          onClick={() => {}}
          title="Active lyrics source — click to open Find and pick another candidate"
          className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${sourceChip.className}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${sourceKind === 'none' ? 'bg-red-400' : 'bg-current'}`} />
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