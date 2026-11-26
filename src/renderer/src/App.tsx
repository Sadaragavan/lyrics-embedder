import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Columns2,
  Eye,
  FileCode,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X
} from 'lucide-react'
import type {
  EditorLayout,
  LibraryRoot,
  LyricsCandidate,
  LyricsFetchProgress,
  LyricsFetchRequest,
  LyricsSearchResult,
  MenuAction,
  MenuSyncState,
  ScanProgress,
  TagEngineHealth,
  TrackRecord,
  WorkspaceMode
} from '@shared/ipc'
import { normalizeLrc, parseLrc } from '@shared/lrc'
import { findActiveLineIndices } from '@shared/lyricsSync'
import {
  applyTrackClick,
  clearSelection,
  createEmptySelectionState,
  filterTracks,
  reconcileSelection,
  selectAllVisible,
  type SelectionClickModifiers,
  type TrackLyricsFilter,
  type TrackSelectionState
} from '@shared/trackSelection'
import { AudioPreviewPlayer } from './components/AudioPreviewPlayer'
import { LibrarySidebar } from './components/LibrarySidebar'
import { LyricsEditorPanel } from './components/LyricsEditorPanel'
import { TrackTable } from './components/TrackTable'
import type { PlayerCommand, SeekRequest, TrackEmbedStatus } from './types'

const SIDEBAR_WIDTH_KEY = 'lyrics-embedder:sidebar-width'
const SIDEBAR_MIN_WIDTH = 280
const SIDEBAR_MAX_WIDTH = 720

function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_MIN_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(value)))
}

function readStoredSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (!raw) return 460
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : 460
  } catch {
    return 460
  }
}

function toFetchRequest(track: TrackRecord): LyricsFetchRequest {
  return {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    filePath: track.filePath
  }
}

