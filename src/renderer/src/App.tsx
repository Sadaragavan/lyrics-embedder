import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  X
} from 'lucide-react'
import type {
  AiProviderPreset,
  AiProviderSettingsPublic,
  LibraryRoot,
  LyricsFetchProgress,
  LyricsFetchRequest,
  LyricsSearchResult,
  MenuAction,
  ScanProgress,
  TagEngineHealth,
  TrackRecord
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
  hasContent,
  type EditorState
} from '@shared/editorState'
import { AudioPreviewPlayer } from './components/AudioPreviewPlayer'
import { LibrarySidebar } from './components/LibrarySidebar/LibrarySidebar'
import { RightPanel } from './components/RightPanel/RightPanel'
import { SettingsModal } from './components/SettingsModal'
import { TopBar } from './components/TopBar'
import type { PlayerCommand, SeekRequest, TrackEmbedStatus } from './types'
import { useEditorState } from './hooks/useEditorState'
import { useDraftPersistence } from './hooks/useDraftPersistence'
import { useLyricsSearch } from './hooks/useLyricsSearch'
import { useAiGeneration } from './hooks/useAiGeneration'
import { useSidebarState } from './hooks/useSidebarState'
import { useMenuSync } from './hooks/useMenuSync'
import { useVirtualTracks } from './hooks/useVirtualTracks'

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

