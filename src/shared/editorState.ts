/**
 * Per-track editor state machine.
 *
 * Each track gets an independent editor state keyed by trackId. This module
 * provides pure transitions so the renderer can manage editor state without
 * cross-track leaks, stale closures, or lost layers.
 *
 * Invariants:
 * - Only user edits or explicit load/import/fetch/AI actions set `dirty`.
 * - Loading from file or draft does NOT set `dirty`.
 * - After a verified embed: primary = file content, layers cleared, draft deleted.
 * - Layer merging never emits duplicate lines (same timestamp + identical text).
 * - If embed fails, all layers and draft are preserved.
 */

export interface EditorLayerState {
  text: string
  visible: boolean
}

export interface EditorState {
  /** Primary LRC text (may be empty). */
  primary: string
  /** Translation layer. */
  translation: EditorLayerState
  /** Romanization layer. */
  romanization: EditorLayerState
  /** True when the user has made an unsaved edit since last persist. */
  dirty: boolean
  /** Current auto-save status for UI indication. */
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  /** Nonce to track which focused track this state belongs to. */
  trackId: string | null
}

/** Initial empty state for a track. */
export function createEmptyEditorState(trackId: string | null = null): EditorState {
  return {
    primary: '',
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: false,
    saveState: 'idle',
    trackId
  }
}

/** Creates state loaded from an on-disk draft (does not set dirty). */
export function createStateFromDraft(
  trackId: string,
  draft: { lyrics: string; translation?: string; romanization?: string }
): EditorState {
  return {
    primary: draft.lyrics ?? '',
    translation: { text: draft.translation ?? '', visible: Boolean(draft.translation?.trim()) },
    romanization: { text: draft.romanization ?? '', visible: Boolean(draft.romanization?.trim()) },
    dirty: false,
    saveState: 'idle',
    trackId
  }
}

/** Creates state from embedded file lyrics (no draft, no layers). */
export function createStateFromFile(trackId: string, lyrics: string): EditorState {
  return {
    primary: lyrics,
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: false,
    saveState: 'idle',
    trackId
  }
}

/** Resets layers to empty (used after verified embed). */
export function clearLayers(state: EditorState): EditorState {
  return {
    ...state,
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: false,
    saveState: 'idle'
  }
}

/** Marks the state as clean after a successful persist. */
export function markSaved(state: EditorState): EditorState {
  return {
    ...state,
    dirty: false,
    saveState: 'saved'
  }
}

/** Marks the state as having a save error. */
export function markSaveError(state: EditorState): EditorState {
  return {
    ...state,
    saveState: 'error'
  }
}

/** Sets the primary text (user edit -> dirty). */
export function setPrimary(state: EditorState, primary: string): EditorState {
  return {
    ...state,
    primary,
    dirty: true,
    saveState: 'idle'
  }
}

/** Sets translation text (user edit -> dirty). */
export function setTranslation(state: EditorState, text: string): EditorState {
  return {
    ...state,
    translation: { ...state.translation, text },
    dirty: true,
    saveState: 'idle'
  }
}

/** Sets romanization text (user edit -> dirty). */
export function setRomanization(state: EditorState, text: string): EditorState {
  return {
    ...state,
    romanization: { ...state.romanization, text },
    dirty: true,
    saveState: 'idle'
  }
}

/** Sets translation visibility (does NOT set dirty). */
export function setTranslationVisible(state: EditorState, visible: boolean): EditorState {
  return {
    ...state,
    translation: { ...state.translation, visible }
  }
}

/** Sets romanization visibility (does NOT set dirty). */
export function setRomanizationVisible(state: EditorState, visible: boolean): EditorState {
  return {
    ...state,
    romanization: { ...state.romanization, visible }
  }
}

/** Loads a candidate's primary lyrics (sets dirty). */
export function loadPrimary(state: EditorState, lyrics: string): EditorState {
  return {
    ...state,
    primary: lyrics,
    dirty: true,
    saveState: 'idle'
  }
}

/** Loads all layers from a candidate (sets dirty). */
export function loadAllLayers(
  state: EditorState,
  primary: string,
  translation: string,
  romanization: string
): EditorState {
  return {
    ...state,
    primary,
    translation: { text: translation, visible: translation.trim().length > 0 },
    romanization: { text: romanization, visible: romanization.trim().length > 0 },
    dirty: true,
    saveState: 'idle'
  }
}

/** Imports an .lrc file as primary (sets dirty). */
export function importLrc(state: EditorState, lyrics: string): EditorState {
  return {
    ...state,
    primary: lyrics,
    dirty: true,
    saveState: 'idle'
  }
}

/** Reverts to embedded file lyrics (clears layers, not dirty). */
export function revertToEmbedded(state: EditorState, embeddedLyrics: string): EditorState {
  return {
    ...state,
    primary: embeddedLyrics,
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: false,
    saveState: 'idle'
  }
}

