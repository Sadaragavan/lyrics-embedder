import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { TrackRecord } from '@shared/ipc'
import { Popover } from '../Popover'

interface TrackHeaderProps {
  focusedTrack: TrackRecord | null
  hasDraft: boolean
  isDirty: boolean
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  onRevert: () => void
  onEmbedFocused: () => void
  workerReady: boolean
  isEmbedding: boolean
  // For embed button label
  showTranslationLayer: boolean
  showRomanizationLayer: boolean
  hasTranslation: boolean
  hasRomanization: boolean
}

/**
 * Single track header with unified save indicator, Revert (inline confirm), and Embed button.
 */
export function TrackHeader({
  focusedTrack,
  hasDraft,
  isDirty,
  saveState,
  onRevert,
  onEmbedFocused,
  workerReady,
  isEmbedding,
  showTranslationLayer,
  showRomanizationLayer,
  hasTranslation,
  hasRomanization
}: TrackHeaderProps) {
  const [revertConfirm, setRevertConfirm] = useState(false)

  // Unified save indicator
  const saveLabel =
    saveState === 'saving'
      ? 'Saving...'
      : saveState === 'saved'
        ? 'Saved'
        : saveState === 'error'
          ? 'Save failed'
          : isDirty
            ? 'Unsaved'
            : hasDraft
              ? 'Saved'
              : ''

  const saveClass =
    saveState === 'saving'
      ? 'text-amber-400/90'
      : saveState === 'error'
        ? 'text-red-400/90'
        : isDirty
          ? 'text-amber-400/90'
          : 'text-emerald-400/80'

  // Embed button label
  const embedLabel =
    (showTranslationLayer && hasTranslation) || (showRomanizationLayer && hasRomanization)
      ? 'Embed: Primary + Translation' + (showRomanizationLayer && hasRomanization ? ' + Romanization' : '')
      : 'Embed: Primary'

  if (!focusedTrack) {
    return (
      <div className="shrink-0 h-12 border-b border-zinc-800 bg-zinc-900 px-3 flex items-center">
        <p className="text-sm font-medium text-zinc-500">No track focused</p>
      </div>
    )
  }

  return (
    <div className="shrink-0 space-y-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold leading-snug text-zinc-100">
            {focusedTrack.title}
          </h2>
          <p className="truncate text-xs leading-snug text-zinc-400">
            {[focusedTrack.artist || 'Unknown Artist', focusedTrack.album].filter(Boolean).join(' — ')}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] text-zinc-500">
            <span className="truncate">
              {focusedTrack.format.toUpperCase()} · source: {focusedTrack.lyricsSource}
            </span>
            <span role="status" aria-live="polite" className={`shrink-0 ${saveClass}`}>
              {saveLabel}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Revert with inline confirm */}
          <Popover
            label={revertConfirm ? 'Confirm Revert?' : 'Revert'}
            title="Delete the draft, restore the lyrics embedded in the file, and clear the translation/romanization layers"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            disabled={!hasDraft}
            align="right"
          >
            {(close) => (
              <>
                {revertConfirm ? (
                  <div className="flex items-center gap-1 p-1">
                    <button
                      type="button"
                      onClick={() => { onRevert(); close(); }}
                      className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevertConfirm(false)}
                      className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRevertConfirm(true)}
                    className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Revert
                  </button>
                )}
              </>
            )}
          </Popover>

          {/* Embed Button */}
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
    </div>
  )
}