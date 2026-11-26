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
  /** Sticky draft ids for tracks whose layers were loaded from disk. */
  const [layerDraftTrackIds, setLayerDraftTrackIds] = useState<Set<string>>(() => new Set())
  const [preserveWordTags, setPreserveWordTags] = useState(false)
  /** Live preview text emitted by the editor (primary or stacked layers). */
  const [livePreview, setLivePreview] = useState<{ trackId: string; text: string } | null>(null)
  /** Translation + romanization layers lifted so native menu actions can drive them. */
  const [secondaryLayerText, setSecondaryLayerText] = useState('')
  const [romanizationLayerText, setRomanizationLayerText] = useState('')
  /**
   * Layer visibility toggles. They control what the live preview shows *and*
   * which layers get stacked into an embed, but never touch the primary text.
   */
  const [showTranslationLayer, setShowTranslationLayer] = useState(true)
  const [showRomanizationLayer, setShowRomanizationLayer] = useState(true)

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
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const draftTextsRef = useRef(draftTexts)
  draftTextsRef.current = draftTexts
  /** Latest layer texts, read synchronously by flush/embed helpers. */
  const layerTextsRef = useRef({ translation: '', romanization: '' })
  layerTextsRef.current = { translation: secondaryLayerText, romanization: romanizationLayerText }
  /** Draft id known to exist on disk for the focused track (sticky per track). */
  const knownDraftIdRef = useRef<string | null>(null)
  const focusedTrackIdRef = useRef<string | null>(null)
  const currentSignatureRef = useRef('')
  const lastSavedSignatureRef = useRef<string | null>(null)
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

  /** Draft id for the focused track, sticky while its layers are on screen. */
  const focusedDraftId = useMemo(() => {
    if (!focusedTrack) return null
    return focusedTrack.draftId ?? (layerDraftTrackIds.has(focusedTrack.id) ? focusedTrack.id : null)
  }, [focusedTrack, layerDraftTrackIds])

  /**
   * Unsaved-change tracking for the auto-save indicator. `dirtyLyrics` mirrors
   * the edited primary text; `layerEpoch` bumps on every layer edit (including
   * swaps that leave the text unchanged).
   */
  const dirtyLyrics = focusedTrack ? focusedLyricsText : ''
  const [layerEpoch, setLayerEpoch] = useState(0)
  const [lastSavedSignature, setLastSavedSignature] = useState<string | null>(null)
  const currentSignature =
    focusedTrackId === null
      ? ''
      : `${focusedTrackId}\u0000${dirtyLyrics}\u0000${layerEpoch}`

  // Mirror async-read values into refs so debounced saves and flushes always see
  // the latest focused track / signature without re-created closures.
  focusedTrackIdRef.current = focusedTrackId
  currentSignatureRef.current = currentSignature
  lastSavedSignatureRef.current = lastSavedSignature

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
      hasDraft: focusedDraftId !== null,
      // Drafts auto-save, so the native menu never shows a "dirty" draft state.
      isDirty: false,
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
    focusedDraftId,
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
        setLayerDraftTrackIds((prev) => {
          const next = new Set(prev)
          next.add(trackId)
          return next
        })
        if (trackId === focusedTrackIdRef.current) {
          if (translation.trim().length > 0) {
            setSecondaryLayerText(translation)
            setShowTranslationLayer(true)
          }
          if (romanization.trim().length > 0) {
            setRomanizationLayerText(romanization)
            setShowRomanizationLayer(true)
          }
          if (translation.trim().length > 0 || romanization.trim().length > 0) {
            setLayerEpoch((prev) => prev + 1)
          }
          setLastSavedSignature(currentSignatureRef.current)
          setAutoSaveState('saved')
        }
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

  /**
   * Restore the persisted draft (primary + translation + romanization) when the
   * focused track has one on disk. Switching tracks therefore never drops the
   * translation/romanization layers.
   */
  useEffect(() => {
    setStatusMessage((prev) => (prev === null ? prev : null))
    setAutoSaveState('idle')
    setLastSavedSignature(null)
    if (!focusedTrackId) {
      knownDraftIdRef.current = null
      return
    }
    const track = tracksRef.current.find((candidate) => candidate.id === focusedTrackId)
    if (!track?.draftId) {
      knownDraftIdRef.current = null
      return
    }
    knownDraftIdRef.current = track.draftId

    let cancelled = false
    void window.api
      .getDraft(focusedTrackId)
      .then((draft) => {
        if (cancelled || !draft) return
        setDraftTexts((prev) => {
          const next = new Map(prev)
          next.set(focusedTrackId, draft.lyrics)
          return next
        })
        setSecondaryLayerText(draft.translation ?? '')
        setRomanizationLayerText(draft.romanization ?? '')
        setLayerDraftTrackIds((prev) => {
          const next = new Set(prev)
          next.add(focusedTrackId)
          return next
        })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [focusedTrackId])

  /**
   * Debounced auto-save (500 ms). Drafts are never saved by hand: any edit to the
   * primary text, translation, or romanization schedules a write for the focused
   * track. `flushAutoSave` runs the pending write immediately before switching
   * tracks or embedding.
   */
  useEffect(() => {
    if (!focusedTrackId) return
    if (currentSignature === lastSavedSignature) return
    const track = tracksRef.current.find((candidate) => candidate.id === focusedTrackId)
    if (!track) return
    if (dirtyLyrics.trim().length === 0) return

    const timer = setTimeout(() => {
      void persistDraftNow(focusedTrackId)
    }, AUTO_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `currentSignature` captures track + primary text + layer epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSignature, lastSavedSignature, focusedTrackId])

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
    if (!hasSyncedTimestamps(focusedLyricsText)) {
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
        lyrics: focusedLyricsText
      })
      if (aiJobIdRef.current !== jobId) return
      if (mode === 'translation') {
        handleSecondaryLayerChange(result.lyrics)
        setShowTranslationLayer(true)
      } else {
        handleRomanizationLayerChange(result.lyrics)
        setShowRomanizationLayer(true)
      }
      // Layer edits bump the auto-save signature, but flush immediately so the
      // generated layer is durable even if the user switches tracks right away.
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
      setDraftTexts((prev) => {
        const next = new Map(prev)
        next.set(focusedTrack.id, text)
        return next
      })
      setSecondaryLayerText(translation)
      setRomanizationLayerText(romanization)
      setShowTranslationLayer(translation.trim().length > 0)
      setShowRomanizationLayer(romanization.trim().length > 0)
      setLayerEpoch((prev) => prev + 1)
      setDraftTrackIds((prev) => new Set(prev).add(focusedTrack.id))
      setLayerDraftTrackIds((prev) => new Set(prev).add(focusedTrack.id))
      setTracks((prev) =>
        prev.map((track) =>
          track.id === focusedTrack.id ? { ...track, draftId: draft.id } : track
        )
      )
      setLastSavedSignature(null)
      setAutoSaveState('saved')
      const layers = [
        translation.trim().length > 0 ? 'translation' : null,
        romanization.trim().length > 0 ? 'romanization' : null
      ].filter(Boolean)
      setStatusMessage(
        layers.length > 0
          ? `Loaded primary + ${layers.join(' + ')} from ${providerDisplayName(result.providerId)}.`
          : `Loaded ${providerDisplayName(result.providerId)} lyrics as the primary.`
      )
      await persistDraftNow(focusedTrack.id)
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
      await persistDraftNow(focusedTrack.id)
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
      setDraftTrackIds(
        new Set(nextTracks.filter((t) => Boolean(t.draftId)).map((t) => t.id))
      )
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
      setDraftTrackIds(
        new Set(nextTracks.filter((t) => Boolean(t.draftId)).map((t) => t.id))
      )
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
    if (trackId !== focusedTrackIdRef.current) {
      void flushAutoSave(focusedTrackIdRef.current)
    }
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
  }

  function handleSecondaryLayerChange(next: string) {
    setSecondaryLayerText(next)
    setLayerEpoch((prev) => prev + 1)
  }

  function handleRomanizationLayerChange(next: string) {
    setRomanizationLayerText(next)
    setLayerEpoch((prev) => prev + 1)
  }

  /**
   * Writes the focused track's primary + layer texts as a draft.
   * Returns true when a draft exists on disk afterwards.
   */
  async function persistDraftNow(trackId: string): Promise<boolean> {
    const lyricsOverride = draftTextsRef.current.get(trackId)
    const track = tracksRef.current.find((candidate) => candidate.id === trackId)
    const lyrics = lyricsOverride ?? track?.lyrics ?? ''
    if (lyrics.trim().length === 0) return false

    const { translation, romanization } =
      trackId === focusedTrackIdRef.current
        ? layerTextsRef.current
        : { translation: '', romanization: '' }

    setAutoSaveState('saving')
    try {
      const draft = await window.api.saveDraft({
        trackId,
        lyrics,
        translation,
        romanization,
        status: 'pending'
      })
      knownDraftIdRef.current = draft.id
      setDraftTrackIds((prev) => {
        const next = new Set(prev)
        next.add(trackId)
        return next
      })
      setLayerDraftTrackIds((prev) => {
        const next = new Set(prev)
        next.add(trackId)
        return next
      })
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, draftId: draft.id } : t))
      )
      if (trackId === focusedTrackIdRef.current) {
        setLastSavedSignature(currentSignatureRef.current)
        setAutoSaveState('saved')
      }
      return true
    } catch (error) {
      setBannerError(error instanceof Error ? error.message : String(error))
      if (trackId === focusedTrackIdRef.current) setAutoSaveState('idle')
      return false
    }
  }

  /** Runs any pending debounced save immediately (before switching/embedding). */
  async function flushAutoSave(trackId?: string | null): Promise<void> {
    const target = trackId ?? focusedTrackIdRef.current
    if (!target) return
    if (currentSignatureRef.current === lastSavedSignatureRef.current) return
    await persistDraftNow(target)
  }

  /** Revert to the lyrics embedded in the file, clearing every layer. */
  async function handleRevertToEmbedded(trackId: string) {
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
      setLayerDraftTrackIds((prev) => {
        const next = new Set(prev)
        next.delete(trackId)
        return next
      })
      if (trackId === focusedTrackIdRef.current) {
        knownDraftIdRef.current = null
        setSecondaryLayerText('')
        setRomanizationLayerText('')
        setLayerEpoch((prev) => prev + 1)
        setLastSavedSignature(null)
        setAutoSaveState('idle')
        setStatusMessage('Reverted to the lyrics embedded in the file.')
      }
      setTracks((prev) =>
        prev.map((t) => (t.id === trackId ? { ...t, draftId: undefined } : t))
      )
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
      setDraftTexts((prev) => {
        const next = new Map(prev)
        next.set(focusedTrack.id, content)
        return next
      })
      setLayerEpoch((prev) => prev + 1)
      await persistDraftNow(focusedTrack.id)
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

  /**
   * Merges the primary lyrics with every enabled, non-empty secondary layer so a
   * single embedded tag carries translation/romanization as same-timestamp lines.
   */
  function buildEmbedPayload(
    primary: string,
    translation: string,
    romanization: string,
    translateEnabled: boolean,
    romanizeEnabled: boolean
  ): string {
    const layers: string[] = []
    if (translateEnabled && translation.trim().length > 0) layers.push(translation)
    if (romanizeEnabled && romanization.trim().length > 0) layers.push(romanization)
    if (layers.length === 0) return primary
    return stackLrcLayers([primary, ...layers], { preserveWordTags })
  }

  async function handleEmbedFocused() {
    if (!focusedTrack || embedding) return
    setEmbedding(true)
    setBannerError(null)
    setStatusMessage(null)
    try {
      // Never embed ahead of an in-flight edit.
      await flushAutoSave(focusedTrack.id)
      const payload = buildEmbedPayload(
        focusedLyricsText,
        secondaryLayerText,
        romanizationLayerText,
        showTranslationLayer,
        showRomanizationLayer
      )
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
        let payload = draftTextsRef.current.get(track.id)
        let translation = ''
        let romanization = ''
        if (track.id === focusedTrackIdRef.current) {
          // The focused track has live (possibly unsaved) layer text.
          await flushAutoSave(track.id)
          translation = layerTextsRef.current.translation
          romanization = layerTextsRef.current.romanization
        }
        if (payload === undefined && track.draftId) {
          const draft = await window.api.getDraft(track.id)
          payload = draft?.lyrics
          translation = draft?.translation ?? ''
          romanization = draft?.romanization ?? ''
        }
        if (payload === undefined) {
          payload = track.lyrics ?? ''
        }
        if (payload.length === 0 && track.lyrics === null) {
          continue
        }
        const merged = buildEmbedPayload(
          payload,
          translation,
          romanization,
          translation.trim().length > 0,
          romanization.trim().length > 0
        )
        const ok = await embedSingleTrack(track, merged)
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
            hasDraft={
              focusedTrack
                ? Boolean(focusedTrack.draftId || draftTrackIds.has(focusedTrack.id))
                : false
            }
            autoSaveState={autoSaveState}
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
            onShowTranslationLayerChange={setShowTranslationLayer}
            showRomanizationLayer={showRomanizationLayer}
            onShowRomanizationLayerChange={setShowRomanizationLayer}
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
        onPlaybackChange={(nextLoadedId, nextTimeMs, nextPlaying) => {
          setLoadedTrackId(nextLoadedId)
          setPlaybackTimeMs(nextTimeMs)
          setIsPlaying(nextPlaying)
        }}
        onPlayerError={(message) => setBannerError(message)}
      />

      {/* AI provider settings (File > Settings… / Ctrl+, / gear in Find + Layers) */}
      <SettingsModal
        open={settingsOpen}
        settings={aiSettings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveAiSettings}
        onClearKey={handleClearAiKey}
      />
    </div>
  )
}
