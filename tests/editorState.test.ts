import { describe, it, expect } from 'vitest'
import {
  createEmptyEditorState,
  createStateFromDraft,
  createStateFromFile,
  clearLayers,
  markSaved,
  markSaveError,
  setPrimary,
  setTranslation,
  setRomanization,
  setTranslationVisible,
  loadPrimary,
  loadAllLayers,
  importLrc,
  revertToEmbedded,
  normalizePrimary,
  shiftPrimary,
  sendPrimaryToTranslation,
  sendPrimaryToRomanization,
  swapTranslation,
  swapRomanization,
  applyStackedLayers,
  clearPrimary,
  clearTranslation,
  clearRomanization,
  setAiTranslation,
  setAiRomanization,
  startSave,
  buildEmbedPayload,
  getDraftPayload,
  hasContent,
  hasSyncedPrimary
} from '../src/shared/editorState'

// Minimal LRC helpers for tests
const hasSynced = (text: string) => /\[\d{2}:\d{2}\.\d{2}\]/.test(text)
const stackFn = (primary: string, translation: string, romanization: string, tEn: boolean, rEn: boolean) => {
  const layers: string[] = []
  if (tEn && translation.trim()) layers.push(translation)
  if (rEn && romanization.trim()) layers.push(romanization)
  if (layers.length === 0) return primary
  return [primary, ...layers].join('\n')
}
const normalizeFn = (text: string) => text.replace(/\[offset:[^\]]+\]/g, '').replace(/\[length:[^\]]+\]/g, '').trim()
const shiftFn = (text: string, deltaMs: number) =>
  text.replace(/\[(\d{2}):(\d{2})\.(\d{2})\]/g, (_, m, s, cs) => {
    const total = (parseInt(m) * 60 + parseInt(s)) * 100 + parseInt(cs) + Math.round(deltaMs / 10)
    if (total < 0) return '[00:00.00]'
    const nm = Math.floor(total / 6000)
    const ns = Math.floor((total % 6000) / 100)
    const ncs = total % 100
    return `[${String(nm).padStart(2, '0')}:${String(ns).padStart(2, '0')}.${String(ncs).padStart(2, '0')}]`
  })

const samplePrimary = '[00:01.00]Line 1\n[00:02.00]Line 2'
const sampleTranslation = '[00:01.00]Trans 1\n[00:02.00]Trans 2'
const sampleRomanization = '[00:01.00]Roma 1\n[00:02.00]Roma 2'

