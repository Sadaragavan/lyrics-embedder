import { useCallback, useRef, useState } from 'react'
import type { AiJobState, AiProviderSettingsPublic, TrackRecord } from '@shared/ipc'
import type { EditorState } from '@shared/editorState'

interface UseAiGenerationOptions {
  focusedTrack: TrackRecord | null
  focusedEditorState: EditorState
  setEditorStates: React.Dispatch<React.SetStateAction<Map<string, EditorState>>>
  setBannerError: (message: string | null) => void
  setStatusMessage: (message: string | null) => void
  flushAutoSave: (trackId?: string | null) => Promise<void>
  hasSyncedTimestamps: (text: string) => boolean
  aiSettings: AiProviderSettingsPublic | null
}

/**
 * Manages AI translation/romanization generation.
 */
export function useAiGeneration({
  focusedTrack,
  focusedEditorState,
  setEditorStates,
  setBannerError,
  setStatusMessage,
  flushAutoSave,
  hasSyncedTimestamps,
  aiSettings
}: UseAiGenerationOptions) {
  const [aiJob, setAiJob] = useState<AiJobState | null>(null)
  const aiJobIdRef = useRef<string | null>(null)

  const aiConfigured = aiSettings
    ? aiSettings.hasApiKey || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(aiSettings.baseUrl)
    : false

  const handleAiGenerate = useCallback(
    async (mode: 'translation' | 'romanization') => {
      if (!focusedTrack || aiJob) return
      const track = focusedTrack // Narrow type for TypeScript
      if (!aiConfigured) {
        setBannerError(
          'AI layers are not configured yet. Add a base URL, model, and API key (or point at local Ollama) in Settings.'
        )
        return
      }
      if (!hasSyncedTimestamps(focusedEditorState.primary)) {
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
          trackId: track.id,
          mode,
          lyrics: focusedEditorState.primary
        })
        if (aiJobIdRef.current !== jobId) return
        setEditorStates((prev) => {
          const next = new Map(prev)
          const state = next.get(track.id) ?? { primary: '', translation: { text: '', visible: true }, romanization: { text: '', visible: true }, dirty: true, saveState: 'idle' as const, trackId: track.id }
          const updated = mode === 'translation'
            ? { ...state, translation: { ...state.translation, text: result.lyrics, visible: true }, dirty: true, saveState: 'idle' as const }
            : { ...state, romanization: { ...state.romanization, text: result.lyrics, visible: true }, dirty: true, saveState: 'idle' as const }
          next.set(track.id, updated)
          return next
        })
        await flushAutoSave(track.id)
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
    },
    [focusedTrack, aiJob, aiConfigured, focusedEditorState, setBannerError, setStatusMessage, setEditorStates, flushAutoSave, hasSyncedTimestamps]
  )

  const handleAiCancel = useCallback(async () => {
    const jobId = aiJobIdRef.current
    if (!jobId) return
    try {
      await window.api.aiCancelGenerate(jobId)
    } catch {
      // Cancellation is best-effort
    }
  }, [])

  return { aiJob, aiConfigured, handleAiGenerate, handleAiCancel }
}