/**
 * Merges the primary lyrics with every enabled, non-empty secondary layer so a
 * single embedded tag carries translation/romanization as same-timestamp lines.
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

  // Editor state management
  const { editorStates, setEditorStates } = useEditorState()

  const [preserveWordTags, setPreserveWordTags] = useState(false)
  const [livePreview, setLivePreview] = useState<{ trackId: string; text: string } | null>(null)

  // Search state (moved to hook but keeping refs for compatibility)
  const [searchTitle, setSearchTitle] = useState('')
  const [searchArtist, setSearchArtist] = useState('')
  const [searchAlbum, setSearchAlbum] = useState('')
  const [searchDuration, setSearchDuration] = useState('')
  const [searchResults, setSearchResults] = useState<LyricsSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchSearched, setSearchSearched] = useState(false)

  // AI settings
  const [aiSettings, setAiSettings] = useState<AiProviderSettingsPublic | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [fetchProgressMap, setFetchProgressMap] = useState<Map<string, LyricsFetchProgress>>(() => new Map())
  const [embedStatusMap, setEmbedStatusMap] = useState<Map<string, TrackEmbedStatus>>(() => new Map())
  const [embedding, setEmbedding] = useState(false)

  // Workspace state
  const [workspaceMode, setWorkspaceMode] = useState<'lyrics' | 'text' | 'find'>('lyrics')

  // Player state
  const [loadedTrackId, setLoadedTrackId] = useState<string | null>(null)
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)
  const [playerCommand, setPlayerCommand] = useState<PlayerCommand | null>(null)

  const [bannerError, setBannerError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  // Derived: filtered tracks
  const filteredTracks = useMemo(
    () => filterTracks(tracks, { search, status: statusFilter, rootId: activeRootFilter || undefined }),
    [tracks, search, statusFilter, activeRootFilter]
  )

  const visibleTrackIds = useMemo(() => filteredTracks.map((t) => t.id), [filteredTracks])

  const focusedTrack = useMemo(() => tracks.find((t) => t.id === selection.focusedId) ?? null, [tracks, selection.focusedId])
  const focusedTrackId = focusedTrack?.id ?? null

  // Get editor state for focused track
  const focusedEditorState = useMemo(() => {
    if (!focusedTrackId) return createEmptyEditorState()
    const existing = editorStates.get(focusedTrackId)
    if (existing) return existing
    return focusedTrack?.lyrics ? createStateFromFile(focusedTrackId, focusedTrack.lyrics) : createEmptyEditorState(focusedTrackId)
  }, [editorStates, focusedTrackId, focusedTrack])

  // Derived values for focused track
  const focusedLyricsText = focusedEditorState.primary
  const showTranslationLayer = focusedEditorState.translation.visible
  const showRomanizationLayer = focusedEditorState.romanization.visible
  const focusedHasDraft = Boolean(focusedTrack?.draftId) || focusedEditorState.dirty
  const focusedIsDirty = focusedEditorState.dirty

  // Loaded track lyrics for player
  const loadedTrackLyricsText = useMemo(() => {
    if (!loadedTrackId) return ''
    const useLivePreview = focusedTrackId === loadedTrackId && livePreview !== null && livePreview.trackId === loadedTrackId
    if (useLivePreview) return livePreview.text
    const loadedTrack = tracks.find((t) => t.id === loadedTrackId)
    const loadedState = editorStates.get(loadedTrackId)
    if (loadedState && hasContent(loadedState)) {
      return buildEmbedPayloadFromState(loadedState, preserveWordTags)
    }
    return loadedTrack?.lyrics ?? ''
  }, [loadedTrackId, focusedTrackId, livePreview, tracks, editorStates, preserveWordTags])

  const loadedTrackParsedLines = useMemo(
    () => loadedTrackLyricsText ? parseLrc(loadedTrackLyricsText, { preserveWordTags }) : [],
    [loadedTrackLyricsText, preserveWordTags]
  )

  const activeLineTexts = useMemo(() => {
    if (loadedTrackParsedLines.length === 0) return []
    return findActiveLineIndices(loadedTrackParsedLines, playbackTimeMs).map((i) => loadedTrackParsedLines[i]?.text || '(instrumental)')
  }, [loadedTrackParsedLines, playbackTimeMs])

  // Stacked output for embed preview
  const stackedOutput = buildEmbedPayloadFromState(focusedEditorState, preserveWordTags)

  // Active fetch count
  const activeFetchCount = useMemo(() => {
    let count = 0
    for (const p of fetchProgressMap.values()) if (p.phase === 'fetching') count++
    return count
  }, [fetchProgressMap])

  // Last fetch error for cancel tooltip
  const lastFetchError = useMemo(() => {
    for (const p of fetchProgressMap.values()) {
      if (p.phase === 'error' && p.error) {
        const provider = p.providerId === 'lrclib' ? 'LRCLIB' : p.providerId === 'localSidecar' ? 'local .lrc' : 'provider'
        return `${provider}: ${p.error}`
      }
    }
    return null
  }, [fetchProgressMap])

  // Draft track IDs for sidebar badging
  const draftTrackIds = useMemo(() => new Set(tracks.filter((t) => Boolean(t.draftId)).map((t) => t.id)), [tracks])

  const sidebarState = useSidebarState()
  const { sidebarWidth } = sidebarState

  // Menu sync
  const { handleMenuActionRef } = useMenuSync({
    focusedTrack,
    focusedHasDraft,
    focusedIsDirty,
    focusedLyricsText,
    health,
    sidebarVisible: sidebarState.sidebarVisible,
    workspaceMode,
    isPlaying,
    loadedTrackId,
    selection,
    embedding,
    preserveWordTags
  })

  // Hooks
  const { flushAutoSave, handleRevertToEmbedded } = useDraftPersistence({
    editorStatesRef: { current: editorStates } as any,
    focusedTrackId,
    setBannerError,
    setTracks,
    setEditorStates,
    editorStates
  })

  const {
    searchTitle: hookSearchTitle,
    searchArtist: hookSearchArtist,
    searchAlbum: hookSearchAlbum,
    searchDuration: hookSearchDuration,
    searchResults: hookSearchResults,
    searchLoading: hookSearchLoading,
    searchError: hookSearchError,
    searchSearched: hookSearchSearched,
    providerFilter: hookProviderFilter,
    setProviderFilter,
    handleSearchCandidates,
    handleLoadCandidate,
    handleLoadAllLayers
  } = useLyricsSearch({
    focusedTrack,
    focusedTrackId,
    tracksRef,
    setEditorStates,
    setTracks,
    setBannerError,
    setStatusMessage,
    setWorkspaceMode,
    flushAutoSave
  })

  const { aiJob, aiConfigured, handleAiGenerate, handleAiCancel } = useAiGeneration({
    focusedTrack,
    focusedEditorState,
    setEditorStates,
    setBannerError,
    setStatusMessage,
    flushAutoSave,
    hasSyncedTimestamps,
    aiSettings
  })

  useVirtualTracks({
    tracks: filteredTracks,
    onRowClick: handleRowClick,
    onClearSelection: () => setSelection(clearSelection(selection.focusedId)),
    selection
  })

  // Sync search state from hook to local state (for compatibility)
  useEffect(() => { setSearchTitle(hookSearchTitle) }, [hookSearchTitle])
  useEffect(() => { setSearchArtist(hookSearchArtist) }, [hookSearchArtist])
  useEffect(() => { setSearchAlbum(hookSearchAlbum) }, [hookSearchAlbum])
  useEffect(() => { setSearchDuration(hookSearchDuration) }, [hookSearchDuration])
  useEffect(() => { setSearchResults(hookSearchResults) }, [hookSearchResults])
  useEffect(() => { setProviderFilter(hookProviderFilter) }, [hookProviderFilter])
  useEffect(() => { setSearchLoading(hookSearchLoading) }, [hookSearchLoading])
  useEffect(() => { setSearchError(hookSearchError) }, [hookSearchError])
  useEffect(() => { setSearchSearched(hookSearchSearched) }, [hookSearchSearched])

  // Initial load
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
        const initialEditorStates = new Map<string, EditorState>()
        for (const track of initialTracks) {
          if (track.draftId) {
            const draft = await window.api.getDraft(track.id)
            if (draft) initialEditorStates.set(track.id, createStateFromDraft(track.id, draft))
            else if (track.lyrics) initialEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
          } else if (track.lyrics) {
            initialEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
          }
        }
        setEditorStates(initialEditorStates)
      } catch (error) {
        if (active) setBannerError(error instanceof Error ? error.message : String(error))
      }
    })()

    const unsubScanProgress = window.api.onScanProgress((p) => { setScanProgress(p); setScanning(p.phase === 'scanning') })
    const unsubScanComplete = window.api.onScanComplete(async () => {
      try {
        const [nextRoots, nextTracks] = await Promise.all([window.api.getRoots(), window.api.getTracks()])
        setRoots(nextRoots)
        setTracks(nextTracks)
        const nextEditorStates = new Map(editorStates)
        for (const track of nextTracks) {
          if (track.draftId) {
            const draft = await window.api.getDraft(track.id)
            if (draft) nextEditorStates.set(track.id, createStateFromDraft(track.id, draft))
          } else if (!nextEditorStates.has(track.id) && track.lyrics) {
            nextEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
          }
        }
        setEditorStates(nextEditorStates)
        setSelection(reconcileSelection(selection, nextTracks.map((t) => t.id)))
      } catch (error) { setBannerError(error instanceof Error ? error.message : String(error)) }
      finally { setScanning(false) }
    })
    const unsubFetchProgress = window.api.onLyricsFetchProgress((p) => setFetchProgressMap((prev) => { const n = new Map(prev); n.set(p.trackId, p); return n }))
    const unsubMenuAction = window.api.onMenuAction((a) => void handleMenuActionRef.current(a))

    return () => { active = false; unsubScanProgress(); unsubScanComplete(); unsubFetchProgress(); unsubMenuAction() }
  }, [])

  // Restore draft when focused track gains draftId
  useEffect(() => {
    if (!focusedTrackId) return
    const track = tracksRef.current.find((t) => t.id === focusedTrackId)
    if (!track?.draftId) return
    const currentState = editorStates.get(focusedTrackId)
    if (currentState && hasContent(currentState)) return
    let cancelled = false
    void window.api.getDraft(focusedTrackId).then((draft) => {
      if (cancelled || !draft) return
      setEditorStates((prev) => { const n = new Map(prev); n.set(focusedTrackId, createStateFromDraft(focusedTrackId, draft)); return n })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [focusedTrackId, tracks])

  // Auto-search when entering Find tab
  useEffect(() => {
    if (workspaceMode !== 'find') return
    if (searchSearched || searchLoading) return
    if (!focusedTrackId) return
    void handleSearchCandidates()
  }, [workspaceMode, searchSearched, searchLoading, focusedTrackId])

  // Load AI settings
  const loadAiSettings = useCallback(async () => {
    try { setAiSettings(await window.api.getAiSettings()) } catch (error) { setBannerError(error instanceof Error ? error.message : String(error)) }
  }, [])
  useEffect(() => { void loadAiSettings() }, [loadAiSettings])

  // Handlers
  async function handleSaveAiSettings(input: { preset: AiProviderPreset; baseUrl: string; model: string; targetLanguage: string; romanizationStyle: string; apiKey?: string }) {
    const next = await window.api.saveAiSettings(input)
    setAiSettings(next)
    setStatusMessage('AI settings saved.')
  }

  async function handleClearAiKey() {
    setAiSettings(await window.api.clearAiKey())
    setStatusMessage('AI API key cleared.')
  }

  function handleRowClick(trackId: string, modifiers: SelectionClickModifiers) {
    if (trackId !== focusedTrackId) void flushAutoSave(focusedTrackId)
    setSelection((prev) => applyTrackClick(prev, visibleTrackIds, trackId, modifiers))
  }

  function handleLyricsChange(nextLyrics: string) {
    if (!focusedTrack) return
    setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, primary: nextLyrics, dirty: true, saveState: 'idle' }); return n })
  }

  function handleTranslationChange(next: string) {
    if (!focusedTrack) return
    setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, translation: { ...s.translation, text: next }, dirty: true, saveState: 'idle' }); return n })
  }

  function handleRomanizationChange(next: string) {
    if (!focusedTrack) return
    setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, romanization: { ...s.romanization, text: next }, dirty: true, saveState: 'idle' }); return n })
  }

  function handleShowTranslationLayerChange(visible: boolean) {
    if (!focusedTrack) return
    setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, translation: { ...s.translation, visible } }); return n })
  }

  function handleShowRomanizationLayerChange(visible: boolean) {
    if (!focusedTrack) return
    setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, romanization: { ...s.romanization, visible } }); return n })
  }

  async function handleImportLrc() {
    if (!focusedTrack) return
    setBannerError(null)
    try {
      const selected = await window.api.selectLrcFile()
      if (!selected) return
      const content = await window.api.lyricsImportFile(selected)
      if (!content) { setBannerError('Selected .lrc file was empty, symlinked, or exceeded 1 MiB.'); return }
      setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, primary: content, dirty: true, saveState: 'idle' }); return n })
      await flushAutoSave(focusedTrack.id)
      setStatusMessage(`Imported ${selected}`)
    } catch (error) { setBannerError(error instanceof Error ? error.message : String(error)) }
  }

  async function handleFetchSelected() {
    const targets = filteredTracks.filter((t) => selection.selectedIds.has(t.id))
    if (targets.length === 0) return
    setBannerError(null)
    setStatusMessage(`Fetching lyrics for ${targets.length} track(s)...`)
    try { await window.api.lyricsFetchBatch(targets.map(toFetchRequest)) } catch (error) { setBannerError(error instanceof Error ? error.message : String(error)) }
  }

  async function handleCancelActiveFetches() {
    const ids: string[] = []
    for (const [id, p] of fetchProgressMap) if (p.phase === 'fetching') ids.push(id)
    await Promise.all(ids.map((id) => window.api.lyricsCancelFetch(id)))
  }

  async function embedSingleTrack(track: TrackRecord, payload: string): Promise<boolean> {
    setEmbedStatusMap((prev) => { const n = new Map(prev); n.set(track.id, { phase: 'embedding' }); return n })
    try {
      const result = await window.api.embedLyrics({ filePath: track.filePath, lyrics: payload })
      if (!result.verified) {
        setEmbedStatusMap((prev) => { const n = new Map(prev); n.set(track.id, { phase: 'error', error: 'Embed did not verify cleanly.' }); return n })
        return false
      }
      const refreshed = await window.api.getTrack(track.id)
      await window.api.deleteDraft(track.id)
      setEditorStates((prev) => { const n = new Map(prev); const embeddedLyrics = refreshed?.lyrics ?? payload; n.set(track.id, clearLayers(createStateFromFile(track.id, embeddedLyrics))); return n })
      setTracks((prev) => prev.map((t) => t.id === track.id ? { ...(refreshed ?? t), draftId: undefined } : t))
      setEmbedStatusMap((prev) => { const n = new Map(prev); n.set(track.id, { phase: 'verified', targetPath: result.targetPath, lyricsSource: result.lyricsSource }); return n })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setEmbedStatusMap((prev) => { const n = new Map(prev); n.set(track.id, { phase: 'error', error: message }); return n })
      return false
    }
  }

  async function handleEmbedFocused() {
    if (!focusedTrack || embedding) return
    setEmbedding(true); setBannerError(null); setStatusMessage(null)
    try {
      await flushAutoSave(focusedTrack.id)
      const state = editorStates.get(focusedTrack.id) ?? createEmptyEditorState(focusedTrack.id)
      const payload = buildEmbedPayloadFromState(state, preserveWordTags)
      const ok = await embedSingleTrack(focusedTrack, payload)
      if (ok) setStatusMessage(`Embedded lyrics for "${focusedTrack.title}".`)
      else setBannerError(`Failed to embed "${focusedTrack.title}".`)
    } finally { setEmbedding(false) }
  }

  async function handleEmbedSelected() {
    if (embedding) return
    const targets = filteredTracks.filter((t) => selection.selectedIds.has(t.id))
    if (targets.length === 0) return
    setEmbedding(true); setBannerError(null)
    let succeeded = 0, failed = 0
    try {
      for (const track of targets) {
        if (track.id === focusedTrackId) await flushAutoSave(track.id)
        let state = editorStates.get(track.id) ?? null
        if (track.id !== focusedTrackId && (!state || !state.dirty)) {
          if (track.draftId) {
            try { const draft = await window.api.getDraft(track.id); if (draft) state = createStateFromDraft(track.id, draft) } catch {}
          }
        }
        let payload: string
        if (state && hasContent(state)) payload = buildEmbedPayloadFromState(state, preserveWordTags)
        else if (track.lyrics) payload = track.lyrics
        else continue
        const ok = await embedSingleTrack(track, payload)
        if (ok) succeeded++; else failed++
      }
      setStatusMessage(`Batch embed finished: ${succeeded} verified${failed > 0 ? `, ${failed} failed` : ''}.`)
    } finally { setEmbedding(false) }
  }

  async function handleMenuAction(action: MenuAction): Promise<void> {
    switch (action) {
      case 'add-library-folder': await handleAddRoot(); break
      case 'scan-all-roots': await handleScan(); break
      case 'import-lrc': await handleImportLrc(); break
      case 'discard-draft': if (focusedTrack) await handleRevertToEmbedded(focusedTrack.id); break
      case 'embed-current-track': if (focusedTrack && !embedding) await handleEmbedFocused(); break
      case 'open-settings': setSettingsOpen(true); break
      case 'ai-translate': await handleAiGenerate('translation'); break
      case 'ai-romanize': await handleAiGenerate('romanization'); break
      case 'normalize-lrc':
        if (focusedTrack) setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, primary: normalizeLrc(s.primary, { preserveWordTags }), dirty: true, saveState: 'idle' }); return n })
        break
      case 'toggle-preserve-word-tags': setPreserveWordTags((v) => !v); break
      case 'send-primary-to-translation':
        if (focusedTrack) { setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, translation: { ...s.translation, text: s.primary }, dirty: true, saveState: 'idle' }); return n }); setWorkspaceMode('text') }
        break
      case 'send-primary-to-romanization':
        if (focusedTrack) { setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, romanization: { ...s.romanization, text: s.primary }, dirty: true, saveState: 'idle' }); return n }); setWorkspaceMode('text') }
        break
      case 'toggle-sidebar': sidebarState.setSidebarVisible((v) => !v); break
      case 'mode-lyrics': setWorkspaceMode('lyrics'); break
      case 'mode-text': setWorkspaceMode('text'); break
      case 'mode-find': setWorkspaceMode('find'); break
      case 'toggle-play-pause': setPlayerCommand({ kind: 'toggle', nonce: Date.now() + Math.random() }); break
      case 'stop-and-unload': setPlayerCommand({ kind: 'stop', nonce: Date.now() + Math.random() }); break
      case 'show-tag-engine-status': break
    }
  }
  handleMenuActionRef.current = handleMenuAction

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
    } catch (error) { setScanning(false); setBannerError(error instanceof Error ? error.message : String(error)) }
  }

  async function handleRemoveRoot(rootId: string) {
    setBannerError(null)
    try {
      await window.api.removeRoot(rootId)
      const [nextRoots, nextTracks] = await Promise.all([window.api.getRoots(), window.api.getTracks()])
      setRoots(nextRoots); setTracks(nextTracks)
      if (activeRootFilter === rootId) setActiveRootFilter('')
      setSelection(reconcileSelection(selection, nextTracks.map((t) => t.id)))
      const nextEditorStates = new Map(editorStates)
      for (const track of nextTracks) if (!nextEditorStates.has(track.id) && track.lyrics) nextEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
      setEditorStates(nextEditorStates)
    } catch (error) { setBannerError(error instanceof Error ? error.message : String(error)) }
  }

  async function handleScan(rootId?: string) {
    setBannerError(null); setStatusMessage(null); setScanning(true)
    try {
      const result = await window.api.scanLibrary(rootId ? { rootId } : undefined)
      const [nextRoots, nextTracks] = await Promise.all([window.api.getRoots(), window.api.getTracks()])
      setRoots(nextRoots); setTracks(nextTracks)
      const nextEditorStates = new Map(editorStates)
      for (const track of nextTracks) if (!nextEditorStates.has(track.id) && track.lyrics) nextEditorStates.set(track.id, createStateFromFile(track.id, track.lyrics))
      setEditorStates(nextEditorStates)
      setSelection(reconcileSelection(selection, nextTracks.map((t) => t.id)))
      setStatusMessage(`Scan complete (${result.tracks.length} tracks indexed).`)
    } catch (error) { setBannerError(error instanceof Error ? error.message : String(error)) } finally { setScanning(false) }
  }

  // Render
  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      {bannerError && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-red-900/80 bg-red-950/60 px-4 py-1.5 text-xs text-red-200">
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
            <span className="truncate">{bannerError}</span>
          </div>
          <button type="button" aria-label="Dismiss error" onClick={() => setBannerError(null)} className="shrink-0 text-zinc-400 hover:text-zinc-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Top Bar */}
      <TopBar
        health={health}
        roots={roots}
        activeRootFilter={activeRootFilter}
        tracksCount={tracks.length}
        filteredCount={filteredTracks.length}
        scanning={scanning}
        scanProgress={scanProgress}
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        activeFetchCount={activeFetchCount}
        onAddRoot={handleAddRoot}
        onRemoveRoot={handleRemoveRoot}
        onScanAll={handleScan}
        onScanRoot={handleScan}
        onOpenSettings={() => setSettingsOpen(true)}
        onActiveRootFilterChange={(rootId: string) => setActiveRootFilter(rootId)}
        workerReady={health?.ready ?? false}
        selectedCount={selection.selectedIds.size}
      />

      <main className="flex flex-1 min-h-0 overflow-hidden bg-zinc-950">
        {/* Library Sidebar */}
        {sidebarState.sidebarVisible && (
          <div style={{ width: `${sidebarWidth}px` }} className="flex shrink-0 min-h-0 flex-col">
            <div
              className="w-1 cursor-col-resize select-none hover:bg-emerald-500/20"
              onPointerDown={sidebarState.handleDividerPointerDown}
              onPointerMove={sidebarState.handleDividerPointerMove}
              onPointerUp={sidebarState.handleDividerPointerUp}
              onPointerLeave={sidebarState.handleDividerPointerUp}
            />
            <LibrarySidebar
              health={health}
              scanning={scanning}
              scanProgress={scanProgress}
              filteredTracks={filteredTracks}
              selection={selection}
              activeFetchCount={activeFetchCount}
              lastFetchError={lastFetchError}
              embedding={embedding}
              draftTrackIds={draftTrackIds}
              fetchProgressMap={fetchProgressMap}
              embedStatusMap={embedStatusMap}
              loadedTrackId={loadedTrackId}
              isPlaying={isPlaying}
              onRowClick={handleRowClick}
              onSelectAll={() => setSelection(selectAllVisible(visibleTrackIds))}
              onClearSelection={() => setSelection(clearSelection(selection.focusedId))}
              onFetchSelected={handleFetchSelected}
              onCancelActiveFetches={handleCancelActiveFetches}
              onEmbedSelected={handleEmbedSelected}
            />
          </div>
        )}

        {/* Right Panel + Player */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <RightPanel
            focusedTrack={focusedTrack}
            editorState={focusedTrackId ? editorStates.get(focusedTrackId) ?? null : null}
            focusedEditorState={focusedEditorState}
            playbackTimeMs={playbackTimeMs}
            loadedTrackId={loadedTrackId}
            preserveWordTags={preserveWordTags}
            onPreserveWordTagsChange={setPreserveWordTags}
            onLyricsChange={handleLyricsChange}
            onTranslationChange={handleTranslationChange}
            onRomanizationChange={handleRomanizationChange}
            onSeekToMs={(trackId, timeMs) => setSeekRequest({ trackId, timeMs, nonce: Date.now() })}
            onImportLrc={handleImportLrc}
            onRevert={() => { if (focusedTrackId) handleRevertToEmbedded(focusedTrackId) }}
            onEmbedFocused={handleEmbedFocused}
            onNormalize={() => { if (focusedTrack) setEditorStates((prev) => { const n = new Map(prev); const s = n.get(focusedTrack!.id) ?? createEmptyEditorState(focusedTrack!.id); n.set(focusedTrack!.id, { ...s, primary: normalizeLrc(s.primary, { preserveWordTags }), dirty: true, saveState: 'idle' }); return n }) }}
            onPreviewTextChange={(trackId, text) => setLivePreview({ trackId, text })}
            workerReady={health?.ready ?? false}
            embedStatus={focusedTrackId ? embedStatusMap.get(focusedTrackId) : undefined}
            fetchProgress={focusedTrackId ? fetchProgressMap.get(focusedTrackId) : undefined}
            aiJob={aiJob}
            onAiGenerate={handleAiGenerate}
            onAiCancel={handleAiCancel}
            onOpenSettings={() => setSettingsOpen(true)}
            aiConfigured={aiConfigured}
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
            onSearchCandidates={handleSearchCandidates}
            onLoadCandidate={handleLoadCandidate}
            onLoadAllLayers={handleLoadAllLayers}
            providerFilter={hookProviderFilter}
            onProviderFilterChange={setProviderFilter}
            showTranslationLayer={showTranslationLayer}
            onShowTranslationLayerChange={handleShowTranslationLayerChange}
            showRomanizationLayer={showRomanizationLayer}
            onShowRomanizationLayerChange={handleShowRomanizationLayerChange}
            stackedOutput={stackedOutput}
            workspaceMode={workspaceMode}
            onWorkspaceModeChange={setWorkspaceMode}
          />

          <AudioPreviewPlayer
            focusedTrack={focusedTrack}
            activeLineTexts={activeLineTexts}
            seekRequest={seekRequest}
            playerCommand={playerCommand}
            statusMessage={statusMessage}
            onPlaybackChange={(nextLoadedId, nextTimeMs, nextPlaying) => { setLoadedTrackId(nextLoadedId); setPlaybackTimeMs(nextTimeMs); setIsPlaying(nextPlaying) }}
            onPlayerError={(message) => setBannerError(message)}
          />
        </div>
      </main>

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