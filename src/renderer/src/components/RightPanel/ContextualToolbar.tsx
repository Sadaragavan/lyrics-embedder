import { useState } from 'react'
import {
  Clock,
  FileUp,
  Layers,
  Settings,
  Sparkles
} from 'lucide-react'
import type { EditorState } from '@shared/editorState'
import { shiftLrcOffset } from '@shared/lrc'
import { Popover } from '../Popover'
import { AiLayerButton } from '../AiLayerButton'

interface ContextualToolbarProps {
  editorState: EditorState | null
  hasSynced: boolean
  hasPrimaryText: boolean
  preserveWordTags: boolean
  onPreserveWordTagsChange: (value: boolean) => void
  onLyricsChange: (lyrics: string) => void
  onImportLrc: () => void
  onNormalize: () => void
  onSendToTranslation: () => void
  onSendToRomanization: () => void
  onSwapTranslation: () => void
  onSwapRomanization: () => void
  onApplyStacked: () => void
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  onAiCancel: () => void
  onOpenSettings: () => void
  aiJob: { mode: 'translation' | 'romanization'; jobId: string } | null
  aiConfigured: boolean
  stackedOutput: string
  hasTranslation: boolean
  hasRomanization: boolean
}

/**
 * Contextual toolbar for Lyrics and Text tabs.
 * Contains: Offset, Normalize, Import .lrc, Send/Swap, AI actions.
 * Disabled items explain why in tooltip.
 */
export function ContextualToolbar({
  editorState,
  hasSynced,
  hasPrimaryText,
  preserveWordTags,
  onPreserveWordTagsChange,
  onLyricsChange,
  onImportLrc,
  onNormalize,
  onSendToTranslation,
  onSendToRomanization,
  onSwapTranslation,
  onSwapRomanization,
  onApplyStacked,
  onAiGenerate,
  onAiCancel,
  onOpenSettings,
  aiJob,
  aiConfigured,
  stackedOutput,
  hasTranslation,
  hasRomanization
}: ContextualToolbarProps) {
  const [offsetInput, setOffsetInput] = useState('')

  const handleNudgeOffset = (deltaMs: number) => {
    if (!Number.isFinite(deltaMs) || deltaMs === 0 || !editorState) return
    onLyricsChange(shiftLrcOffset(editorState.primary, deltaMs, { preserveWordTags }))
  }

  const handleApplyCustomOffset = () => {
    const parsed = Number.parseFloat(offsetInput)
    if (!Number.isFinite(parsed) || parsed === 0) return
    handleNudgeOffset(Math.round(parsed))
    setOffsetInput('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* Offset Popover */}
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
                onClick={() => { handleApplyCustomOffset(); close(); }}
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
                  onClick={() => { handleNudgeOffset(delta); close(); }}
                  disabled={!hasSynced}
                  title={`Shift every timestamp ${Math.abs(delta)}ms ${delta > 0 ? 'later' : 'earlier'}`}
                  className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 font-mono text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {delta > 0 ? `+${delta}` : delta} ms
                </button>
              ))}
            </div>
          </>
        )}
      </Popover>

      {/* Normalize */}
      <button
        type="button"
        disabled={!hasSynced}
        onClick={onNormalize}
        title="Bake [offset:±ms] into the timestamps and strip [length:]/metadata headers"
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Sparkles className="h-3 w-3" />
        Normalize
      </button>

      {/* Import .lrc */}
      <button
        type="button"
        onClick={onImportLrc}
        title="Import a local .lrc file as this track's draft (UTF-8, ≤1 MiB, symlinks rejected)"
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800"
      >
        <FileUp className="h-3 w-3" />
        Import .lrc
      </button>

      {/* Preserve A2 Tags */}
      <label
        title="Preserve inline <mm:ss.xx> Enhanced LRC word-level timestamps instead of stripping them to line-synced LRC"
        className="flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
      >
        <input
          type="checkbox"
          checked={preserveWordTags}
          onChange={(event) => onPreserveWordTagsChange(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950 accent-emerald-500"
        />
        Keep word timestamps
      </label>

      <div className="w-px h-6 bg-zinc-700 mx-1" />

      {/* Send to Translation */}
      <button
        type="button"
        disabled={!hasPrimaryText}
        onClick={onSendToTranslation}
        title="Copy the primary LRC into the translation layer (primary stays untouched)"
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        → Send to Translation
      </button>

      {/* Send to Romanization */}
      <button
        type="button"
        disabled={!hasPrimaryText}
        onClick={onSendToRomanization}
        title="Copy the primary LRC into the romanization layer (primary stays untouched)"
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        → Send to Romanization
      </button>

      {/* Swap Translation */}
      <button
        type="button"
        disabled={!hasTranslation}
        onClick={onSwapTranslation}
        title="Swap the primary LRC with the translation layer"
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ⇄ Swap Translation
      </button>

      {/* Swap Romanization */}
      <button
        type="button"
        disabled={!hasRomanization}
        onClick={onSwapRomanization}
        title="Swap the primary LRC with the romanization layer"
        className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        ⇄ Swap Romanization
      </button>

      <div className="w-px h-6 bg-zinc-700 mx-1" />

      {/* AI Translate */}
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

      {/* AI Romanize */}
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

      {/* Settings Gear */}
      <button
        type="button"
        onClick={onOpenSettings}
        title="AI provider settings"
        aria-label="Open AI settings"
        className="rounded border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      {/* Apply Stacked (only in Text tab, but shown here conditionally) */}
      {stackedOutput && (
        <button
          type="button"
          onClick={onApplyStacked}
          title="Merge primary + layers into the editor using same-timestamp stacking"
          className="inline-flex shrink-0 items-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
        >
          <Layers className="h-3 w-3" />
          Apply Stacked to Primary
        </button>
      )}
    </div>
  )
}