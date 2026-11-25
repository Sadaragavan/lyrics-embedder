import { describe, it, expect } from 'vitest'
import {
  applyTrackClick,
  clearSelection,
  createEmptySelectionState,
  filterTracks,
  reconcileSelection,
  selectAllVisible
} from '../src/shared/trackSelection'
import type { TrackRecord } from '../src/shared/types'

function makeTrack(id: string, overrides: Partial<TrackRecord> = {}): TrackRecord {
  return {
    id,
    filePath: `C:\\Music\\${id}.flac`,
    format: 'FLAC',
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    album: `Album ${id}`,
    durationSec: 180,
    lyrics: null,
    lyricsSource: 'none',
    existingLyricsKeys: [],
    libraryRootId: 'root1',
    mtimeMs: 1_000,
    ...overrides
  }
}

describe('filterTracks', () => {
  const tracks: TrackRecord[] = [
    makeTrack('t1', {
      title: 'Blue Sky',
      artist: 'Nujabes',
      lyrics: '[00:01.00]Synced line',
      lyricsSource: 'tag'
    }),
    makeTrack('t2', {
      title: 'Plain Song',
      artist: 'Artist Two',
      lyrics: 'Unsynced words',
      lyricsSource: 'tag',
      draftId: 't2'
    }),
    makeTrack('t3', {
      title: 'WAV Sidecar',
      filePath: 'C:\\Music\\wave_track.wav',
      format: 'WAV',
      lyrics: '[00:02.00]Sidecar',
      lyricsSource: 'sidecar',
      libraryRootId: 'root2'
    }),
    makeTrack('t4', {
      title: 'Instrumental',
      lyrics: null,
      lyricsSource: 'none'
    })
  ]

  it('filters by search query across title, artist, album, and filename', () => {
    expect(filterTracks(tracks, { search: 'nujabes', status: 'all' }).map((t) => t.id)).toEqual(['t1'])
    expect(filterTracks(tracks, { search: 'wave_track.wav', status: 'all' }).map((t) => t.id)).toEqual(['t3'])
    expect(filterTracks(tracks, { search: 'album t4', status: 'all' }).map((t) => t.id)).toEqual(['t4'])
  })

  it('filters by lyrics status and draftTrackIds', () => {
    expect(filterTracks(tracks, { search: '', status: 'missing' }).map((t) => t.id)).toEqual(['t4'])
    expect(filterTracks(tracks, { search: '', status: 'synced' }).map((t) => t.id)).toEqual(['t1', 't3'])
    expect(filterTracks(tracks, { search: '', status: 'plain' }).map((t) => t.id)).toEqual(['t2'])
    expect(filterTracks(tracks, { search: '', status: 'sidecar' }).map((t) => t.id)).toEqual(['t3'])
    expect(
      filterTracks(tracks, {
        search: '',
        status: 'draft',
        draftTrackIds: new Set(['t4'])
      }).map((t) => t.id)
    ).toEqual(['t2', 't4'])
  })

  it('filters by rootId', () => {
    expect(filterTracks(tracks, { search: '', status: 'all', rootId: 'root2' }).map((t) => t.id)).toEqual(['t3'])
  })
})

describe('applyTrackClick and selection helpers', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('handles plain click, Ctrl/Meta toggle, Shift range, and Ctrl+Shift additive range', () => {
    let state = createEmptySelectionState()

    // Plain click on 'b'
    state = applyTrackClick(state, ids, 'b')
    expect([...state.selectedIds]).toEqual(['b'])
    expect(state.anchorId).toBe('b')
    expect(state.focusedId).toBe('b')

    // Shift-click on 'd' -> selects b, c, d; anchor remains 'b'
    state = applyTrackClick(state, ids, 'd', { shiftKey: true })
    expect([...state.selectedIds]).toEqual(['b', 'c', 'd'])
    expect(state.anchorId).toBe('b')
    expect(state.focusedId).toBe('d')

    // Ctrl-click on 'c' -> toggles 'c' off, updates anchor to 'c'
    state = applyTrackClick(state, ids, 'c', { ctrlKey: true })
    expect([...state.selectedIds]).toEqual(['b', 'd'])
    expect(state.anchorId).toBe('c')
    expect(state.focusedId).toBe('c')

    // Ctrl+Shift click on 'e' -> unions range ['c','d','e'] onto existing ['b','d']
    state = applyTrackClick(state, ids, 'e', { metaKey: true, shiftKey: true })
    expect([...state.selectedIds].sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(state.anchorId).toBe('c')
    expect(state.focusedId).toBe('e')
  })

  it('handles reverse Shift-click range and falls back to single select when anchor missing', () => {
    let state = applyTrackClick(createEmptySelectionState(), ids, 'd')
    state = applyTrackClick(state, ids, 'a', { shiftKey: true })
    expect([...state.selectedIds]).toEqual(['a', 'b', 'c', 'd'])

    const unknownAnchor = applyTrackClick(
      { selectedIds: new Set(), anchorId: 'missing', focusedId: null },
      ids,
      'c',
      { shiftKey: true }
    )
    expect([...unknownAnchor.selectedIds]).toEqual(['c'])
    expect(unknownAnchor.anchorId).toBe('c')
  })

  it('selects all, clears, and reconciles removed track IDs', () => {
    const all = selectAllVisible(ids, 'c')
    expect(all.selectedIds.size).toBe(5)
    expect(all.focusedId).toBe('c')

    const reconciled = reconcileSelection(all, ['b', 'c'])
    expect([...reconciled.selectedIds]).toEqual(['b', 'c'])
    expect(reconciled.anchorId).toBeNull()
    expect(reconciled.focusedId).toBe('c')

    const cleared = clearSelection('c')
    expect(cleared.selectedIds.size).toBe(0)
    expect(cleared.focusedId).toBe('c')
  })
})
