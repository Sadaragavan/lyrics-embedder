import { describe, it, expect } from 'vitest'
import { resolveLyricsSourceChip } from '../src/renderer/src/components/lyricsSourceChip'

const base = {
  hasDraft: false,
  trackLyricsSource: 'none' as const,
  hasFetchedCandidate: false,
  hasSyncedTimestamps: false
}

describe('resolveLyricsSourceChip', () => {
  it('prompts for Find when the track has no lyrics at all', () => {
    const chip = resolveLyricsSourceChip(base)
    expect(chip.kind).toBe('none')
    expect(chip.label).toBe('No Lyrics — Find')
  })

  it('labels a sibling .lrc sidecar as Local .lrc with its timing kind', () => {
    const synced = resolveLyricsSourceChip({
      ...base,
      trackLyricsSource: 'sidecar',
      hasSyncedTimestamps: true
    })
    expect(synced.kind).toBe('local')
    expect(synced.label).toBe('Local .lrc · Synced')

    const plain = resolveLyricsSourceChip({ ...base, trackLyricsSource: 'sidecar' })
    expect(plain.label).toBe('Local .lrc · Plain')
  })

  it('labels embedded tag lyrics', () => {
    const chip = resolveLyricsSourceChip({ ...base, trackLyricsSource: 'tag' })
    expect(chip.kind).toBe('tag')
    expect(chip.label).toBe('Embedded Tag')
  })

  it('labels a just-fetched LRCLIB candidate', () => {
    const chip = resolveLyricsSourceChip({
      ...base,
      hasFetchedCandidate: true,
      hasSyncedTimestamps: true
    })
    expect(chip.kind).toBe('lrclib')
    expect(chip.label).toBe('LRCLIB · Synced')
  })

  it('lets a saved draft outrank the file source and the fetched candidate', () => {
    const chip = resolveLyricsSourceChip({
      ...base,
      hasDraft: true,
      trackLyricsSource: 'sidecar',
      hasFetchedCandidate: true,
      hasSyncedTimestamps: true
    })
    expect(chip.kind).toBe('draft')
    expect(chip.label).toBe('Draft')
  })

  it('always returns a non-empty Tailwind class string', () => {
    for (const source of ['tag', 'sidecar', 'none'] as const) {
      expect(resolveLyricsSourceChip({ ...base, trackLyricsSource: source }).className.length).toBeGreaterThan(0)
    }
  })
})
