/**
 * Pure helper for the Limusic-style "source chip" in the lyrics footer.
 *
 * Kept free of React/DOM imports so the label logic is unit-testable.
 */

export type LyricsSourceKind = 'lrclib' | 'local' | 'tag' | 'draft' | 'none'

export interface LyricsSourceChipInput {
  hasDraft: boolean
  /** `TrackRecord.lyricsSource` of the lyrics embedded in the file. */
  trackLyricsSource: 'tag' | 'sidecar' | 'none'
  /** True when the last fetch produced a candidate for this track. */
  hasFetchedCandidate: boolean
  /** True when the current primary text has usable `[mm:ss.xx]` timestamps. */
  hasSyncedTimestamps: boolean
}

export interface LyricsSourceChip {
  kind: LyricsSourceKind
  label: string
  /** Tailwind classes for the chip (border + background + text). */
  className: string
}

const CHIP_STYLES: Record<LyricsSourceKind, string> = {
  lrclib: 'border-sky-800/70 bg-sky-950/60 text-sky-200 hover:bg-sky-900/60',
  local: 'border-violet-800/70 bg-violet-950/60 text-violet-200 hover:bg-violet-900/60',
  tag: 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700',
  draft: 'border-amber-800/70 bg-amber-950/60 text-amber-200 hover:bg-amber-900/60',
  none: 'border-red-900/70 bg-red-950/50 text-red-200 hover:bg-red-900/60'
}

/**
 * Picks the active lyrics source: a saved draft outranks the file's embedded
 * lyrics, which outrank a just-fetched candidate. Untimed text is labelled
 * `Plain` rather than `Synced`.
 */
export function resolveLyricsSourceChip(input: LyricsSourceChipInput): LyricsSourceChip {
  const timing = input.hasSyncedTimestamps ? 'Synced' : 'Plain'

  if (input.hasDraft) {
    return { kind: 'draft', label: 'Draft', className: CHIP_STYLES.draft }
  }
  if (input.trackLyricsSource === 'sidecar') {
    return { kind: 'local', label: `Local .lrc · ${timing}`, className: CHIP_STYLES.local }
  }
  if (input.trackLyricsSource === 'tag') {
    return { kind: 'tag', label: 'Embedded Tag', className: CHIP_STYLES.tag }
  }
  if (input.hasFetchedCandidate) {
    return { kind: 'lrclib', label: `LRCLIB · ${timing}`, className: CHIP_STYLES.lrclib }
  }
  return { kind: 'none', label: 'No Lyrics — Find', className: CHIP_STYLES.none }
}