/** Normalizes primary timestamps (sets dirty if changed). */
export function normalizePrimary(state: EditorState, normalizeFn: (text: string) => string): EditorState {
  const normalized = normalizeFn(state.primary)
  if (normalized === state.primary) return state
  return {
    ...state,
    primary: normalized,
    dirty: true,
    saveState: 'idle'
  }
}

/** Shifts primary timestamps by offset (sets dirty if changed). */
export function shiftPrimary(state: EditorState, shiftFn: (text: string, deltaMs: number) => string, deltaMs: number): EditorState {
  if (deltaMs === 0) return state
  const shifted = shiftFn(state.primary, deltaMs)
  if (shifted === state.primary) return state
  return {
    ...state,
    primary: shifted,
    dirty: true,
    saveState: 'idle'
  }
}

/** Sends primary to translation layer (sets dirty). */
export function sendPrimaryToTranslation(state: EditorState): EditorState {
  return {
    ...state,
    translation: { text: state.primary, visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Sends primary to romanization layer (sets dirty). */
export function sendPrimaryToRomanization(state: EditorState): EditorState {
  return {
    ...state,
    romanization: { text: state.primary, visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Swaps primary with translation (sets dirty). */
export function swapTranslation(state: EditorState): EditorState {
  return {
    ...state,
    primary: state.translation.text,
    translation: { text: state.primary, visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Swaps primary with romanization (sets dirty). */
export function swapRomanization(state: EditorState): EditorState {
  return {
    ...state,
    primary: state.romanization.text,
    romanization: { text: state.primary, visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Applies stacked layers to primary, clears layers (sets dirty). */
export function applyStackedLayers(
  state: EditorState,
  stackFn: (primary: string, translation: string, romanization: string, translateEnabled: boolean, romanizeEnabled: boolean) => string
): EditorState {
  const stacked = stackFn(
    state.primary,
    state.translation.text,
    state.romanization.text,
    state.translation.visible,
    state.romanization.visible
  )
  if (stacked === state.primary) return state
  return {
    ...state,
    primary: stacked,
    translation: { text: '', visible: true },
    romanization: { text: '', visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Clears primary text (sets dirty if was non-empty). */
export function clearPrimary(state: EditorState): EditorState {
  if (state.primary.trim().length === 0) return state
  return {
    ...state,
    primary: '',
    dirty: true,
    saveState: 'idle'
  }
}

/** Clears translation layer (sets dirty if was non-empty). */
export function clearTranslation(state: EditorState): EditorState {
  if (state.translation.text.trim().length === 0) return state
  return {
    ...state,
    translation: { text: '', visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Clears romanization layer (sets dirty if was non-empty). */
export function clearRomanization(state: EditorState): EditorState {
  if (state.romanization.text.trim().length === 0) return state
  return {
    ...state,
    romanization: { text: '', visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Sets AI-generated translation (sets dirty). */
export function setAiTranslation(state: EditorState, lyrics: string): EditorState {
  return {
    ...state,
    translation: { text: lyrics, visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Sets AI-generated romanization (sets dirty). */
export function setAiRomanization(state: EditorState, lyrics: string): EditorState {
  return {
    ...state,
    romanization: { text: lyrics, visible: true },
    dirty: true,
    saveState: 'idle'
  }
}

/** Starts a save operation (sets saving state). */
export function startSave(state: EditorState): EditorState {
  return {
    ...state,
    saveState: 'saving'
  }
}

/** Builds the embed payload from current state. */
export function buildEmbedPayload(
  state: EditorState,
  stackFn: (primary: string, translation: string, romanization: string, translateEnabled: boolean, romanizeEnabled: boolean) => string
): string {
  return stackFn(
    state.primary,
    state.translation.text,
    state.romanization.text,
    state.translation.visible,
    state.romanization.visible
  )
}

/** Returns the draft payload to persist for this track. */
export function getDraftPayload(state: EditorState): {
  lyrics: string
  translation?: string
  romanization?: string
} {
  const payload: { lyrics: string; translation?: string; romanization?: string } = {
    lyrics: state.primary
  }
  if (state.translation.text.trim().length > 0) {
    payload.translation = state.translation.text
  }
  if (state.romanization.text.trim().length > 0) {
    payload.romanization = state.romanization.text
  }
  return payload
}

/** Checks if state has any content worth saving. */
export function hasContent(state: EditorState): boolean {
  return (
    state.primary.trim().length > 0 ||
    state.translation.text.trim().length > 0 ||
    state.romanization.text.trim().length > 0
  )
}

/** Checks if the primary layer has synced timestamps. */
export function hasSyncedPrimary(state: EditorState, hasSyncedFn: (text: string) => boolean): boolean {
  return hasSyncedFn(state.primary)
}