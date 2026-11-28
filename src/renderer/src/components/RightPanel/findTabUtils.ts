import type { LyricsSearchResult } from '@shared/ipc'
import { detectLyricsTimingKind } from '@shared/lrc'

/** Human-readable provider label from provider ID. */
export function providerLabel(providerId: LyricsSearchResult['providerId']): string {
  if (providerId === 'lrclib') return 'LRCLIB'
  if (providerId === 'netease') return 'NetEase'
  return 'Local .lrc'
}

/** Returns timing badge (label + className) for a search result. */
export function timingBadge(result: LyricsSearchResult): { label: string; className: string } {
  const kind = result.timingKind ?? detectLyricsTimingKind(result.syncedLyrics, result.plainLyrics)
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

/** Duration delta label for a search result against the focused track. */
export function durationDeltaLabel(result: LyricsSearchResult, focusedDurationSec: number): string {
  if (!(result.durationSec > 0) || !(focusedDurationSec > 0)) return 'Δ ?'
  const delta = result.durationSec - focusedDurationSec
  const rounded = Math.round(delta)
  if (rounded === 0) return 'Δ ±0s'
  return `Δ ${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}s`
}

/** Whether a search result has a bundled translation layer. */
export function hasTranslationLayer(result: LyricsSearchResult): boolean {
  return typeof result.translatedLyrics === 'string' && result.translatedLyrics.trim().length > 0
}

/** Whether a search result has a bundled romanization layer. */
export function hasRomanizationLayer(result: LyricsSearchResult): boolean {
  return typeof result.romanizedLyrics === 'string' && result.romanizedLyrics.trim().length > 0
}

/** Candidate key for selection tracking. */
export function candidateKey(result: LyricsSearchResult, index: number): string {
  return `${result.providerId}-${result.sourceId ?? result.sourceRef ?? result.title}-${index}`
}