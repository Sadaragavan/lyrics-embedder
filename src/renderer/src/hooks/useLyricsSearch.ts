import { useCallback, useEffect, useRef, useState } from 'react'
import type { LyricsSearchResult, TrackRecord, LyricsProviderFilter } from '@shared/ipc'

interface UseLyricsSearchOptions {
  focusedTrack: TrackRecord | null
  focusedTrackId: string | null
  tracksRef: React.MutableRefObject<TrackRecord[]>
  setEditorStates: React.Dispatch<React.SetStateAction<Map<string, any>>>
  setTracks: React.Dispatch<React.SetStateAction<TrackRecord[]>>
  setBannerError: (message: string | null) => void
  setStatusMessage: (message: string | null) => void
  setWorkspaceMode: (mode: 'lyrics' | 'text' | 'find') => void
  flushAutoSave: (trackId?: string | null) => Promise<void>
}

/**
 * Manages lyrics search state and candidate fetching.
 */
export function useLyricsSearch({
  focusedTrack,
  focusedTrackId,
  tracksRef,
  setEditorStates,
  setTracks,
  setBannerError,
  setStatusMessage,
  setWorkspaceMode,
  flushAutoSave
}: UseLyricsSearchOptions) {
  const [searchTitle, setSearchTitle] = useState('')
  const [searchArtist, setSearchArtist] = useState('')
  const [searchAlbum, setSearchAlbum] = useState('')
  const [searchDuration, setSearchDuration] = useState('')
  const [searchResults, setSearchResults] = useState<LyricsSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchSearched, setSearchSearched] = useState(false)
  const [providerFilter, setProviderFilter] = useState<LyricsProviderFilter>('all')

  const searchNonceRef = useRef(0)

  // Client-side provider filter
  const visibleResults = searchResults.length === 0
    ? []
    : providerFilter === 'all'
      ? searchResults
      : searchResults.filter((r) => r.providerId === providerFilter)

  // Pre-fill search when focus changes
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

  const handleSearchCandidates = useCallback(async () => {
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
      // @ts-ignore
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
  }, [focusedTrack, searchDuration, searchTitle, searchArtist, searchAlbum, providerFilter, searchLoading])

  const applyFetchedCandidate = useCallback(
    async (trackId: string, candidate: any): Promise<boolean> => {
      const text = candidate.syncedLyrics ?? candidate.plainLyrics ?? ''
      if (!text) return false
      const translation = candidate.translatedLyrics ?? ''
      const romanization = candidate.romanizedLyrics ?? ''
      try {
        // @ts-ignore
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
          const baseState = track?.lyrics
            ? { primary: track.lyrics, translation: { text: '', visible: true }, romanization: { text: '', visible: true }, dirty: true, saveState: 'idle' as const, trackId }
            : { primary: '', translation: { text: '', visible: true }, romanization: { text: '', visible: true }, dirty: true, saveState: 'idle' as const, trackId }
          const loaded = { ...baseState, primary: text }
          const withTranslation = translation.trim() ? { ...loaded, translation: { ...loaded.translation, text: translation } } : loaded
          const withRomanization = romanization.trim() ? { ...withTranslation, romanization: { ...withTranslation.romanization, text: romanization } } : withTranslation
          const withVis = romanization.trim()
            ? { ...withRomanization, translation: { ...withRomanization.translation, visible: translation.trim().length > 0 }, romanization: { ...withRomanization.romanization, visible: true } }
            : { ...withRomanization, translation: { ...withRomanization.translation, visible: translation.trim().length > 0 } }
          next.set(trackId, { ...withVis, saveState: 'saved' as const, dirty: false })
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
    [setEditorStates, setTracks, setBannerError, tracksRef]
  )

  const handleLoadCandidate = useCallback(
    async (result: LyricsSearchResult) => {
      if (!focusedTrack) return
      const text = result.syncedLyrics ?? result.plainLyrics ?? ''
      if (!text) return
      setBannerError('')
      const applied = await applyFetchedCandidate(focusedTrack.id, result)
      if (applied) {
        await flushAutoSave(focusedTrack.id)
        setStatusMessage(
          `Loaded ${result.providerId === 'lrclib' ? 'LRCLIB' : 'local .lrc'} candidate as the primary lyrics.`
        )
        setWorkspaceMode('lyrics')
      }
    },
    [focusedTrack, setBannerError, setStatusMessage, setWorkspaceMode, applyFetchedCandidate, flushAutoSave]
  )

  const handleLoadAllLayers = useCallback(
    async (result: LyricsSearchResult) => {
      if (!focusedTrack) return
      const text = result.syncedLyrics ?? result.plainLyrics ?? ''
      if (!text) return
      setBannerError('')
      try {
        const translation = result.translatedLyrics ?? ''
        const romanization = result.romanizedLyrics ?? ''
        // @ts-ignore
        const draft = await window.api.saveDraft({
          trackId: focusedTrack.id,
          lyrics: text,
          translation,
          romanization,
          status: 'pending'
        })
        setEditorStates((prev) => {
          const next = new Map(prev)
          const baseState = next.get(focusedTrack!.id) ?? { primary: '', translation: { text: '', visible: true }, romanization: { text: '', visible: true }, dirty: true, saveState: 'idle' as const, trackId: focusedTrack!.id }
          const loaded = { ...baseState, primary: text, translation: { text: translation, visible: translation.trim().length > 0 }, romanization: { text: romanization, visible: romanization.trim().length > 0 } }
          next.set(focusedTrack!.id, { ...loaded, saveState: 'saved' as const, dirty: false })
          return next
        })
        setTracks((prev) =>
          prev.map((track) => (track.id === focusedTrack!.id ? { ...track, draftId: draft.id } : track))
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
        setWorkspaceMode('lyrics')
      } catch (error) {
        setBannerError(error instanceof Error ? error.message : String(error))
      }
    },
    [focusedTrack, setBannerError, setStatusMessage, setWorkspaceMode, setEditorStates, setTracks, flushAutoSave]
  )

  return {
    searchTitle,
    setSearchTitle,
    searchArtist,
    setSearchArtist,
    searchAlbum,
    setSearchAlbum,
    searchDuration,
    setSearchDuration,
    searchResults,
    searchLoading,
    searchError,
    searchSearched,
    providerFilter,
    setProviderFilter,
    visibleResults,
    handleSearchCandidates,
    handleLoadCandidate,
    handleLoadAllLayers
  }
}

function providerDisplayName(providerId: LyricsSearchResult['providerId']): string {
  if (providerId === 'lrclib') return 'LRCLIB'
  if (providerId === 'netease') return 'NetEase'
  return 'the local .lrc sidecar'
}