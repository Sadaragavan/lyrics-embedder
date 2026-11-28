import { Layers, Settings } from 'lucide-react'
import type { EditorState } from '@shared/editorState'
import type { TrackRecord } from '@shared/ipc'
import { hasSyncedTimestamps } from '@shared/lyricsSync'
import { ContextualToolbar } from './ContextualToolbar'
import { AiLayerButton } from '../AiLayerButton'
import { LayerTabs } from './LayerTabs'

interface TextTabProps {
  focusedTrack: TrackRecord | null
  editorState: EditorState | null
  preserveWordTags: boolean
  onPreserveWordTagsChange: (value: boolean) => void
  onLyricsChange: (nextLyrics: string) => void
  onTranslationChange: (text: string) => void
  onRomanizationChange: (text: string) => void
  onImportLrc: () => void
  onNormalize: () => void
  onApplyStacked: () => void
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  onAiCancel: () => void
  onOpenSettings: () => void
  aiJob: { mode: 'translation' | 'romanization'; jobId: string } | null
  aiConfigured: boolean
  showTranslationLayer: boolean
  showRomanizationLayer: boolean
  stackedOutput: string
  hasTranslation: boolean
  hasRomanization: boolean
}

const layerTabs: { key: 'primary' | 'translation' | 'romanization'; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'translation', label: 'Translation' },
  { key: 'romanization', label: 'Romanization' }
]

export function TextTab({
  focusedTrack,
  editorState,
  preserveWordTags,
  onPreserveWordTagsChange,
  onLyricsChange,
  onTranslationChange,
  onRomanizationChange,
  onImportLrc,
  onNormalize,
  onApplyStacked,
  onAiGenerate,
  onAiCancel,
  onOpenSettings,
  aiJob,
  aiConfigured,
  showTranslationLayer,
  showRomanizationLayer,
  stackedOutput,
  hasTranslation,
  hasRomanization
}: TextTabProps) {
  const lyricsText = editorState?.primary ?? ''
  const secondaryLayerText = editorState?.translation.text ?? ''
  const romanizationLayerText = editorState?.romanization.text ?? ''
  const hasPrimaryText = lyricsText.trim().length > 0
  const hasSynced = hasSyncedTimestamps(lyricsText)

  // Wide layout: side-by-side three columns
  // Narrow layout (< 1000px): use LayerTabs component
  const isWide = typeof window !== 'undefined' && window.innerWidth >= 1000

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

  function handleClearPrimary() {
    onLyricsChange('')
  }

  function handleClearTranslation() {
    onTranslationChange('')
  }

  function handleClearRomanization() {
    onRomanizationChange('')
  }

  if (!focusedTrack) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/70 p-6 text-center">
        <p className="text-sm font-medium text-zinc-300">No track focused</p>
        <p className="mt-1 text-xs text-zinc-500">Click a track row to edit lyrics layers.</p>
      </section>
    )
  }

  if (isWide) {
    // Three-column side-by-side layout
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
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

        {/* Three columns */}
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 p-2.5">
          {layerTabs.map((column) => {
            const isPrimary = column.key === 'primary'
            const isTranslation = column.key === 'translation'
            const value = isPrimary ? lyricsText : isTranslation ? secondaryLayerText : romanizationLayerText
            const onChange = isPrimary ? onLyricsChange : isTranslation ? onTranslationChange : onRomanizationChange
            const onSwap = isPrimary
              ? (hasTranslation ? handleSwapTranslation : hasRomanization ? handleSwapRomanization : null)
              : isTranslation
                ? handleSwapTranslation
                : handleSwapRomanization
            const onClear = isPrimary ? handleClearPrimary : isTranslation ? handleClearTranslation : handleClearRomanization

            return (
              <div key={column.key} className="flex min-h-0 min-w-0 flex-col gap-1">
                <div className="flex shrink-0 items-center justify-between gap-1">
                  <span className="truncate text-[11px] font-medium text-zinc-300">{column.label}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    {onSwap && (
                      <button
                        type="button"
                        disabled={value.trim().length === 0}
                        onClick={onSwap}
                        title={`Swap ${column.label} with the primary LRC`}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Swap
                      </button>
                    )}
                    {onClear && (
                      <button
                        type="button"
                        disabled={value.trim().length === 0}
                        onClick={onClear}
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
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  placeholder={
                    column.key === 'primary'
                      ? '[00:01.00] Primary line...'
                      : `[00:01.00] ${column.label} line matching primary timestamps...`
                  }
                  title={`${column.label} layer — stacked with the primary at matching timestamps`}
                  className="min-h-0 w-full flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            )
          })}
        </div>

        {/* Footer actions */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-t border-zinc-800 bg-zinc-950/60 px-2 py-1">
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-500">
            Layers interleave at matching `[mm:ss.xx]` timestamps; the primary is never overwritten until you apply.
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
        </div>
      </section>
    )
  }

  // Narrow layout: tabbed
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
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

      {/* Layer Tabs + Editor */}
      <div className="flex min-h-0 flex-1 flex-col">
        <LayerTabs
          activeLayer={editorState?.translation.text && showTranslationLayer ? 'translation' : editorState?.romanization.text && showRomanizationLayer ? 'romanization' : 'primary'}
          onLayerChange={(layer) => {
            // This would need to be handled by parent to update visibility
            // For now, just log
            console.log('Layer change to:', layer)
          }}
          showTranslationLayer={showTranslationLayer}
          showRomanizationLayer={showRomanizationLayer}
          onShowTranslationLayerChange={() => {}}
          onShowRomanizationLayerChange={() => {}}
        />
        <div className="min-h-0 flex-1">
          {/* The actual editor would be here based on active layer */}
          <textarea
            aria-label={`${layerTabs.find(t => t.key === 'primary')?.label} layer LRC editor`}
            value={lyricsText}
            onChange={(event) => onLyricsChange(event.target.value)}
            placeholder="[00:01.00] Primary line..."
            className="min-h-0 w-full flex-1 resize-none rounded-none border-none bg-transparent p-2 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>

        {/* Footer actions */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-t border-zinc-800 bg-zinc-950/60 px-2 py-1">
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-500">
            Layers interleave at matching `[mm:ss.xx]` timestamps; the primary is never overwritten until you apply.
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
        </div>
      </div>
    </section>
  )
}