describe('editorState', () => {
  describe('createEmptyEditorState', () => {
    it('creates empty state with null trackId', () => {
      const state = createEmptyEditorState()
      expect(state.primary).toBe('')
      expect(state.translation.text).toBe('')
      expect(state.romanization.text).toBe('')
      expect(state.dirty).toBe(false)
      expect(state.saveState).toBe('idle')
      expect(state.trackId).toBeNull()
    })

    it('creates empty state with given trackId', () => {
      const state = createEmptyEditorState('track-1')
      expect(state.trackId).toBe('track-1')
    })
  })

  describe('createStateFromDraft', () => {
    it('loads primary, translation, romanization from draft', () => {
      const state = createStateFromDraft('track-1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      expect(state.primary).toBe(samplePrimary)
      expect(state.translation.text).toBe(sampleTranslation)
      expect(state.romanization.text).toBe(sampleRomanization)
      expect(state.translation.visible).toBe(true)
      expect(state.romanization.visible).toBe(true)
      expect(state.dirty).toBe(false) // loading draft does NOT set dirty
      expect(state.trackId).toBe('track-1')
    })

    it('handles missing translation/romanization in draft', () => {
      const state = createStateFromDraft('track-1', { lyrics: samplePrimary })
      expect(state.translation.text).toBe('')
      expect(state.romanization.text).toBe('')
      expect(state.translation.visible).toBe(false)
      expect(state.romanization.visible).toBe(false)
    })

    it('sets visibility based on non-empty layer text', () => {
      const state = createStateFromDraft('track-1', {
        lyrics: samplePrimary,
        translation: '  ',
        romanization: sampleRomanization
      })
      expect(state.translation.visible).toBe(false)
      expect(state.romanization.visible).toBe(true)
    })
  })

  describe('createStateFromFile', () => {
    it('loads only primary from embedded file', () => {
      const state = createStateFromFile('track-1', samplePrimary)
      expect(state.primary).toBe(samplePrimary)
      expect(state.translation.text).toBe('')
      expect(state.romanization.text).toBe('')
      expect(state.dirty).toBe(false)
      expect(state.trackId).toBe('track-1')
    })
  })

  describe('clearLayers', () => {
    it('clears translation and romanization, marks clean', () => {
      const state = createStateFromDraft('track-1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      const cleared = clearLayers(state)
      expect(cleared.translation.text).toBe('')
      expect(cleared.romanization.text).toBe('')
      expect(cleared.dirty).toBe(false)
      expect(cleared.saveState).toBe('idle')
      expect(cleared.primary).toBe(samplePrimary) // primary preserved
    })
  })

  describe('markSaved / markSaveError', () => {
    it('markSaved clears dirty and sets saved', () => {
      const state = { ...createEmptyEditorState('t1'), dirty: true, saveState: 'saving' as const }
      const saved = markSaved(state)
      expect(saved.dirty).toBe(false)
      expect(saved.saveState).toBe('saved')
    })

    it('markSaveError sets error state', () => {
      const state = { ...createEmptyEditorState('t1'), saveState: 'saving' as const }
      const errored = markSaveError(state)
      expect(errored.saveState).toBe('error')
    })
  })

  describe('setPrimary / setTranslation / setRomanization', () => {
    it('setPrimary marks dirty', () => {
      const state = setPrimary(createEmptyEditorState('t1'), samplePrimary)
      expect(state.primary).toBe(samplePrimary)
      expect(state.dirty).toBe(true)
      expect(state.saveState).toBe('idle')
    })

    it('setTranslation marks dirty', () => {
      const state = setTranslation(createEmptyEditorState('t1'), sampleTranslation)
      expect(state.translation.text).toBe(sampleTranslation)
      expect(state.dirty).toBe(true)
    })

    it('setRomanization marks dirty', () => {
      const state = setRomanization(createEmptyEditorState('t1'), sampleRomanization)
      expect(state.romanization.text).toBe(sampleRomanization)
      expect(state.dirty).toBe(true)
    })
  })

  describe('setTranslationVisible / setRomanizationVisible', () => {
    it('toggles visibility without setting dirty', () => {
      const state = createStateFromDraft('t1', { lyrics: samplePrimary, translation: sampleTranslation })
      const toggled = setTranslationVisible(state, false)
      expect(toggled.translation.visible).toBe(false)
      expect(toggled.dirty).toBe(false) // visibility toggle does NOT set dirty
    })
  })

  describe('loadPrimary / loadAllLayers / importLrc', () => {
    it('loadPrimary replaces primary and marks dirty', () => {
      const base = createStateFromFile('t1', '[00:00.00]Old')
      const loaded = loadPrimary(base, samplePrimary)
      expect(loaded.primary).toBe(samplePrimary)
      expect(loaded.dirty).toBe(true)
    })

    it('loadAllLayers loads all three layers and marks dirty', () => {
      const base = createEmptyEditorState('t1')
      const loaded = loadAllLayers(base, samplePrimary, sampleTranslation, sampleRomanization)
      expect(loaded.primary).toBe(samplePrimary)
      expect(loaded.translation.text).toBe(sampleTranslation)
      expect(loaded.romanization.text).toBe(sampleRomanization)
      expect(loaded.translation.visible).toBe(true)
      expect(loaded.romanization.visible).toBe(true)
      expect(loaded.dirty).toBe(true)
    })

    it('loadAllLayers sets visibility based on content', () => {
      const base = createEmptyEditorState('t1')
      const loaded = loadAllLayers(base, samplePrimary, '', sampleRomanization)
      expect(loaded.translation.visible).toBe(false)
      expect(loaded.romanization.visible).toBe(true)
    })

    it('importLrc replaces primary and marks dirty', () => {
      const base = createStateFromFile('t1', '[00:00.00]Old')
      const imported = importLrc(base, samplePrimary)
      expect(imported.primary).toBe(samplePrimary)
      expect(imported.dirty).toBe(true)
    })
  })

  describe('revertToEmbedded', () => {
    it('restores embedded lyrics, clears layers, not dirty', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      const reverted = revertToEmbedded(base, '[00:00.00]Embedded')
      expect(reverted.primary).toBe('[00:00.00]Embedded')
      expect(reverted.translation.text).toBe('')
      expect(reverted.romanization.text).toBe('')
      expect(reverted.dirty).toBe(false)
    })
  })

  describe('normalizePrimary / shiftPrimary', () => {
    it('normalizePrimary marks dirty when changed', () => {
      const base = createStateFromDraft('t1', { lyrics: '[00:01.00]Line\n[offset:100]' })
      const normalized = normalizePrimary(base, normalizeFn)
      expect(normalized.primary).not.toContain('[offset:')
      expect(normalized.dirty).toBe(true)
    })

    it('normalizePrimary no-ops when unchanged', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const normalized = normalizePrimary(base, normalizeFn)
      expect(normalized).toBe(base) // same reference
      expect(normalized.dirty).toBe(false)
    })

    it('shiftPrimary marks dirty when changed', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const shifted = shiftPrimary(base, shiftFn, 1000)
      expect(shifted.primary).not.toBe(samplePrimary)
      expect(shifted.dirty).toBe(true)
    })

    it('shiftPrimary no-ops on zero delta', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const shifted = shiftPrimary(base, shiftFn, 0)
      expect(shifted).toBe(base)
    })
  })

  describe('sendPrimaryToTranslation / sendPrimaryToRomanization', () => {
    it('sendPrimaryToTranslation copies primary to translation, marks dirty', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const sent = sendPrimaryToTranslation(base)
      expect(sent.translation.text).toBe(samplePrimary)
      expect(sent.translation.visible).toBe(true)
      expect(sent.dirty).toBe(true)
      expect(sent.primary).toBe(samplePrimary) // primary unchanged
    })

    it('sendPrimaryToRomanization copies primary to romanization, marks dirty', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const sent = sendPrimaryToRomanization(base)
      expect(sent.romanization.text).toBe(samplePrimary)
      expect(sent.romanization.visible).toBe(true)
      expect(sent.dirty).toBe(true)
    })
  })

  describe('swapTranslation / swapRomanization', () => {
    it('swapTranslation exchanges primary and translation, marks dirty', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation
      })
      const swapped = swapTranslation(base)
      expect(swapped.primary).toBe(sampleTranslation)
      expect(swapped.translation.text).toBe(samplePrimary)
      expect(swapped.dirty).toBe(true)
    })

    it('swapRomanization exchanges primary and romanization, marks dirty', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        romanization: sampleRomanization
      })
      const swapped = swapRomanization(base)
      expect(swapped.primary).toBe(sampleRomanization)
      expect(swapped.romanization.text).toBe(samplePrimary)
      expect(swapped.dirty).toBe(true)
    })
  })

  describe('applyStackedLayers', () => {
    it('merges enabled layers into primary, clears layers, marks dirty', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      const applied = applyStackedLayers(base, stackFn)
      expect(applied.primary).toContain('Line 1')
      expect(applied.primary).toContain('Trans 1')
      expect(applied.primary).toContain('Roma 1')
      expect(applied.translation.text).toBe('')
      expect(applied.romanization.text).toBe('')
      expect(applied.dirty).toBe(true)
    })

    it('no-ops when no layers enabled', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      const noLayers = { ...base, translation: { ...base.translation, visible: false }, romanization: { ...base.romanization, visible: false } }
      const applied = applyStackedLayers(noLayers, stackFn)
      expect(applied.primary).toBe(samplePrimary)
      expect(applied.dirty).toBe(false) // unchanged
    })
  })

  describe('clearPrimary / clearTranslation / clearRomanization', () => {
    it('clearPrimary marks dirty when primary was non-empty', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const cleared = clearPrimary(base)
      expect(cleared.primary).toBe('')
      expect(cleared.dirty).toBe(true)
    })

    it('clearPrimary no-ops when primary already empty', () => {
      const base = createEmptyEditorState('t1')
      const cleared = clearPrimary(base)
      expect(cleared).toBe(base)
    })

    it('clearTranslation marks dirty when translation was non-empty', () => {
      const base = createStateFromDraft('t1', { lyrics: samplePrimary, translation: sampleTranslation })
      const cleared = clearTranslation(base)
      expect(cleared.translation.text).toBe('')
      expect(cleared.dirty).toBe(true)
    })

    it('clearRomanization marks dirty when romanization was non-empty', () => {
      const base = createStateFromDraft('t1', { lyrics: samplePrimary, romanization: sampleRomanization })
      const cleared = clearRomanization(base)
      expect(cleared.romanization.text).toBe('')
      expect(cleared.dirty).toBe(true)
    })
  })

  describe('setAiTranslation / setAiRomanization', () => {
    it('setAiTranslation sets translation layer and marks dirty', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const ai = setAiTranslation(base, sampleTranslation)
      expect(ai.translation.text).toBe(sampleTranslation)
      expect(ai.translation.visible).toBe(true)
      expect(ai.dirty).toBe(true)
    })

    it('setAiRomanization sets romanization layer and marks dirty', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const ai = setAiRomanization(base, sampleRomanization)
      expect(ai.romanization.text).toBe(sampleRomanization)
      expect(ai.romanization.visible).toBe(true)
      expect(ai.dirty).toBe(true)
    })
  })

  describe('startSave', () => {
    it('sets saveState to saving', () => {
      const base = createEmptyEditorState('t1')
      const saving = startSave(base)
      expect(saving.saveState).toBe('saving')
    })
  })

  describe('buildEmbedPayload', () => {
    it('builds payload with enabled layers', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      const payload = buildEmbedPayload(base, stackFn)
      expect(payload).toContain('Line 1')
      expect(payload).toContain('Trans 1')
      expect(payload).toContain('Roma 1')
    })

    it('excludes disabled layers', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: sampleRomanization
      })
      const disabled = { ...base, translation: { ...base.translation, visible: false } }
      const payload = buildEmbedPayload(disabled, stackFn)
      expect(payload).not.toContain('Trans 1')
      expect(payload).toContain('Roma 1')
    })

    it('returns primary only when no layers enabled', () => {
      const base = createStateFromFile('t1', samplePrimary)
      const payload = buildEmbedPayload(base, stackFn)
      expect(payload).toBe(samplePrimary)
    })
  })

  describe('getDraftPayload', () => {
    it('includes primary and non-empty layers', () => {
      const base = createStateFromDraft('t1', {
        lyrics: samplePrimary,
        translation: sampleTranslation,
        romanization: ''
      })
      const payload = getDraftPayload(base)
      expect(payload.lyrics).toBe(samplePrimary)
      expect(payload.translation).toBe(sampleTranslation)
      expect(payload.romanization).toBeUndefined()
    })

    it('excludes empty layers', () => {
      const base = createStateFromDraft('t1', { lyrics: samplePrimary, translation: '  ', romanization: '' })
      const payload = getDraftPayload(base)
      expect(payload.translation).toBeUndefined()
      expect(payload.romanization).toBeUndefined()
    })
  })

  describe('hasContent', () => {
    it('returns true when any layer has content', () => {
      expect(hasContent(createStateFromFile('t1', samplePrimary))).toBe(true)
      expect(hasContent(createStateFromDraft('t1', { lyrics: '', translation: sampleTranslation }))).toBe(true)
      expect(hasContent(createStateFromDraft('t1', { lyrics: '', romanization: sampleRomanization }))).toBe(true)
    })

    it('returns false when all layers empty', () => {
      expect(hasContent(createEmptyEditorState('t1'))).toBe(false)
    })
  })

  describe('hasSyncedPrimary', () => {
    it('delegates to hasSyncedFn', () => {
      const state = createStateFromFile('t1', samplePrimary)
      expect(hasSyncedPrimary(state, hasSynced)).toBe(true)
    })

    it('returns false for plain text', () => {
      const state = createStateFromFile('t1', 'Plain lyrics')
      expect(hasSyncedPrimary(state, hasSynced)).toBe(false)
    })
  })

  describe('cross-track isolation', () => {
    it('states for different tracks are independent', () => {
      const stateA = createStateFromDraft('track-A', { lyrics: 'A', translation: 'TA' })
      const stateB = createStateFromDraft('track-B', { lyrics: 'B', translation: 'TB' })

      const modifiedA = setTranslation(stateA, 'TA-modified')
      expect(modifiedA.translation.text).toBe('TA-modified')
      expect(stateB.translation.text).toBe('TB') // B unchanged
    })

    it('modifying one track does not affect another', () => {
      const stateA = createEmptyEditorState('track-A')
      const stateB = createEmptyEditorState('track-B')

      const modifiedA = setPrimary(stateA, 'Primary A')
      expect(modifiedA.primary).toBe('Primary A')
      expect(stateB.primary).toBe('')
    })
  })
})