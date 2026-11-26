import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'
import type {
  LibraryRoot,
  LyricsCandidate,
  LyricsFetchProgress,
  LyricsFetchRequest,
  LyricsSearchResult,
  ScanProgress,
  TagEngineHealth,
  TrackRecord
} from '@shared/ipc'
import { parseLrc } from '@shared/lrc'
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
import { LibraryToolbar } from './components/LibraryToolbar'
import { LyricsEditorPanel } from './components/LyricsEditorPanel'
import { TrackTable } from './components/TrackTable'
import type { SeekRequest, TrackEmbedStatus } from './types'

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

  const [sifterOpen, setSifterOpen] = useState(false)
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

  const [loadedTrackId, setLoadedTrackId] = useState<string | null>(null)
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)

  const [bannerError, setBannerError] = useState<string | null>(null)
  const [bannerStatus, setBannerStatus] = useState<string | null>(null)

  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const draftTextsRef = useRef(draftTexts)
  draftTextsRef.current = draftTexts
  /** Invalidates in-flight candidate searches when focus changes. */
  const searchNonceRef = useRef(0)

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

  const activeLineTexts = useMemo(() => {
    if (!loadedTrackId) return []
    const useLivePreview =
      focusedTrackId === loadedTrackId &&
      livePreview !== null &&
      livePreview.trackId === loadedTrackId
    const loadedTrack = tracks.find((t) => t.id === loadedTrackId)
    const lyrics = useLivePreview
      ? livePreview.text
      : (draftTexts.get(loadedTrackId) ?? loadedTrack?.lyrics ?? '')
    if (!lyrics) return []
    const lines = parseLrc(lyrics, { preserveWordTags })
    return findActiveLineIndices(lines, playbackTimeMs).map(
      (index) => lines[index]?.text || '(instrumental)'
    )
  }, [
    loadedTrackId,
    focusedTrackId,
    livePreview,
    tracks,
    draftTexts,
    preserveWordTags,
    playbackTimeMs
  ])

  const activeFetchCount = useMemo(() => {
    let count = 0
    for (const progress of fetchProgressMap.values()) {
      if (progress.phase === 'fetching') count++
    }
    return count
  }, [fetchProgressMap])

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

    return () => {
      active = false
      unsubScanProgress()
      unsubScanComplete()
      unsubFetchProgress()
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <LibraryToolbar
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
      />

      {(bannerError || bannerStatus) && (
        <div
          className={`flex shrink-0 items-center justify-between gap-2 border-b px-4 py-1.5 text-xs ${
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

      <main className="grid flex-1 min-h-0 grid-cols-12 gap-3 overflow-hidden p-3">
        <div className="col-span-7 flex min-h-0 flex-col">
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

        <div className="col-span-5 flex min-h-0 flex-col">
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
            onPreviewTextChange={handlePreviewTextChange}
            sifterOpen={sifterOpen}
            onSifterOpenChange={setSifterOpen}
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
          />
        </div>
      </main>

      <AudioPreviewPlayer
        focusedTrack={focusedTrack}
        activeLineTexts={activeLineTexts}
        seekRequest={seekRequest}
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
