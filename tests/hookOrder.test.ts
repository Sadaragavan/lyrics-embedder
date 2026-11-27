import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { RightPanel } from '../src/renderer/src/components/RightPanel/RightPanel'
import type { TrackRecord, LyricsSearchResult, WorkspaceMode, LyricsFetchProgress } from '@shared/ipc'
import type { TrackEmbedStatus } from '../src/renderer/src/types'
import type { LyricsProviderFilter, AiJobState } from '@shared/ipc'
import type { LyricsSource } from '@shared/types'

// Minimal mock track
const mockTrack: TrackRecord = {
  id: 'test-track-1',
  filePath: '/fake/path/test.mp3',
  format: 'mp3',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  durationSec: 240,
  lyrics: '[00:00.00]Test lyrics\n[00:05.00]More lyrics',
  lyricsSource: 'embedded' as LyricsSource,
  existingLyricsKeys: [],
  libraryRootId: 'test-root',
  mtimeMs: Date.now()
}

const mockSearchResult: LyricsSearchResult = {
  providerId: 'lrclib',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  durationSec: 240,
  syncedLyrics: '[00:00.00]Test lyrics',
  plainLyrics: '',
  timingKind: 'line',
  score: 1.0
}

const emptyProps = {
  focusedTrack: null as TrackRecord | null,
  editorState: null as any,
  focusedEditorState: null as any,
  playbackTimeMs: 0,
  loadedTrackId: null as string | null,
  preserveWordTags: false,
  onPreserveWordTagsChange: vi.fn(),
  onLyricsChange: vi.fn(),
  onTranslationChange: vi.fn(),
  onRomanizationChange: vi.fn(),
  onSeekToMs: vi.fn(),
  onImportLrc: vi.fn(),
  onRevert: vi.fn(),
  onEmbedFocused: vi.fn(),
  onNormalize: vi.fn(),
  onPreviewTextChange: vi.fn(),
  workerReady: true,
  embedStatus: undefined as TrackEmbedStatus | undefined,
  fetchProgress: undefined as LyricsFetchProgress | undefined,
  aiJob: null as AiJobState | null,
  onAiGenerate: vi.fn(),
  onAiCancel: vi.fn(),
  onOpenSettings: vi.fn(),
  aiConfigured: false,
  searchTitle: '',
  onSearchTitleChange: vi.fn(),
  searchArtist: '',
  onSearchArtistChange: vi.fn(),
  searchAlbum: '',
  onSearchAlbumChange: vi.fn(),
  searchDuration: '',
  onSearchDurationChange: vi.fn(),
  searchResults: [] as LyricsSearchResult[],
  searchLoading: false,
  searchError: null,
  searchSearched: false,
  onSearchCandidates: vi.fn(),
  onLoadCandidate: vi.fn(),
  onLoadAllLayers: vi.fn(),
  providerFilter: 'all' as LyricsProviderFilter,
  onProviderFilterChange: vi.fn(),
  showTranslationLayer: true,
  onShowTranslationLayerChange: vi.fn(),
  showRomanizationLayer: true,
  onShowRomanizationLayerChange: vi.fn(),
  stackedOutput: '',
  hasTranslation: false,
  hasRomanization: false,
  workspaceMode: 'lyrics' as WorkspaceMode,
  onWorkspaceModeChange: vi.fn()
}

const trackProps = {
  ...emptyProps,
  focusedTrack: mockTrack,
  editorState: {
    trackId: mockTrack.id,
    primary: mockTrack.lyrics ?? '',
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: false,
    saveState: 'idle' as const
  },
  focusedEditorState: {
    trackId: mockTrack.id,
    primary: mockTrack.lyrics ?? '',
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: false,
    saveState: 'idle' as const
  },
  searchResults: [mockSearchResult],
  searchSearched: true
}

describe('RightPanel hook order stability', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    document.body.removeChild(container)
    vi.clearAllMocks()
  })

  it('renders without error when focusedTrack is null (no track focused)', () => {
    // This should not throw React error #310
    act(() => {
      root.render(createElement(RightPanel, emptyProps))
    })

    // Should show "No track focused" message
    expect(container.textContent).toContain('No track focused')
  })

  it('renders without error when focusedTrack is provided', () => {
    act(() => {
      root.render(createElement(RightPanel, trackProps))
    })

    // Should show the track title
    expect(container.textContent).toContain('Test Song')
  })

  it('transitions from no-track to track-focused without hook-order error (#310)', () => {
    // First render: no track focused
    act(() => {
      root.render(createElement(RightPanel, emptyProps))
    })
    expect(container.textContent).toContain('No track focused')

    // Second render: track focused (simulates user clicking a track)
    // This transition must not change hook call order between renders
    act(() => {
      root.render(createElement(RightPanel, trackProps))
    })
    expect(container.textContent).toContain('Test Song')
  })

  it('transitions from track-focused to no-track without hook-order error', () => {
    // First render: track focused
    act(() => {
      root.render(createElement(RightPanel, trackProps))
    })
    expect(container.textContent).toContain('Test Song')

    // Second render: no track focused (simulates clearing selection)
    act(() => {
      root.render(createElement(RightPanel, emptyProps))
    })
    expect(container.textContent).toContain('No track focused')
  })

  it('handles multiple focus transitions without error', () => {
    // Simulate rapid focus changes
    for (let i = 0; i < 5; i++) {
      const props = i % 2 === 0 ? trackProps : emptyProps
      act(() => {
        root.render(createElement(RightPanel, props))
      })
    }
    // Final state should be track-focused
    expect(container.textContent).toContain('Test Song')
  })

  it('switches workspace modes without hook-order error', () => {
    const modes: WorkspaceMode[] = ['lyrics', 'text', 'find']
    act(() => {
      root.render(createElement(RightPanel, trackProps))
    })

    for (const mode of modes) {
      act(() => {
        root.render(createElement(RightPanel, { ...trackProps, workspaceMode: mode }))
      })
    }
  })

  it('handles provider filter changes without hook-order error', () => {
    const filters: LyricsProviderFilter[] = ['all', 'lrclib', 'netease', 'localSidecar']
    act(() => {
      root.render(createElement(RightPanel, trackProps))
    })

    for (const filter of filters) {
      act(() => {
        root.render(createElement(RightPanel, { ...trackProps, providerFilter: filter }))
      })
    }
  })
})