import { describe, it, expect } from 'vitest'
import {
  buildMenuTemplate,
  collectAccelerators,
  findBareSpaceAccelerators,
  isMenuAction,
  sanitizeMenuSyncState,
  DEFAULT_MENU_SYNC_STATE
} from '@shared/menu'
import type { MenuSyncState } from '@shared/menu'

describe('MenuSyncState sanitization', () => {
  it('returns defaults for null/undefined input', () => {
    expect(sanitizeMenuSyncState(null)).toEqual(DEFAULT_MENU_SYNC_STATE)
    expect(sanitizeMenuSyncState(undefined)).toEqual(DEFAULT_MENU_SYNC_STATE)
    expect(sanitizeMenuSyncState('not an object')).toEqual(DEFAULT_MENU_SYNC_STATE)
    expect(sanitizeMenuSyncState(42)).toEqual(DEFAULT_MENU_SYNC_STATE)
  })

  it('clamps selectedCount and falls back unknown enums to defaults', () => {
    const state = sanitizeMenuSyncState({
      selectedCount: -5,
      mode: 'not-a-mode',
      editorLayout: 'not-a-layout',
      hasFocusedTrack: 'yes'
    } as unknown as MenuSyncState)
    expect(state.selectedCount).toBe(0)
    expect(state.mode).toBe('edit')
    expect(state.editorLayout).toBe('split')
    expect(state.hasFocusedTrack).toBe(false)
  })

  it('clamps huge selectedCount', () => {
    const state = sanitizeMenuSyncState({
      selectedCount: Number.MAX_SAFE_INTEGER
    } as unknown as MenuSyncState)
    expect(state.selectedCount).toBeLessThanOrEqual(100_000)
  })

  it('passes through a fully valid state', () => {
    const input: MenuSyncState = {
      hasFocusedTrack: true,
      hasDraft: true,
      isDirty: true,
      hasLyrics: true,
      workerReady: true,
      preserveWordTags: true,
      sidebarVisible: false,
      mode: 'layers',
      editorLayout: 'preview',
      isPlaying: true,
      canPlay: true,
      canStop: true,
      selectedCount: 3,
      embedding: false
    }
    expect(sanitizeMenuSyncState(input)).toEqual(input)
  })
})

describe('isMenuAction', () => {
  it('accepts known actions and rejects unknown strings', () => {
    expect(isMenuAction('embed-current-track')).toBe(true)
    expect(isMenuAction('toggle-preserve-word-tags')).toBe(true)
    expect(isMenuAction('show-tag-engine-status')).toBe(true)
    expect(isMenuAction('not-a-real-action')).toBe(false)
    expect(isMenuAction(undefined)).toBe(false)
    expect(isMenuAction(null)).toBe(false)
    expect(isMenuAction(42)).toBe(false)
  })
})

describe('Menu template structure', () => {
  const state: MenuSyncState = {
    hasFocusedTrack: true,
    hasDraft: false,
    isDirty: true,
    hasLyrics: true,
    workerReady: true,
    preserveWordTags: false,
    sidebarVisible: true,
    mode: 'edit',
    editorLayout: 'split',
    isPlaying: false,
    canPlay: true,
    canStop: false,
    selectedCount: 0,
    embedding: false
  }

  it('builds File, Edit, View, Playback, Help top-level menus', () => {
    const template = buildMenuTemplate(state)
    const labels = template.map((item) => item.label)
    expect(labels).toEqual(['File', 'Edit', 'View', 'Playback', 'Help'])
  })

  it('File contains exact accelerator set', () => {
    const template = buildMenuTemplate(state)
    const file = template.find((item) => item.label === 'File')!
    const accelerators = collectAccelerators(file.submenu ?? [])
    expect(accelerators).toContain('Ctrl+O')
    expect(accelerators).toContain('Ctrl+Shift+R')
    expect(accelerators).toContain('Ctrl+I')
    expect(accelerators).toContain('Ctrl+S')
    expect(accelerators).toContain('Ctrl+E')
  })

  it('Edit has normalize Ctrl+Shift+N and preserve checkbox', () => {
    const template = buildMenuTemplate(state)
    const edit = template.find((item) => item.label === 'Edit')!
    const accelerators = collectAccelerators(edit.submenu ?? [])
    expect(accelerators).toContain('Ctrl+Shift+N')
    const preserveItem = edit.submenu!.find((item) => item.action === 'toggle-preserve-word-tags')
    expect(preserveItem?.type).toBe('checkbox')
    expect(preserveItem?.checked).toBe(false)
  })

  it('View has sidebar Ctrl+B checkbox, mode radios Ctrl+1/2/3, layout radios, DevTools', () => {
    const template = buildMenuTemplate(state)
    const view = template.find((item) => item.label === 'View')!
    const accelerators = collectAccelerators(view.submenu ?? [])
    expect(accelerators).toContain('Ctrl+B')
    expect(accelerators).toContain('Ctrl+1')
    expect(accelerators).toContain('Ctrl+2')
    expect(accelerators).toContain('Ctrl+3')

    const sidebarItem = view.submenu!.find((item) => item.action === 'toggle-sidebar')
    expect(sidebarItem?.type).toBe('checkbox')
    expect(sidebarItem?.checked).toBe(true)

    const editMode = view.submenu!.find((item) => item.action === 'mode-edit')
    expect(editMode?.type).toBe('radio')
    expect(editMode?.checked).toBe(true)

    const layersMode = view.submenu!.find((item) => item.action === 'mode-layers')
    expect(layersMode?.type).toBe('radio')
    expect(layersMode?.checked).toBe(false)

    const layoutSub = view.submenu!.find((item) => item.label === 'Editor Layout')!
    const layoutItems = layoutSub.submenu!.map((item) => item.action)
    expect(layoutItems).toEqual(['layout-raw', 'layout-split', 'layout-preview'])

    const devTools = view.submenu!.find((item) => item.role === 'toggleDevTools')
    expect(devTools).toBeDefined()
  })

  it('Playback uses Alt+P and Alt+S, never bare Space', () => {
    const template = buildMenuTemplate(state)
    const playback = template.find((item) => item.label === 'Playback')!
    const accelerators = collectAccelerators(playback.submenu ?? [])
    expect(accelerators).toContain('Alt+P')
    expect(accelerators).toContain('Alt+S')
    expect(findBareSpaceAccelerators(playback.submenu ?? [])).toEqual([])
  })

  it('Help exposes TagLib / WASI status', () => {
    const template = buildMenuTemplate(state)
    const help = template.find((item) => item.label === 'Help')!
    const statusItem = help.submenu!.find((item) => item.action === 'show-tag-engine-status')
    expect(statusItem).toBeDefined()
  })

  it('has no bare Space accelerators anywhere in the template', () => {
    const template = buildMenuTemplate(state)
    expect(findBareSpaceAccelerators(template)).toEqual([])
  })

  it('every actionable item declares a valid MenuAction', () => {
    const template = buildMenuTemplate(state)
    const walk = (items: (typeof template)[number][]): void => {
      for (const item of items) {
        if (item.action) expect(isMenuAction(item.action)).toBe(true)
        if (item.submenu) walk(item.submenu)
      }
    }
    walk(template)
  })
})
