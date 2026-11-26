import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertCircle,
  Columns2,
  FileCode,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X
} from 'lucide-react'
import type {
  AiProviderPreset,
  AiProviderSettingsPublic,
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
import { normalizeLrc, parseLrc, stackLrcLayers } from '@shared/lrc'
import { findActiveLineIndices, hasSyncedTimestamps } from '@shared/lyricsSync'
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
import {
  clearLayers,
  createEmptyEditorState,
  createStateFromDraft,
  createStateFromFile,
  getDraftPayload,
  hasContent,
  hasSyncedPrimary,
  importLrc,
  loadAllLayers,
  loadPrimary,
  markSaveError,
  markSaved,
  normalizePrimary,
  revertToEmbedded,
  sendPrimaryToRomanization,
  sendPrimaryToTranslation,
  setAiRomanization,
  setAiTranslation,
  setPrimary,
  setRomanization,
  setRomanizationVisible,
  setTranslation,
  setTranslationVisible,
  startSave,
  type EditorState
} from '@shared/editorState'
import { AudioPreviewPlayer } from './components/AudioPreviewPlayer'
import { LibrarySidebar } from './components/LibrarySidebar'
import {
  LyricsEditorPanel,
  type AiJobState,
  type LyricsProviderFilter
} from './components/LyricsEditorPanel'
import { SettingsModal } from './components/SettingsModal'
import { TrackTable } from './components/TrackTable'
import type { PlayerCommand, SeekRequest, TrackEmbedStatus } from './types'

/** Debounce for draft auto-saves (primary + translation + romanization). */
const AUTO_SAVE_DEBOUNCE_MS = 500
/** How long transient info/success messages stay in the player dock. */
const STATUS_MESSAGE_TTL_MS = 4000

/** Human-readable provider name used in status messages. */
function providerDisplayName(providerId: LyricsSearchResult['providerId']): string {
  if (providerId === 'lrclib') return 'LRCLIB'
  if (providerId === 'netease') return 'NetEase'
  return 'the local .lrc sidecar'
}

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

/** Per-track editor state map. Keyed by trackId. */
type EditorStateMap = Map<string, EditorState>

function getOrCreateState(map: EditorStateMap, trackId: string, track: TrackRecord | null | undefined): EditorState {
  const existing = map.get(trackId)
  if (existing) return existing
  // Initialize from track's embedded lyrics if available, otherwise empty
  const initial = track?.lyrics ? createStateFromFile(trackId, track.lyrics) : createEmptyEditorState(trackId)
  return initial
}

/**
 * Merges the primary lyrics with every enabled, non-empty secondary layer so a
 * single embedded tag carries translation/romanization as same-timestamp lines.
 *
 * Module-level so `useMemo` consumers can list it without a new identity on
 * every render; `preserveWordTags` is passed explicitly for the same reason.
 */
function buildEmbedPayloadFromState(state: EditorState, preserveWordTags: boolean): string {
  const layers: string[] = []
  if (state.translation.visible && state.translation.text.trim().length > 0) {
    layers.push(state.translation.text)
  }
  if (state.romanization.visible && state.romanization.text.trim().length > 0) {
    layers.push(state.romanization.text)
  }
  if (layers.length === 0) return state.primary
  return stackLrcLayers([state.primary, ...layers], { preserveWordTags })
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
  /** Per-track editor state. Replaces draftTexts, secondaryLayerText, romanizationLayerText, etc. */
  const [editorStates, setEditorStates] = useState<EditorStateMap>(() => new Map())
  const [preserveWordTags, setPreserveWordTags] = useState(false)
  /** Live preview text emitted by the editor (primary or stacked layers). */
  const [livePreview, setLivePreview] = useState<{ trackId: string; text: string } | null>(null)

  const [searchTitle, setSearchTitle] = useState('')
  const [searchArtist, setSearchArtist] = useState('')
  const [searchAlbum, setSearchAlbum] = useState('')
  const [searchDuration, setSearchDuration] = useState('')
  const [searchResults, setSearchResults] = useState<LyricsSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchSearched, setSearchSearched] = useState(false)
  const [providerFilter, setProviderFilter] = useState<LyricsProviderFilter>('all')

  // --- Pass B: AI settings + opt-in AI layers ---
  const [aiSettings, setAiSettings] = useState<AiProviderSettingsPublic | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aiJob, setAiJob] = useState<AiJobState | null>(null)
  const aiJobIdRef = useRef<string | null>(null)

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
  const [editorLayout, setEditorLayout] = useState<EditorLayout>('live')

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
  /** Transient info/success message shown in the player dock's status slot. */
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  /** `saving` while a debounced auto-save is in flight, `saved` after it lands. */
  // Retained only as a hook slot: the per-track editor state now owns the
  // save indicator, but the setter still gates legacy status transitions.
  const [, setAutoSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const editorStatesRef = useRef(editorStates)
  editorStatesRef.current = editorStates
  /** Invalidates in-flight candidate searches when focus changes. */
  const searchNonceRef = useRef(0)
  /**
   * Holds the current `handleMenuAction` so the startup effect can subscribe to
   * native menu events exactly once. Without this the effect re-ran on every
   * render (re-issuing getHealth/getRoots/getTracks and re-subscribing IPC
   * listeners), which drove the render -> IPC -> menu rebuild loop.
   */
  const handleMenuActionRef = useRef<(action: MenuAction) => Promise<void>>(async () => undefined)

  /**
   * Tracks that have an on-disk draft. Derived from `tracks` (which carries the
   * authoritative `draftId` after every save and embed) rather than the
   * editor-state map: the map holds a state for every loaded track, so using its
   * keys would badge and filter every track with lyrics as a draft.
   */
  const draftTrackIds = useMemo(
    () => new Set(tracks.filter((track) => Boolean(track.draftId)).map((track) => track.id)),
    [tracks]
  )

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

  const focusedTrackId = focusedTrack?.id ?? null

  // Get editor state for the focused track
  const focusedEditorState = useMemo(() => {
    if (!focusedTrackId) return createEmptyEditorState()
    return getOrCreateState(editorStates, focusedTrackId, focusedTrack)
  }, [editorStates, focusedTrackId, focusedTrack])

  // Derived values for the focused track (used by LyricsEditorPanel)
  const focusedLyricsText = focusedEditorState.primary
  const secondaryLayerText = focusedEditorState.translation.text
  const romanizationLayerText = focusedEditorState.romanization.text
  const showTranslationLayer = focusedEditorState.translation.visible
  const showRomanizationLayer = focusedEditorState.romanization.visible
  // A draft exists on disk, or the editor holds unsaved edits for it.
  const focusedHasDraft = Boolean(focusedTrack?.draftId) || focusedEditorState.dirty
  const focusedIsDirty = focusedEditorState.dirty
  const focusedSaveState = focusedEditorState.saveState

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
    // Use editor state if available, otherwise fall back to track lyrics
    const loadedState = editorStates.get(loadedTrackId)
    if (loadedState && hasContent(loadedState)) {
      // Build stacked preview for loaded track
      return buildEmbedPayloadFromState(loadedState, preserveWordTags)
    }
    return loadedTrack?.lyrics ?? ''
  }, [loadedTrackId, focusedTrackId, livePreview, tracks, editorStates, preserveWordTags])

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
      hasDraft: focusedHasDraft,
      // Drafts auto-save, so the native menu never shows a "dirty" draft state.
      isDirty: focusedIsDirty,
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
    focusedHasDraft,
    focusedIsDirty,
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

  // Focusing a new track resets the transient status slot.
  useEffect(() => {
    setStatusMessage(null)
  }, [focusedTrackId])

  // Transient info/success messages clear themselves after 4 s.
  useEffect(() => {
    if (statusMessage === null) return
    const timer = setTimeout(() => setStatusMessage(null), STATUS_MESSAGE_TTL_MS)
    return () => clearTimeout(timer)
  }, [statusMessage])

  const applyFetchedCandidate = useCallback(
    async (trackId: string, candidate: LyricsCandidate): Promise<boolean> => {
      const text = candidate.syncedLyrics ?? candidate.plainLyrics
      if (!text) return false
      // NetEase (and any future multi-layer provider) ships translation and
      // romanization alongside the primary; persist them with the draft so a
      // batch fetch does not silently discard the extra layers.
      const translation = candidate.translatedLyrics ?? ''
      const romanization = candidate.romanizedLyrics ?? ''
      try {
        const draft = await window.api.saveDraft({
          trackId,
          lyrics: text,
          ...(translation.trim().length > 0 ? { translation } : {}),
          ...(romanization.trim().length > 0 ? { romanization } : {}),
          status: 'pending'
        })
        setEditorStates((prev) => {
          const next = new Map(prev)
          const track = tracksRef.current.find((t) => t.id === trackId)
          const baseState = track?.lyrics ? createStateFromFile(trackId, track.lyrics) : createEmptyEditorState(trackId)
          const loaded = loadPrimary(baseState, text)
          const withTranslation = translation.trim() ? setTranslation(loaded, translation) : loaded
          const withRomanization = romanization.trim() ? setRomanization(withTranslation, romanization) : withTranslation
          const withVis = romanization.trim()
            ? setRomanizationVisible(setTranslationVisible(withRomanization, translation.trim().length > 0), true)
            : setTranslationVisible(withRomanization, translation.trim().length > 0)
          next.set(trackId, markSaved(withVis))
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

  // AI generation progress: keeps the UI honest when a job is cancelled or fails
  // out-of-band (for example after `before-quit` aborts it).
  useEffect(() => {
    const unsubscribe = window.api.onLyricsAiProgress((progress) => {
      if (progress.phase === 'error' && progress.error) {
        setBannerError(progress.error)
      }
      if (progress.phase === 'cancelled') {
        setStatusMessage('AI generation cancelled.')
      }
    })
    return unsubscribe
  }, [])

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
        // Initialize editor states for tracks that have drafts
        const initialEditorStates = new Map<string, EditorState>()
        for (const track of initialTracks) {
          if (track.draftId) {
            const draft = await window.api.getDraft(track.id)
            if (draft) {
              initialEditorStates.set(track.id, createStateFromDraft(track.id, draft))
            } else if (track.lyrics) {
              initialEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
            }
          } else if (track.lyrics) {
            initialEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
          }
        }
        setEditorStates(initialEditorStates)
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
        // Refresh editor states for tracks with drafts
        const nextEditorStates = new Map(editorStatesRef.current)
        for (const track of nextTracks) {
          if (track.draftId) {
            const draft = await window.api.getDraft(track.id)
            if (draft) {
              nextEditorStates.set(track.id, createStateFromDraft(track.id, draft))
            }
          } else if (!nextEditorStates.has(track.id) && track.lyrics) {
            nextEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
          }
        }
        setEditorStates(nextEditorStates)
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

  /**
   * Restore the persisted draft (primary + translation + romanization) when the
   * focused track gains a draftId (e.g., after a batch fetch completes).
   * This effect runs when the track list changes and the focused track gets a draftId.
   */
  useEffect(() => {
    if (!focusedTrackId) return
    const track = tracksRef.current.find((t) => t.id === focusedTrackId)
    if (!track?.draftId) return
    // Check if we already have this draft loaded
    const currentState = editorStatesRef.current.get(focusedTrackId)
    if (currentState && hasContent(currentState)) return
    // Load the draft
    let cancelled = false
    void window.api
      .getDraft(focusedTrackId)
      .then((draft) => {
        if (cancelled || !draft) return
        setEditorStates((prev) => {
          const next = new Map(prev)
          next.set(focusedTrackId, createStateFromDraft(focusedTrackId, draft))
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [focusedTrackId, tracks])

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
        searchAlbum: searchAlbum.trim(),
        // A concrete pill narrows the request; `all` lets every provider answer.
        ...(providerFilter === 'all' ? {} : { providerIds: [providerFilter] })
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

  /** Loads AI provider settings (never contains the plaintext key). */
  const loadAiSettings = useCallback(async (): Promise<void> => {
    try {
      setAiSettings(await window.api.getAiSettings())
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void loadAiSettings()
  }, [loadAiSettings])

  async function handleSaveAiSettings(input: {
    preset: AiProviderPreset
    baseUrl: string
    model: string
    targetLanguage: string
    romanizationStyle: string
    apiKey?: string
  }): Promise<void> {
    const next = await window.api.saveAiSettings(input)
    setAiSettings(next)
    setStatusMessage('AI settings saved.')
  }

  async function handleClearAiKey(): Promise<void> {
    setAiSettings(await window.api.clearAiKey())
    setStatusMessage('AI API key cleared.')
  }

  /** True when the AI layer actions can run without further setup. */
  const aiConfigured = useMemo(() => {
    if (!aiSettings) return false
    const isLoopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(aiSettings.baseUrl)
    return aiSettings.hasApiKey || isLoopback
  }, [aiSettings])

  /**
   * Runs one opt-in AI generation and writes the result into the requested
   * secondary layer. The primary LRC is never touched.
   */
  async function handleAiGenerate(mode: 'translation' | 'romanization'): Promise<void> {
    if (!focusedTrack) return
    if (aiJob) return
    if (!aiConfigured) {
      setSettingsOpen(true)
      setBannerError(
        'AI layers are not configured yet. Add a base URL, model, and API key (or point at local Ollama) in Settings.'
      )
      return
    }
    if (!hasSyncedPrimary(focusedEditorState, hasSyncedTimestamps)) {
      setBannerError('AI layers need a primary LRC with [mm:ss.xx] timestamps.')
      return
    }

    setBannerError(null)
    const jobId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    aiJobIdRef.current = jobId
    setAiJob({ mode, jobId })
    setStatusMessage(mode === 'translation' ? 'AI translating…' : 'AI romanizing…')

    try {
      const result = await window.api.aiGenerateLyrics({
        jobId,
        trackId: focusedTrack.id,
        mode,
        lyrics: focusedEditorState.primary
      })
      if (aiJobIdRef.current !== jobId) return
      setEditorStates((prev) => {
        const next = new Map(prev)
        const state = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
        const updated = mode === 'translation'
          ? setAiTranslation(state, result.lyrics)
          : setAiRomanization(state, result.lyrics)
        next.set(focusedTrack!.id, markSaved(updated))
        return next
      })
      // Flush immediately so the generated layer is durable even if the user switches tracks right away.
      await flushAutoSave(focusedTrack.id)
      setStatusMessage(
        `${mode === 'translation' ? 'Translation' : 'Romanization'} ready (${result.lineCount} lines).`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/cancel|abort/i.test(message)) {
        setStatusMessage('AI generation cancelled.')
      } else {
        setBannerError(message)
      }
    } finally {
      if (aiJobIdRef.current === jobId) {
        aiJobIdRef.current = null
        setAiJob(null)
      }
    }
  }

  async function handleAiCancel(): Promise<void> {
    const jobId = aiJobIdRef.current
    if (!jobId) return
    try {
      await window.api.aiCancelGenerate(jobId)
    } catch {
      // Cancellation is best-effort; the job will settle on its own.
    }
  }

  /**
   * Loads a candidate's primary lyrics *and* every bundled layer (NetEase ships
   * translation/romanization alongside its LRC) in one action.
   */
  async function handleLoadAllLayers(result: LyricsSearchResult): Promise<void> {
    if (!focusedTrack) return
    const text = result.syncedLyrics ?? result.plainLyrics
    if (!text) return
    setBannerError(null)
    try {
      const translation = result.translatedLyrics ?? ''
      const romanization = result.romanizedLyrics ?? ''
      const draft = await window.api.saveDraft({
        trackId: focusedTrack.id,
        lyrics: text,
        translation,
        romanization,
        status: 'pending'
      })
      setEditorStates((prev) => {
        const next = new Map(prev)
        const baseState = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
        const loaded = loadAllLayers(baseState, text, translation, romanization)
        next.set(focusedTrack!.id, markSaved(loaded))
        return next
      })
      setTracks((prev) =>
        prev.map((track) =>
          track.id === focusedTrack!.id ? { ...track, draftId: draft.id } : track
        )
      )
      const layers = [
        translation.trim().length > 0 ? 'translation' : null,
        romanization.trim().length > 0 ? 'romanization' : null
      ].filter(Boolean)
      setStatusMessage(
        layers.length > 0
          ? `Loaded primary + ${layers.join(' + ')} from ${providerDisplayName(result.providerId)}.`
          : `Loaded ${providerDisplayName(result.providerId)} lyrics as the primary.`
      )
      await flushAutoSave(focusedTrack.id)
      setWorkspaceMode('edit')
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleLoadCandidate(result: LyricsSearchResult) {
    if (!focusedTrack) return
    const text = result.syncedLyrics ?? result.plainLyrics
    if (!text) return
    setBannerError(null)
    const applied = await applyFetchedCandidate(focusedTrack.id, result)
    if (applied) {
      // Loading a candidate persists it as the draft, then returns to editing.
      await flushAutoSave(focusedTrack.id)
      setStatusMessage(
        `Loaded ${result.providerId === 'lrclib' ? 'LRCLIB' : 'local .lrc'} candidate as the primary lyrics.`
      )
      setWorkspaceMode('edit')
    }
  }

  /**
   * Opening Find with no results yet kicks off the candidate search once, so the
   * mode is never an empty panel waiting on a click.
   */
  useEffect(() => {
    if (workspaceMode !== 'find') return
    if (searchSearched || searchLoading) return
    if (!focusedTrackId) return
    void handleSearchCandidates()
    // Only re-run when the mode or the search bookkeeping changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceMode, searchSearched, searchLoading, focusedTrackId])

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
      setStatusMessage(`Added root "${added.name}". Scanning...`)
      setScanning(true)
      await window.api.scanLibrary({ rootId: added.id })
      setStatusMessage(`Scanned "${added.name}".`)
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
      // Refresh editor states
      const nextEditorStates = new Map(editorStatesRef.current)
      for (const track of nextTracks) {
        if (!nextEditorStates.has(track.id) && track.lyrics) {
          nextEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
        }
      }
      setEditorStates(nextEditorStates)
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleScan(rootId?: string) {
    setBannerError(null)
    setStatusMessage(null)
    setScanning(true)
    try {
      const result = await window.api.scanLibrary(rootId ? { rootId } : undefined)
      const [nextRoots, nextTracks] = await Promise.all([
        window.api.getRoots(),
        window.api.getTracks()
      ])
      setRoots(nextRoots)
      setTracks(nextTracks)
      // Refresh editor states
      const nextEditorStates = new Map(editorStatesRef.current)
      for (const track of nextTracks) {
        if (!nextEditorStates.has(track.id) && track.lyrics) {
          nextEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
        }
      }
      setEditorStates(nextEditorStates)
      setSelection((prev) =>
        reconcileSelection(
          prev,
          nextTracks.map((t) => t.id)
        )
      )
      setStatusMessage(`Scan complete (${result.tracks.length} tracks indexed).`)
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    } finally {
      setScanning(false)
    }
  }

  function handleRowClick(trackId: string, modifiers: SelectionClickModifiers) {
    // Focusing a different track must not lose the pending draft write.
    if (trackId !== focusedTrackId) {
      void flushAutoSave(focusedTrackId)
    }
    setSelection((prev) => applyTrackClick(prev, visibleTrackIds, trackId, modifiers))
  }

  function handleLyricsChange(nextLyrics: string) {
    if (!focusedTrack) return
    setEditorStates((prev) => {
      const next = new Map(prev)
      const state = next.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      next.set(focusedTrack.id, setPrimary(state, nextLyrics))
      return next
    })
  }

  function handleSecondaryLayerChange(next: string) {
    if (!focusedTrack) return
    setEditorStates((prev) => {
      const nextMap = new Map(prev)
      const state = nextMap.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      nextMap.set(focusedTrack.id, setTranslation(state, next))
      return nextMap
    })
  }

  function handleRomanizationLayerChange(next: string) {
    if (!focusedTrack) return
    setEditorStates((prev) => {
      const nextMap = new Map(prev)
      const state = nextMap.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      nextMap.set(focusedTrack.id, setRomanization(state, next))
      return nextMap
    })
  }

  function handleTranslationVisibilityChange(visible: boolean) {
    if (!focusedTrack) return
    setEditorStates((prev) => {
      const next = new Map(prev)
      const state = next.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      next.set(focusedTrack.id, setTranslationVisible(state, visible))
      return next
    })
  }

  function handleRomanizationVisibilityChange(visible: boolean) {
    if (!focusedTrack) return
    setEditorStates((prev) => {
      const next = new Map(prev)
      const state = next.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      next.set(focusedTrack.id, setRomanizationVisible(state, visible))
      return next
    })
  }

  /**
   * Writes the focused track's primary + layer texts as a draft.
   * Returns true when a draft exists on disk afterwards.
   */
  async function persistDraftNow(trackId: string): Promise<boolean> {
    const state = editorStatesRef.current.get(trackId)
    if (!state) return false
    // Persist when the state is dirty even if it is now empty: clearing the
    // primary is a real edit, and skipping it lets stale text reappear from the
    // old draft on the next load (bug 8). Non-dirty states only persist when
    // they still carry content.
    if (!state.dirty && !hasContent(state)) return false

    const payload = getDraftPayload(state)

    setEditorStates((prev) => {
      const next = new Map(prev)
      const current = next.get(trackId)
      if (current) next.set(trackId, startSave(current))
      return next
    })

    try {
      const draft = await window.api.saveDraft({
        trackId,
        lyrics: payload.lyrics,
        ...(payload.translation ? { translation: payload.translation } : {}),
        ...(payload.romanization ? { romanization: payload.romanization } : {}),
        status: 'pending'
      })
      setEditorStates((prev) => {
        const next = new Map(prev)
        const current = next.get(trackId)
        if (current) next.set(trackId, markSaved(current))
        return next
      })
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, draftId: draft.id } : t))
      )
      if (trackId === focusedTrackId) {
        setAutoSaveState('saved')
      }
      return true
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
      setEditorStates((prev) => {
        const next = new Map(prev)
        const current = next.get(trackId)
        if (current) next.set(trackId, markSaveError(current))
        return next
      })
      if (trackId === focusedTrackId) setAutoSaveState('idle')
      return false
    }
  }

  /** Runs any pending debounced save immediately (before switching/embedding). */
  async function flushAutoSave(trackId?: string | null): Promise<void> {
    const target = trackId ?? focusedTrackId
    if (!target) return
    const state = editorStatesRef.current.get(target)
    if (!state || !state.dirty) return
    await persistDraftNow(target)
  }

  /** Debounced auto-save effect for the focused track. */
  useEffect(() => {
    if (!focusedTrackId) return
    const state = editorStatesRef.current.get(focusedTrackId)
    if (!state || !state.dirty) return
    // Only auto-save if primary has content (bug 8: clearing primary should not block save)
    // Actually, we DO want to save when primary is cleared - that's a user edit.
    // The guard in the old code was `if (dirtyLyrics.trim().length === 0) return` which prevented saving empty primary.
    // New behavior: always save when dirty, regardless of content.

    const timer = setTimeout(() => {
      void persistDraftNow(focusedTrackId)
    }, AUTO_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [focusedTrackId, focusedEditorState.dirty])

  /** Revert to the lyrics embedded in the file, clearing every layer. */
  async function handleRevertToEmbedded(trackId: string) {
    setBannerError(null)
    try {
      await window.api.deleteDraft(trackId)
      const original = tracksRef.current.find((t) => t.id === trackId)?.lyrics ?? ''
      setEditorStates((prev) => {
        const next = new Map(prev)
        const current = next.get(trackId) ?? createEmptyEditorState(trackId)
        next.set(trackId, revertToEmbedded(current, original))
        return next
      })
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, draftId: undefined } : t))
      )
      if (trackId === focusedTrackId) {
        setAutoSaveState('idle')
        setStatusMessage('Reverted to the lyrics embedded in the file.')
      }
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
      setEditorStates((prev) => {
        const next = new Map(prev)
        const state = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
        next.set(focusedTrack!.id, importLrc(state, content))
        return next
      })
      await flushAutoSave(focusedTrack.id)
      setStatusMessage(`Imported ${selected}`)
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleFetchSelected() {
    const targets = filteredTracks.filter((track) => selection.selectedIds.has(track.id))
    if (targets.length === 0) return
    setBannerError(null)
    setStatusMessage(`Fetching lyrics for ${targets.length} track(s)...`)
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
      // The main process re-opens the staged file and sets `verified`. If the
      // read-back did not verify, treat the whole embed as failed so the draft
      // and every layer are preserved (never delete a draft on an unverified write).
      if (!result.verified) {
        setEmbedStatusMap((prev) => {
          const next = new Map(prev)
          next.set(track.id, { phase: 'error', error: 'Embed did not verify cleanly.' })
          return next
        })
        return false
      }
      const refreshed = await window.api.getTrack(track.id)
      // Only now, after a verified write, drop the draft.
      await window.api.deleteDraft(track.id)

      // Update editor state: primary = what was read back from file, layers cleared
      setEditorStates((prev) => {
        const next = new Map(prev)
        const embeddedLyrics = refreshed?.lyrics ?? payload
        next.set(track.id, clearLayers(createStateFromFile(track.id, embeddedLyrics)))
        return next
      })
      setTracks((prev) =>
        prev.map((t) =>
          t.id === track.id ? { ...(refreshed ?? t), draftId: undefined } : t
        )
      )
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
      // On embed failure, preserve all layers and draft (state unchanged)
      return false
    }
  }

  async function handleEmbedFocused() {
    if (!focusedTrack || embedding) return
    setEmbedding(true)
    setBannerError(null)
    setStatusMessage(null)
    try {
      // Never embed ahead of an in-flight edit.
      await flushAutoSave(focusedTrack.id)
      const state = editorStatesRef.current.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      const payload = buildEmbedPayloadFromState(state, preserveWordTags)
      const ok = await embedSingleTrack(focusedTrack, payload)
      if (ok) {
        setStatusMessage(`Embedded lyrics for "${focusedTrack.title}".`)
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
        // Always flush auto-save for the focused track before embedding.
        if (track.id === focusedTrackId) {
          await flushAutoSave(track.id)
        }

        // Resolve the authoritative editor state for this track.
        // - Focused track: memory is authoritative (auto-saved above).
        // - Non-focused track with an on-disk draft: read the draft so its
        //   translation/romanization layers are merged even when the primary
        //   text is already cached in memory (bug 7: cached primary used to
        //   shadow the saved layers, which were then lost when the draft was
        //   deleted after embed).
        // - Otherwise: use whatever editor state exists, else the file lyrics.
        let state = editorStatesRef.current.get(track.id) ?? null
        if (track.id !== focusedTrackId && (!state || !state.dirty)) {
          if (track.draftId) {
            try {
              const draft = await window.api.getDraft(track.id)
              if (draft) state = createStateFromDraft(track.id, draft)
            } catch {
              // Fall back to memory / file lyrics if the draft cannot be read.
            }
          }
        }

        let payload: string
        if (state && hasContent(state)) {
          payload = buildEmbedPayloadFromState(state, preserveWordTags)
        } else if (track.lyrics) {
          payload = track.lyrics
        } else {
          continue
        }
        const ok = await embedSingleTrack(track, payload)
        if (ok) succeeded++
        else failed++
      }
      setStatusMessage(
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
      case 'discard-draft':
        if (focusedTrack) await handleRevertToEmbedded(focusedTrack.id)
        break
      case 'embed-current-track':
        if (focusedTrack && !embedding) await handleEmbedFocused()
        break
      case 'open-settings':
        setSettingsOpen(true)
        break
      case 'ai-translate':
        await handleAiGenerate('translation')
        break
      case 'ai-romanize':
        await handleAiGenerate('romanization')
        break
      case 'normalize-lrc':
        if (focusedTrack) {
          setEditorStates((prev) => {
            const next = new Map(prev)
            const state = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
            next.set(focusedTrack!.id, normalizePrimary(state, (t) => normalizeLrc(t, { preserveWordTags })))
            return next
          })
        }
        break
      case 'toggle-preserve-word-tags':
        setPreserveWordTags((prev) => !prev)
        break
      case 'send-primary-to-translation':
        if (focusedTrack) {
          setEditorStates((prev) => {
            const next = new Map(prev)
            const state = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
            next.set(focusedTrack!.id, sendPrimaryToTranslation(state))
            return next
          })
          setWorkspaceMode('layers')
        }
        break
      case 'send-primary-to-romanization':
        if (focusedTrack) {
          setEditorStates((prev) => {
            const next = new Map(prev)
            const state = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
            next.set(focusedTrack!.id, sendPrimaryToRomanization(state))
            return next
          })
          setWorkspaceMode('layers')
        }
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
      case 'layout-live':
        setEditorLayout('live')
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

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      {/*
        Errors stay in normal flex flow above <main> so they can never cover the
        editor; info/success messages live in the player dock's status slot.
      */}
      {bannerError && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-red-900/80 bg-red-950/60 px-4 py-1.5 text-xs text-red-200"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
            <span className="truncate">{bannerError}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setBannerError(null)}
            className="shrink-0 text-zinc-400 hover:text-zinc-100"
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
              draftTrackIds={new Set(editorStates.keys())}
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
                aria-pressed={editorLayout === 'live'}
                title="Live editor: editable synced rows with inline translation/romanization"
                onClick={() => setEditorLayout('live')}
                className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium ${
                  editorLayout === 'live'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <Columns2 className="h-3.5 w-3.5" />
                Live
              </button>
              <button
                type="button"
                aria-pressed={editorLayout === 'raw'}
                title="Raw LRC text: single monospace editor"
                onClick={() => setEditorLayout('raw')}
                className={`inline-flex items-center gap-1 border-l border-zinc-700 px-2 py-1 text-[11px] font-medium ${
                  editorLayout === 'raw'
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <FileCode className="h-3.5 w-3.5" />
                Raw Text
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
          <LyricsEditorPanel
            focusedTrack={focusedTrack}
            selectedCount={selection.selectedIds.size}
            lyricsText={focusedLyricsText}
            hasDraft={focusedHasDraft}
            autoSaveState={focusedSaveState}
            onEditorLayoutChange={setEditorLayout}
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
            onImportLrc={() => void handleImportLrc()}
            onRevert={() => {
              if (focusedTrack) void handleRevertToEmbedded(focusedTrack.id)
            }}
            onEmbedFocused={() => void handleEmbedFocused()}
            onNormalize={() => {
              if (focusedTrack) {
                setEditorStates((prev) => {
                  const next = new Map(prev)
                  const state = next.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id)
                  next.set(focusedTrack!.id, normalizePrimary(state, (t) => normalizeLrc(t, { preserveWordTags })))
                  return next
                })
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
            onLoadAllLayers={(result) => void handleLoadAllLayers(result)}
            providerFilter={providerFilter}
            onProviderFilterChange={setProviderFilter}
            onOpenSettings={() => setSettingsOpen(true)}
            aiJob={aiJob}
            onAiGenerate={(mode) => void handleAiGenerate(mode)}
            onAiCancel={() => void handleAiCancel()}
            aiConfigured={aiConfigured}
            secondaryLayerText={secondaryLayerText}
            onSecondaryLayerChange={handleSecondaryLayerChange}
            romanizationLayerText={romanizationLayerText}
            onRomanizationLayerChange={handleRomanizationLayerChange}
            showTranslationLayer={showTranslationLayer}
            onShowTranslationLayerChange={handleTranslationVisibilityChange}
            showRomanizationLayer={showRomanizationLayer}
            onShowRomanizationLayerChange={handleRomanizationVisibilityChange}
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
        statusMessage={statusMessage}
        onPlaybackChange={(loadedTrackId, timeMs, isPlaying) => {
          setLoadedTrackId(loadedTrackId)
          setPlaybackTimeMs(timeMs)
          setIsPlaying(isPlaying)
        }}
        onPlayerError={(message) => setBannerError(message)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveAiSettings}
        onClearKey={handleClearAiKey}
        settings={aiSettings}
      />
    </div>
  )
}