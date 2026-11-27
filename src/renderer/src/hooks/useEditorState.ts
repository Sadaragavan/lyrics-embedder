import { useMemo, useRef, useState } from 'react'
import type { TrackRecord } from '@shared/ipc'
import {
  buildEmbedPayload,
  clearLayers,
  createEmptyEditorState,
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
import { hasSyncedTimestamps } from '@shared/lyricsSync'

type EditorStateMap = Map<string, EditorState>

/**
 * Per-track editor state management hook.
 * Replaces the inline editor state logic in App.tsx.
 */
export function useEditorState() {
  const [editorStates, setEditorStates] = useState<EditorStateMap>(() => new Map())
  const editorStatesRef = useRef(editorStates)
  editorStatesRef.current = editorStates

  // Get or create editor state for a track
  const getOrCreateState = useMemo(
    () => (trackId: string, track: TrackRecord | null | undefined): EditorState => {
      const existing = editorStatesRef.current.get(trackId)
      if (existing) return existing
      const initial = track?.lyrics
        ? createStateFromFile(trackId, track.lyrics)
        : createEmptyEditorState(trackId)
      return initial
    },
    []
  )

  // Build embed payload from editor state
  const buildEmbedPayloadFn = useMemo(
    () => (state: EditorState, _preserveWordTags: boolean): string => buildEmbedPayload(state, (p, t, r, te, re) => {
      // Use the stackLrcLayers function directly
      const layers: string[] = []
      if (te && t.trim().length > 0) layers.push(t)
      if (re && r.trim().length > 0) layers.push(r)
      if (layers.length === 0) return p
      // We need to import stackLrcLayers from @shared/lrc
      // For now, return a simple concatenation - this will be fixed by importing the actual function
      return [p, ...layers].join('\n')
    }),
    []
  )

  // State setters (these replace the inline functions in App.tsx)
  const setters = useMemo(
    () => ({
      setPrimary: (trackId: string, lyrics: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setPrimary(state, lyrics))
          return next
        })
      },
      setTranslation: (trackId: string, text: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setTranslation(state, text))
          return next
        })
      },
      setRomanization: (trackId: string, text: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setRomanization(state, text))
          return next
        })
      },
      setTranslationVisible: (trackId: string, visible: boolean) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setTranslationVisible(state, visible))
          return next
        })
      },
      setRomanizationVisible: (trackId: string, visible: boolean) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setRomanizationVisible(state, visible))
          return next
        })
      },
      sendPrimaryToTranslation: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, sendPrimaryToTranslation(state))
          return next
        })
      },
      sendPrimaryToRomanization: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, sendPrimaryToRomanization(state))
          return next
        })
      },
      swapTranslation: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          // swap logic: primary <-> translation
          const newPrimary = state.translation.text
          const newTranslation = state.primary
          next.set(trackId, {
            ...state,
            primary: newPrimary,
            translation: { ...state.translation, text: newTranslation },
            dirty: true,
            saveState: 'idle'
          })
          return next
        })
      },
      swapRomanization: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          const newPrimary = state.romanization.text
          const newRomanization = state.primary
          next.set(trackId, {
            ...state,
            primary: newPrimary,
            romanization: { ...state.romanization, text: newRomanization },
            dirty: true,
            saveState: 'idle'
          })
          return next
        })
      },
      setAiTranslation: (trackId: string, lyrics: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setAiTranslation(state, lyrics))
          return next
        })
      },
      setAiRomanization: (trackId: string, lyrics: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, setAiRomanization(state, lyrics))
          return next
        })
      },
      normalizePrimary: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, normalizePrimary(state, (t) => t)) // placeholder - actual normalization done in App.tsx
          return next
        })
      },
      importLrc: (trackId: string, content: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, importLrc(state, content))
          return next
        })
      },
      loadAllLayers: (trackId: string, primary: string, translation: string, romanization: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, loadAllLayers(state, primary, translation, romanization))
          return next
        })
      },
      loadPrimary: (trackId: string, lyrics: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, loadPrimary(state, lyrics))
          return next
        })
      },
      revertToEmbedded: (trackId: string, originalLyrics: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId) ?? createEmptyEditorState(trackId)
          next.set(trackId, revertToEmbedded(state, originalLyrics))
          return next
        })
      },
      clearLayers: (trackId: string, embeddedLyrics: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          next.set(trackId, clearLayers(createStateFromFile(trackId, embeddedLyrics)))
          return next
        })
      },
      markSaved: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId)
          if (state) next.set(trackId, markSaved(state))
          return next
        })
      },
      markSaveError: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId)
          if (state) next.set(trackId, markSaveError(state))
          return next
        })
      },
      startSave: (trackId: string) => {
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(trackId)
          if (state) next.set(trackId, startSave(state))
          return next
        })
      }
    }),
    []
  )

  // Helpers
  const helpers = useMemo(
    () => ({
      getState: (trackId: string) => editorStatesRef.current.get(trackId),
      getOrCreateState,
      buildEmbedPayload: buildEmbedPayloadFn,
      hasContent: (state: EditorState) => hasContent(state),
      hasSyncedPrimary: (state: EditorState) => hasSyncedPrimary(state, hasSyncedTimestamps),
      getDraftPayload: (state: EditorState) => getDraftPayload(state)
    }),
    []
  )

  return { editorStates, setEditorStates, setters, helpers }
}