import { useCallback, useEffect } from 'react'
import { getDraftPayload, hasContent, type EditorState } from '@shared/editorState'
import type { TrackRecord } from '@shared/ipc'

const AUTO_SAVE_DEBOUNCE_MS = 500

interface UseDraftPersistenceOptions {
  editorStatesRef: React.MutableRefObject<Map<string, EditorState>>
  focusedTrackId: string | null
  setBannerError: (message: string | null) => void
  setTracks: React.Dispatch<React.SetStateAction<TrackRecord[]>>
  setEditorStates: React.Dispatch<React.SetStateAction<Map<string, EditorState>>>
  editorStates: Map<string, EditorState>
}

/**
 * Handles draft persistence: auto-save, manual flush, and revert.
 * Per-track save state is stored in EditorState.saveState.
 */
export function useDraftPersistence({
  editorStatesRef,
  focusedTrackId,
  setBannerError,
  setTracks,
  setEditorStates,
  editorStates
}: UseDraftPersistenceOptions) {
  // Persist draft now
  const persistDraftNow = useCallback(
    async (trackId: string): Promise<boolean> => {
      const state = editorStatesRef.current.get(trackId)
      if (!state) return false
      // Persist when dirty even if empty (clearing primary is a real edit)
      if (!state.dirty && !hasContent(state)) return false

      const payload = getDraftPayload(state)

      setEditorStates((prev) => {
        const next = new Map(prev)
        const current = next.get(trackId)
        if (current) next.set(trackId, { ...current, saveState: 'saving' as const })
        return next
      })

      try {
        // @ts-ignore - window.api is available at runtime
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
          if (current) next.set(trackId, { ...current, saveState: 'saved' as const, dirty: false })
          return next
        })
        setTracks((prev) =>
          prev.map((t) => (t.id === trackId ? { ...t, draftId: draft.id } : t))
        )
        return true
      } catch (error) {
        setBannerError(error instanceof Error ? error.message : String(error))
        setEditorStates((prev) => {
          const next = new Map(prev)
          const current = next.get(trackId)
          if (current) next.set(trackId, { ...current, saveState: 'error' as const })
          return next
        })
        return false
      }
    },
    [editorStatesRef, focusedTrackId, setBannerError, setTracks, setEditorStates]
  )

  // Flush auto-save for a track (before switch/embed)
  const flushAutoSave = useCallback(
    async (trackId?: string | null): Promise<void> => {
      const target = trackId ?? focusedTrackId
      if (!target) return
      const state = editorStatesRef.current.get(target)
      if (!state || !state.dirty) return
      await persistDraftNow(target)
    },
    [focusedTrackId, editorStatesRef, persistDraftNow]
  )

  // Debounced auto-save effect for focused track
  useEffect(() => {
    if (!focusedTrackId) return
    const state = editorStatesRef.current.get(focusedTrackId)
    if (!state || !state.dirty) return

    const timer = setTimeout(() => {
      void persistDraftNow(focusedTrackId)
    }, AUTO_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [focusedTrackId, editorStates, persistDraftNow])

  // Revert to embedded lyrics
  const handleRevertToEmbedded = useCallback(
    async (trackId: string) => {
      setBannerError('')
      try {
        // @ts-ignore
        await window.api.deleteDraft(trackId)
        // @ts-ignore
        const state = editorStatesRef.current.get(trackId)
        const original = state?.primary ?? ''
        setEditorStates((prev) => {
          const next = new Map(prev)
          const current = next.get(trackId) ?? { primary: '', translation: { text: '', visible: true }, romanization: { text: '', visible: true }, dirty: false, saveState: 'idle' as const, trackId }
          next.set(trackId, {
            ...current,
            primary: original,
            translation: { text: '', visible: true },
            romanization: { text: '', visible: true },
            dirty: false,
            saveState: 'idle'
          })
          return next
        })
        setTracks((prev) =>
          prev.map((t) => (t.id === trackId ? { ...t, draftId: undefined } : t))
        )
      } catch (error) {
        setBannerError(error instanceof Error ? error.message : String(error))
      }
    },
    [setBannerError, setEditorStates, setTracks, editorStatesRef, focusedTrackId]
  )

  return { persistDraftNow, flushAutoSave, handleRevertToEmbedded }
}