export function App() {
  const [health, setHealth] = useState<TagEngineHealth | null>(null)
  const [roots, setRoots] = useState<LibraryRoot[]>([])
  const [tracks, setTracks] = useState<TrackRecord[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)

  const [activeRootFilter, setActiveRootFilter] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<TrackLyricsFilter>('all')

  const [selection, setSelection] = useState<TrackSelectionState>(createEmptySelectionState)
  const [draftTexts, setDraftTexts] = useState<Map<string, string>>(() => new Map())
  const [draftTrackIds, setDraftTrackIds] = useState<Set<string>>(() => new Set())
  const [dirtyTrackIds, setDirtyTrackIds] = useState<Set<string>>(() => new Set())
  const [preserveWordTags, setPreserveWordTags] = useState(false)
  /** Live preview text emitted by the editor (primary or stacked layers). */
  const [livePreview, setLivePreview] = useState<{ trackId: string; text: string } | null>(null)
  /** Translation + romanization layers lifted so native menu actions can drive them. */
  const [secondaryLayerText, setSecondaryLayerText] = useState('')
  const [romanizationLayerText, setRomanizationLayerText] = useState('')

  const [searchTitle, setSearchTitle] = useState('')
  const [searchArtist, setSearchArtist] = useState('')
  const [searchAlbum, setSearchAlbum] = useState('')
  const [searchDuration, setSearchDuration] = useState('')
  const [searchResults, setSearchResults] = useState<LyricsSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchSearched, setSearchSearched] = useState(false)

  const [fetchProgressMap, setFetchProgressMap] = useState<Map<string, LyricsFetchProgress>>(
    () => new Map()
  )
  const [embedStatusMap, setEmbedStatusMap] = useState<Map<string, TrackEmbedStatus>>(
    () => new Map()
  )
  const [embedding, setEmbedding] = useState(false)

  // --- Phase 5: Native menu + dynamic workspace state ---
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredSidebarWidth())
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('edit')
  const [editorLayout, setEditorLayout] = useState<EditorLayout>('split')

  // Draggable split divider between the library sidebar and the workspace.
  const dividerDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const handleDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      dividerDragRef.current = { startX: event.clientX, startWidth: sidebarWidth }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [sidebarWidth]
  )
  const handleDividerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dividerDragRef.current
    if (!drag) return
    const next = drag.startWidth + (event.clientX - drag.startX)
    setSidebarWidth(clampSidebarWidth(next))
  }, [])

  // Persist the sidebar width so the 1366x768 layout survives reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // Storage can be unavailable (private mode); the width is cosmetic.
    }
  }, [sidebarWidth])
  const handleDividerPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dividerDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const [loadedTrackId, setLoadedTrackId] = useState<string | null>(null)
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)
  /** One-shot imperative command from the native Playback menu. */
  const [playerCommand, setPlayerCommand] = useState<PlayerCommand | null>(null)

  const [bannerError, setBannerError] = useState<string | null>(null)
  const [bannerStatus, setBannerStatus] = useState<string | null>(null)

  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const draftTextsRef = useRef(draftTexts)
  draftTextsRef.current = draftTexts
  /** Invalidates in-flight candidate searches when focus changes. */
  const searchNonceRef = useRef(0)
  /**
   * Holds the current `handleMenuAction` so the startup effect can subscribe to
   * native menu events exactly once. Without this the effect re-ran on every
   * render (re-issuing getHealth/getRoots/getTracks and re-subscribing IPC
   * listeners), which drove the render -> IPC -> menu rebuild loop.
   */
  const handleMenuActionRef = useRef<(action: MenuAction) => Promise<void>>(async () => undefined)

  const filteredTracks = useMemo(
    () =>
      filterTracks(tracks, {
        search,
        status: statusFilter,
        rootId: activeRootFilter || undefined,
        draftTrackIds
      }),
    [tracks, search, statusFilter, activeRootFilter, draftTrackIds]
  )

  const visibleTrackIds = useMemo(
    () => filteredTracks.map((track) => track.id),
    [filteredTracks]
  )

  const focusedTrack = useMemo(
    () => tracks.find((track) => track.id === selection.focusedId) ?? null,
    [tracks, selection.focusedId]
  )

  const focusedLyricsText = useMemo(() => {
    if (!focusedTrack) return ''
    return draftTexts.get(focusedTrack.id) ?? focusedTrack.lyrics ?? ''
  }, [focusedTrack, draftTexts])

  const focusedTrackId = focusedTrack?.id ?? null

  // Reset lifted layer text whenever the focused track changes.
  useEffect(() => {
    setSecondaryLayerText('')
    setRomanizationLayerText('')
  }, [focusedTrackId])

  /**
   * Lyrics text currently driving the audio player's active lines.
   * Kept separate from `playbackTimeMs` so `parseLrc` runs only when the text
   * changes rather than on every 60fps RAF playback tick.
   */
  const loadedTrackLyricsText = useMemo(() => {
    if (!loadedTrackId) return ''
    const useLivePreview =
      focusedTrackId === loadedTrackId &&
      livePreview !== null &&
      livePreview.trackId === loadedTrackId
    if (useLivePreview) return livePreview.text
    const loadedTrack = tracks.find((t) => t.id === loadedTrackId)
    return draftTexts.get(loadedTrackId) ?? loadedTrack?.lyrics ?? ''
  }, [loadedTrackId, focusedTrackId, livePreview, tracks, draftTexts])

  const loadedTrackParsedLines = useMemo(
    () =>
      loadedTrackLyricsText
        ? parseLrc(loadedTrackLyricsText, { preserveWordTags })
        : [],
    [loadedTrackLyricsText, preserveWordTags]
  )

  const activeLineTexts = useMemo(() => {
    if (loadedTrackParsedLines.length === 0) return []
    return findActiveLineIndices(loadedTrackParsedLines, playbackTimeMs).map(
      (index) => loadedTrackParsedLines[index]?.text || '(instrumental)'
    )
  }, [loadedTrackParsedLines, playbackTimeMs])

  const activeFetchCount = useMemo(() => {
    let count = 0
    for (const progress of fetchProgressMap.values()) {
      if (progress.phase === 'fetching') count++
    }
    return count
  }, [fetchProgressMap])

  const menuSyncState = useMemo<MenuSyncState>(() => {
    return {
      hasFocusedTrack: focusedTrack !== null,
      hasDraft: focusedTrack
        ? Boolean(focusedTrack.draftId || draftTrackIds.has(focusedTrack.id))
        : false,
      isDirty: focusedTrack ? dirtyTrackIds.has(focusedTrack.id) : false,
      hasLyrics: Boolean(focusedLyricsText),
      workerReady: Boolean(health?.ready),
      preserveWordTags,
      sidebarVisible,
      mode: workspaceMode,
      editorLayout,
      isPlaying,
      canPlay: focusedTrack !== null,
      canStop: loadedTrackId !== null,
      selectedCount: selection.selectedIds.size,
      embedding
    }
  }, [
    focusedTrack,
    draftTrackIds,
    dirtyTrackIds,
    focusedLyricsText,
    health,
    preserveWordTags,
    sidebarVisible,
    workspaceMode,
    editorLayout,
    isPlaying,
    loadedTrackId,
    selection.selectedIds.size,
    embedding
  ])

  // Keep the native menu checkboxes/radios/enabled flags in sync with renderer state.
  useEffect(() => {
    void window.api.syncMenuState(menuSyncState)
  }, [menuSyncState])

  const applyFetchedCandidate = useCallback(
    async (trackId: string, candidate: LyricsCandidate): Promise<boolean> => {
      const text = candidate.syncedLyrics ?? candidate.plainLyrics
      if (!text) return false
      try {
        const draft = await window.api.saveDraft({ trackId, lyrics: text, status: 'pending' })
        setDraftTexts((prev) => {
          const next = new Map(prev)
          next.set(trackId, text)
          return next
        })
        setDraftTrackIds((prev) => {
          const next = new Set(prev)
          next.add(trackId)
          return next
        })
        setDirtyTrackIds((prev) => {
          const next = new Set(prev)
          next.delete(trackId)
          return next
        })
        setTracks((prev) =>
          prev.map((track) => (track.id === trackId ? { ...track, draftId: draft.id } : track))
        )
        return true
      } catch (error) {
        setBannerError(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    []
  )

  // Initial load + main-process event subscriptions
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [initialHealth, initialRoots, initialTracks] = await Promise.all([
          window.api.getHealth(),
          window.api.getRoots(),
          window.api.getTracks()
        ])
        if (!active) return
        setHealth(initialHealth)
        setRoots(initialRoots)
        setTracks(initialTracks)
        setDraftTrackIds(
          new Set(initialTracks.filter((t) => Boolean(t.draftId)).map((t) => t.id))
        )
      } catch (error) {
        if (active) {
          setBannerError(error instanceof Error ? error.message : String(error))
        }
      }
    })()

    const unsubScanProgress = window.api.onScanProgress((progress) => {
      setScanProgress(progress)
      setScanning(progress.phase === 'scanning')
    })

    const unsubScanComplete = window.api.onScanComplete(async () => {
      try {
        const [nextRoots, nextTracks] = await Promise.all([
          window.api.getRoots(),
          window.api.getTracks()
        ])
        setRoots(nextRoots)
        setTracks(nextTracks)
        setDraftTrackIds(
          new Set(nextTracks.filter((t) => Boolean(t.draftId)).map((t) => t.id))
        )
        setSelection((prev) =>
          reconcileSelection(
            prev,
            nextTracks.map((t) => t.id)
          )
        )
      } catch (error) {
        setBannerError(error instanceof Error ? error.message : String(error))
      } finally {
        setScanning(false)
      }
    })

    const unsubFetchProgress = window.api.onLyricsFetchProgress((progress) => {
      setFetchProgressMap((prev) => {
        const next = new Map(prev)
        next.set(progress.trackId, progress)
        return next
      })
      if (progress.phase === 'done' && progress.candidate) {
        void applyFetchedCandidate(progress.trackId, progress.candidate)
      }
    })

    const unsubMenuAction = window.api.onMenuAction((action) => {
      void handleMenuActionRef.current(action)
    })

    return () => {
      active = false
      unsubScanProgress()
      unsubScanComplete()
      unsubFetchProgress()
      unsubMenuAction()
    }
  }, [applyFetchedCandidate])

  // Load persisted draft when focusing a track not yet cached in draftTexts
  useEffect(() => {
    const trackId = selection.focusedId
    if (!trackId) return
    if (draftTextsRef.current.has(trackId)) return
    const track = tracksRef.current.find((t) => t.id === trackId)
    if (!track?.draftId) return

    let cancelled = false
    void window.api
      .getDraft(trackId)
      .then((draft) => {
        if (cancelled || !draft) return
        setDraftTexts((prev) => {
          if (prev.has(trackId)) return prev
          const next = new Map(prev)
          next.set(trackId, draft.lyrics)
          return next
        })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [selection.focusedId])

  // Pre-fill the candidate sifter from the focused track and reset stale results.
  useEffect(() => {
    searchNonceRef.current += 1
    setSearchLoading(false)
    const track = focusedTrackId
      ? (tracksRef.current.find((t) => t.id === focusedTrackId) ?? null)
      : null
    setSearchTitle(track?.title ?? '')
    setSearchArtist(track?.artist ?? '')
    setSearchAlbum(track?.album ?? '')
    setSearchDuration(
      track && Number.isFinite(track.durationSec) && track.durationSec > 0
        ? String(Math.round(track.durationSec))
        : ''
    )
    setSearchResults([])
    setSearchError(null)
    setSearchSearched(false)
  }, [focusedTrackId])

  const handlePreviewTextChange = useCallback((trackId: string, text: string) => {
    setLivePreview((prev) =>
      prev && prev.trackId === trackId && prev.text === text ? prev : { trackId, text }
    )
  }, [])

  async function handleSearchCandidates() {
    if (!focusedTrack || searchLoading) return
    const nonce = ++searchNonceRef.current
    setSearchLoading(true)
    setSearchError(null)
    setSearchSearched(false)
    try {
      const parsedDuration = Number.parseFloat(searchDuration)
      const durationSec =
        Number.isFinite(parsedDuration) && parsedDuration > 0
          ? parsedDuration
          : focusedTrack.durationSec
      const results = await window.api.searchLyricsCandidates({
        trackId: focusedTrack.id,
        title: focusedTrack.title,
        artist: focusedTrack.artist,
        album: focusedTrack.album,
        durationSec,
        filePath: focusedTrack.filePath,
        searchTitle: searchTitle.trim(),
        searchArtist: searchArtist.trim(),
        searchAlbum: searchAlbum.trim()
      })
      if (searchNonceRef.current !== nonce) return
      setSearchResults(results)
    } catch (error) {
      if (searchNonceRef.current !== nonce) return
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (searchNonceRef.current === nonce) {
        setSearchLoading(false)
        setSearchSearched(true)
      }
    }
  }

  async function handleLoadCandidate(result: LyricsSearchResult) {
    if (!focusedTrack) return
    const text = result.syncedLyrics ?? result.plainLyrics
    if (!text) return
    setBannerError(null)
    const applied = await applyFetchedCandidate(focusedTrack.id, result)
    if (applied) {
      setBannerStatus(
        `Loaded ${result.providerId === 'lrclib' ? 'LRCLIB' : 'local .lrc'} candidate as draft.`
      )
    }
  }

  const lastFetchError = useMemo(() => {
    for (const progress of fetchProgressMap.values()) {
      if (progress.phase === 'error' && progress.error) {
        const provider =
          progress.providerId === 'lrclib'
            ? 'LRCLIB'
            : progress.providerId === 'localSidecar'
              ? 'local .lrc'
              : 'provider'
        return `${provider}: ${progress.error}`
      }
    }
    return null
  }, [fetchProgressMap])

  async function handleAddRoot() {
    setBannerError(null)
    try {
      const folder = await window.api.selectLibraryFolder()
      if (!folder) return
      const added = await window.api.addRoot({ path: folder })
      setRoots(await window.api.getRoots())
      setBannerStatus(`Added root "${added.name}". Scanning...`)
      setScanning(true)
      await window.api.scanLibrary({ rootId: added.id })
      setBannerStatus(`Scanned "${added.name}".`)
    } catch (error) {
      setScanning(false)
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleRemoveRoot(rootId: string) {
    setBannerError(null)
    try {
      await window.api.removeRoot(rootId)
      const [nextRoots, nextTracks] = await Promise.all([
        window.api.getRoots(),
        window.api.getTracks()
      ])
      setRoots(nextRoots)
      setTracks(nextTracks)
      if (activeRootFilter === rootId) setActiveRootFilter('')
      setSelection((prev) =>
        reconcileSelection(
          prev,
          nextTracks.map((t) => t.id)
        )
      )
      setDraftTrackIds(
        new Set(nextTracks.filter((t) => Boolean(t.draftId)).map((t) => t.id))
      )
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleScan(rootId?: string) {
    setBannerError(null)
    setBannerStatus(null)
    setScanning(true)
    try {
      const result = await window.api.scanLibrary(rootId ? { rootId } : undefined)
      const [nextRoots, nextTracks] = await Promise.all([
        window.api.getRoots(),
        window.api.getTracks()
      ])
      setRoots(nextRoots)
      setTracks(nextTracks)
      setDraftTrackIds(
        new Set(nextTracks.filter((t) => Boolean(t.draftId)).map((t) => t.id))
      )
      setSelection((prev) =>
        reconcileSelection(
          prev,
          nextTracks.map((t) => t.id)
        )
      )
      setBannerStatus(`Scan complete (${result.tracks.length} tracks indexed).`)
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }

  function handleRowClick(trackId: string, modifiers: SelectionClickModifiers) {
    setSelection((prev) => applyTrackClick(prev, visibleTrackIds, trackId, modifiers))
  }

  function handleLyricsChange(nextLyrics: string) {
    if (!focusedTrack) return
    const trackId = focusedTrack.id
    setDraftTexts((prev) => {
      const next = new Map(prev)
      next.set(trackId, nextLyrics)
      return next
    })
    setDirtyTrackIds((prev) => {
      const next = new Set(prev)
      next.add(trackId)
      return next
    })
  }

  async function handleSaveDraft(trackId: string, lyrics: string) {
    setBannerError(null)
    try {
      const draft = await window.api.saveDraft({ trackId, lyrics, status: 'pending' })
      setDraftTexts((prev) => {
        const next = new Map(prev)
        next.set(trackId, lyrics)
        return next
      })
      setDraftTrackIds((prev) => {
        const next = new Set(prev)
        next.add(trackId)
        return next
      })
      setDirtyTrackIds((prev) => {
        const next = new Set(prev)
        next.delete(trackId)
        return next
      })
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, draftId: draft.id } : t))
      )
      setBannerStatus('Draft saved.')
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleDiscardDraft(trackId: string) {
    setBannerError(null)
    try {
      await window.api.deleteDraft(trackId)
      const original = tracksRef.current.find((t) => t.id === trackId)?.lyrics ?? ''
      setDraftTexts((prev) => {
        const next = new Map(prev)
        next.set(trackId, original)
        return next
      })
      setDraftTrackIds((prev) => {
        const next = new Set(prev)
        next.delete(trackId)
        return next
      })
      setDirtyTrackIds((prev) => {
        const next = new Set(prev)
        next.delete(trackId)
        return next
      })
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, draftId: undefined } : t))
      )
      setBannerStatus('Draft discarded.')
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleImportLrc() {
    if (!focusedTrack) return
    setBannerError(null)
    try {
      const selected = await window.api.selectLrcFile()
      if (!selected) return
      const content = await window.api.lyricsImportFile(selected)
      if (!content) {
        setBannerError('Selected .lrc file was empty, symlinked, or exceeded 1 MiB.')
        return
      }
      await handleSaveDraft(focusedTrack.id, content)
      setBannerStatus(`Imported ${selected}`)
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleFetchFocused() {
    if (!focusedTrack) return
    setBannerError(null)
    try {
      await window.api.lyricsFetch(toFetchRequest(focusedTrack))
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleFetchSelected() {
    const targets = filteredTracks.filter((track) => selection.selectedIds.has(track.id))
    if (targets.length === 0) return
    setBannerError(null)
    setBannerStatus(`Fetching lyrics for ${targets.length} track(s)...`)
    try {
      await window.api.lyricsFetchBatch(targets.map(toFetchRequest))
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleCancelActiveFetches() {
    const ids: string[] = []
    for (const [id, progress] of fetchProgressMap) {
      if (progress.phase === 'fetching') ids.push(id)
    }
    await Promise.all(ids.map((id) => window.api.lyricsCancelFetch(id)))
  }

  async function embedSingleTrack(track: TrackRecord, payload: string): Promise<boolean> {
    setEmbedStatusMap((prev) => {
      const next = new Map(prev)
      next.set(track.id, { phase: 'embedding' })
      return next
    })
    try {
      const result = await window.api.embedLyrics({
        filePath: track.filePath,
        lyrics: payload
      })
      const refreshed = await window.api.getTrack(track.id)
      await window.api.deleteDraft(track.id)

      setDraftTexts((prev) => {
        const next = new Map(prev)
        next.set(track.id, refreshed?.lyrics ?? payload)
        return next
      })
      setDraftTrackIds((prev) => {
        const next = new Set(prev)
        next.delete(track.id)
        return next
      })
      setDirtyTrackIds((prev) => {
        const next = new Set(prev)
        next.delete(track.id)
        return next
      })
      if (refreshed) {
        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id ? { ...refreshed, draftId: undefined } : t
          )
        )
      }
      setEmbedStatusMap((prev) => {
        const next = new Map(prev)
        next.set(track.id, {
          phase: 'verified',
          targetPath: result.targetPath,
          lyricsSource: result.lyricsSource
        })
        return next
      })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setEmbedStatusMap((prev) => {
        const next = new Map(prev)
        next.set(track.id, { phase: 'error', error: message })
        return next
      })
      return false
    }
  }

  async function handleEmbedFocused() {
    if (!focusedTrack || embedding) return
    setEmbedding(true)
    setBannerError(null)
    setBannerStatus(null)
    try {
      const ok = await embedSingleTrack(focusedTrack, focusedLyricsText)
      if (ok) {
        setBannerStatus(`Embedded lyrics for "${focusedTrack.title}".`)
      } else {
        setBannerError(`Failed to embed "${focusedTrack.title}".`)
      }
    } finally {
      setEmbedding(false)
    }
  }

  async function handleEmbedSelected() {
    if (embedding) return
    const targets = filteredTracks.filter((track) => selection.selectedIds.has(track.id))
    if (targets.length === 0) return

    setEmbedding(true)
    setBannerError(null)
    let succeeded = 0
    let failed = 0
    try {
      for (const track of targets) {
        let payload = draftTextsRef.current.get(track.id)
        if (payload === undefined && track.draftId) {
          const draft = await window.api.getDraft(track.id)
          payload = draft?.lyrics
        }
        if (payload === undefined) {
          payload = track.lyrics ?? ''
        }
        if (payload.length === 0 && track.lyrics === null) {
          continue
        }
        const ok = await embedSingleTrack(track, payload)
        if (ok) succeeded++
        else failed++
      }
      setBannerStatus(
        `Batch embed finished: ${succeeded} verified${failed > 0 ? `, ${failed} failed` : ''}.`
      )
    } finally {
      setEmbedding(false)
    }
  }

  async function handleMenuAction(action: MenuAction): Promise<void> {
    switch (action) {
      case 'add-library-folder':
        await handleAddRoot()
        break
      case 'scan-all-roots':
        await handleScan()
        break
      case 'import-lrc':
        await handleImportLrc()
        break
      case 'save-draft':
        if (focusedTrack) await handleSaveDraft(focusedTrack.id, focusedLyricsText)
        break
      case 'discard-draft':
        if (focusedTrack) await handleDiscardDraft(focusedTrack.id)
        break
      case 'embed-current-track':
        if (focusedTrack && !embedding) await handleEmbedFocused()
        break
      case 'normalize-lrc':
        if (focusedTrack) {
          handleLyricsChange(normalizeLrc(focusedLyricsText, { preserveWordTags }))
        }
        break
      case 'toggle-preserve-word-tags':
        setPreserveWordTags((prev) => !prev)
        break
      case 'send-primary-to-translation':
        handleSendPrimaryToTranslation()
        break
      case 'send-primary-to-romanization':
        handleSendPrimaryToRomanization()
        break
      case 'toggle-sidebar':
        setSidebarVisible((prev) => !prev)
        break
      case 'mode-edit':
        setWorkspaceMode('edit')
        break
      case 'mode-layers':
        setWorkspaceMode('layers')
        break
      case 'mode-find':
        setWorkspaceMode('find')
        break
      case 'layout-raw':
        setEditorLayout('raw')
        break
      case 'layout-split':
        setEditorLayout('split')
        break
      case 'layout-preview':
        setEditorLayout('preview')
        break
      case 'toggle-play-pause':
        setPlayerCommand({ kind: 'toggle', nonce: Date.now() + Math.random() })
        break
      case 'stop-and-unload':
        setPlayerCommand({ kind: 'stop', nonce: Date.now() + Math.random() })
        break
      case 'show-tag-engine-status':
        // Answered entirely in main (menu.ts showEngineStatusDialog).
        break
    }
  }

  // Always point the ref at the latest closure (menu actions read live state).
  handleMenuActionRef.current = handleMenuAction

  function handleSendPrimaryToTranslation() {
    if (!focusedTrack) return
    setSecondaryLayerText(focusedLyricsText)
    setWorkspaceMode('layers')
  }

  function handleSendPrimaryToRomanization() {
    if (!focusedTrack) return
    setRomanizationLayerText(focusedLyricsText)
    setWorkspaceMode('layers')
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      {/*
        Transient status toast. It floats over the workspace instead of taking a
        permanent row so the 1366x768 layout keeps zero top chrome.
      */}
      {(bannerError || bannerStatus) && (
        <div
          role="status"
          className={`absolute left-1/2 top-2 z-40 flex w-[min(560px,90vw)] -translate-x-1/2 items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-xs shadow-lg shadow-black/50 ${
            bannerError
              ? 'border-red-900/80 bg-red-950/60 text-red-200'
              : 'border-emerald-900/80 bg-emerald-950/40 text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {bannerError ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            )}
            <span className="truncate">{bannerError ?? bannerStatus}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              setBannerError(null)
              setBannerStatus(null)
            }}
            className="text-zinc-400 hover:text-zinc-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <main className="flex flex-1 min-h-0 overflow-hidden bg-zinc-950">
        {sidebarVisible && (
          <div
            className="flex shrink-0 min-h-0 flex-col border-r border-zinc-800 px-2 py-2"
            style={{ width: `${sidebarWidth}px` }}
          >
            <LibrarySidebar
              health={health}
              roots={roots}
              activeRootFilter={activeRootFilter}
              onActiveRootFilterChange={setActiveRootFilter}
              tracksCount={tracks.length}
              filteredCount={filteredTracks.length}
              selectedCount={selection.selectedIds.size}
              scanning={scanning}
              scanProgress={scanProgress}
              search={search}
              onSearchChange={setSearch}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              activeFetchCount={activeFetchCount}
              lastFetchError={lastFetchError}
              embedding={embedding}
              onAddRoot={() => void handleAddRoot()}
              onRemoveRoot={(id) => void handleRemoveRoot(id)}
              onScanAll={() => void handleScan()}
              onScanRoot={(id) => void handleScan(id)}
              onFetchSelected={() => void handleFetchSelected()}
              onCancelActiveFetches={() => void handleCancelActiveFetches()}
              onEmbedSelected={() => void handleEmbedSelected()}
              onClearSelection={() => setSelection((prev) => clearSelection(prev.focusedId))}
            />
            <TrackTable
              tracks={filteredTracks}
              selection={selection}
              draftTrackIds={draftTrackIds}
              fetchProgressMap={fetchProgressMap}
              embedStatusMap={embedStatusMap}
              loadedTrackId={loadedTrackId}
              isPlaying={isPlaying}
              onRowClick={handleRowClick}
              onSelectAll={() =>
                setSelection((prev) => selectAllVisible(visibleTrackIds, prev.focusedId))
              }
              onClearSelection={() =>
                setSelection((prev) => clearSelection(prev.focusedId))
              }
            />
          </div>
        )}

        {sidebarVisible && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize library sidebar"
            title="Drag to resize the library sidebar"
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            className="w-1 shrink-0 cursor-col-resize bg-zinc-800/80 transition-colors hover:bg-emerald-700/70 active:bg-emerald-600"
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col py-2 pr-2 pl-2 gap-2">
          {/* Mode bar: workspace modes + editor layout + sidebar toggle */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 py-1.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                title={
                  sidebarVisible
                    ? 'Hide the library sidebar (Ctrl+B)'
                    : 'Show the library sidebar (Ctrl+B)'
                }
                aria-label={sidebarVisible ? 'Hide library sidebar' : 'Show library sidebar'}
                onClick={() => setSidebarVisible((prev) => !prev)}
                className="mr-1 inline-flex items-center justify-center rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                {sidebarVisible ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeftOpen className="h-4 w-4" />
                )}
              </button>

              <div
                className="inline-flex overflow-hidden rounded-md border border-zinc-700"
                role="group"
                aria-label="Workspace mode"
              >
                <button
                  type="button"
                  aria-pressed={workspaceMode === 'edit'}
                  title="Edit workspace: raw + stacked LRC editor (Ctrl+1)"
                  onClick={() => setWorkspaceMode('edit')}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium ${
                    workspaceMode === 'edit'
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <FileCode className="h-3 w-3" />
                  Edit
                </button>
                <button
                  type="button"
                  aria-pressed={workspaceMode === 'layers'}
                  title="Layers workspace: translation + romanization stacking (Ctrl+2)"
                  onClick={() => setWorkspaceMode('layers')}
                  className={`inline-flex items-center gap-1 border-l border-zinc-700 px-2 py-1 text-[11px] font-medium ${
                    workspaceMode === 'layers'
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <Layers className="h-3 w-3" />
                  Layers
                </button>
                <button
                  type="button"
                  aria-pressed={workspaceMode === 'find'}
                  title="Find workspace: open the candidate sifter (Ctrl+3)"
                  onClick={() => setWorkspaceMode('find')}
                  className={`inline-flex items-center gap-1 border-l border-zinc-700 px-2 py-1 text-[11px] font-medium ${
                    workspaceMode === 'find'
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <Search className="h-3 w-3" />
                  Find
                </button>
              </div>
            </div>

            <div
              className="inline-flex overflow-hidden rounded-md border border-zinc-700"
              role="group"
              aria-label="Editor layout"
            >
              <button
                type="button"
                aria-pressed={editorLayout === 'raw'}
                title="Raw editor layout"
                onClick={() => setEditorLayout('raw')}
                className={`p-1 ${editorLayout === 'raw' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
              >
                <FileCode className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={editorLayout === 'split'}
                title="Split editor layout (default)"
                onClick={() => setEditorLayout('split')}
                className={`border-l border-zinc-700 p-1 ${editorLayout === 'split' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
              >
                <Columns2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={editorLayout === 'preview'}
                title="Preview-focused editor layout"
                onClick={() => setEditorLayout('preview')}
                className={`border-l border-zinc-700 p-1 ${editorLayout === 'preview' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
          <LyricsEditorPanel
            focusedTrack={focusedTrack}
            selectedCount={selection.selectedIds.size}
            lyricsText={focusedLyricsText}
            hasDraft={
              focusedTrack
                ? Boolean(focusedTrack.draftId || draftTrackIds.has(focusedTrack.id))
                : false
            }
            isDirty={focusedTrack ? dirtyTrackIds.has(focusedTrack.id) : false}
            preserveWordTags={preserveWordTags}
            onPreserveWordTagsChange={setPreserveWordTags}
            onLyricsChange={handleLyricsChange}
            fetchProgress={
              focusedTrack ? fetchProgressMap.get(focusedTrack.id) : undefined
            }
            embedStatus={
              focusedTrack ? embedStatusMap.get(focusedTrack.id) : undefined
            }
            workerReady={Boolean(health?.ready)}
            loadedTrackId={loadedTrackId}
            playbackTimeMs={playbackTimeMs}
            onSeekToMs={(trackId, timeMs) =>
              setSeekRequest({ trackId, timeMs, nonce: Date.now() + Math.random() })
            }
            onFetchFocused={() => void handleFetchFocused()}
            onCancelFetchFocused={() => {
              if (focusedTrack) void window.api.lyricsCancelFetch(focusedTrack.id)
            }}
            onImportLrc={() => void handleImportLrc()}
            onSaveDraft={() => {
              if (focusedTrack) void handleSaveDraft(focusedTrack.id, focusedLyricsText)
            }}
            onDiscardDraft={() => {
              if (focusedTrack) void handleDiscardDraft(focusedTrack.id)
            }}
            onEmbedFocused={() => void handleEmbedFocused()}
            onNormalize={() => {
              if (focusedTrack) {
                handleLyricsChange(normalizeLrc(focusedLyricsText, { preserveWordTags }))
              }
            }}
            onPreviewTextChange={handlePreviewTextChange}
            mode={workspaceMode}
            onModeChange={setWorkspaceMode}
            editorLayout={editorLayout}
            searchTitle={searchTitle}
            onSearchTitleChange={setSearchTitle}
            searchArtist={searchArtist}
            onSearchArtistChange={setSearchArtist}
            searchAlbum={searchAlbum}
            onSearchAlbumChange={setSearchAlbum}
            searchDuration={searchDuration}
            onSearchDurationChange={setSearchDuration}
            searchResults={searchResults}
            searchLoading={searchLoading}
            searchError={searchError}
            searchSearched={searchSearched}
            onSearchCandidates={() => void handleSearchCandidates()}
            onLoadCandidate={(result) => void handleLoadCandidate(result)}
            secondaryLayerText={secondaryLayerText}
            onSecondaryLayerChange={setSecondaryLayerText}
            romanizationLayerText={romanizationLayerText}
            onRomanizationLayerChange={setRomanizationLayerText}
          />
          </div>
        </div>
      </main>

      <AudioPreviewPlayer
        focusedTrack={focusedTrack}
        activeLineTexts={activeLineTexts}
        seekRequest={seekRequest}
        playerCommand={playerCommand}
        health={health}
        onPlaybackChange={(nextLoadedId, nextTimeMs, nextPlaying) => {
          setLoadedTrackId(nextLoadedId)
          setPlaybackTimeMs(nextTimeMs)
          setIsPlaying(nextPlaying)
        }}
        onPlayerError={(message) => setBannerError(message)}
      />
    </div>
  )
}
