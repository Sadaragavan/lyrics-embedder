/**
 * Pure native-menu specification shared by the main process and Vitest.
 *
 * This module must stay free of Node-only and Electron imports so the template
 * structure, state sanitization, and accelerator rules can be unit tested in a
 * plain Node environment. `src/main/menu.ts` adapts this template to Electron.
 */

import type {
  EditorLayout,
  MenuAction,
  MenuSyncState,
  WorkspaceMode
} from './types'

export {
  isMenuAction,
  MENU_ACTIONS,
  type MenuAction,
  type MenuSyncState,
  type EditorLayout,
  type WorkspaceMode
} from './types'

export type MenuRole =
  | 'appMenu'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'toggleDevTools'
  | 'minimize'
  | 'close'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'

export type MenuItemType = 'normal' | 'separator' | 'checkbox' | 'radio'

/** Structural subset of Electron's `MenuItemConstructorOptions`. */
export interface MenuTemplateItem {
  label?: string
  id?: string
  role?: MenuRole
  type?: MenuItemType
  accelerator?: string
  checked?: boolean
  enabled?: boolean
  submenu?: MenuTemplateItem[]
  /** Renderer command dispatched when the item is clicked. */
  action?: MenuAction
}

export const DEFAULT_MENU_SYNC_STATE: Readonly<MenuSyncState> = Object.freeze({
  hasFocusedTrack: false,
  hasDraft: false,
  isDirty: false,
  hasLyrics: false,
  workerReady: false,
  preserveWordTags: false,
  sidebarVisible: true,
  mode: 'edit',
  editorLayout: 'live',
  isPlaying: false,
  canPlay: false,
  canStop: false,
  selectedCount: 0,
  embedding: false
})

const WORKSPACE_MODES: readonly WorkspaceMode[] = ['edit', 'layers', 'find']
const EDITOR_LAYOUTS: readonly EditorLayout[] = ['live', 'raw']
const MAX_SELECTED_COUNT = 100_000

function asBoolean(value: unknown): boolean {
  return value === true
}

function asSelectedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_SELECTED_COUNT, Math.max(0, Math.trunc(value)))
}

function asWorkspaceMode(value: unknown): WorkspaceMode {
  return WORKSPACE_MODES.includes(value as WorkspaceMode)
    ? (value as WorkspaceMode)
    : DEFAULT_MENU_SYNC_STATE.mode
}

function asEditorLayout(value: unknown): EditorLayout {
  return EDITOR_LAYOUTS.includes(value as EditorLayout)
    ? (value as EditorLayout)
    : DEFAULT_MENU_SYNC_STATE.editorLayout
}

/**
 * Shallow-compares two already-sanitized snapshots field by field.
 *
 * The renderer pushes a snapshot on every render, so the main process must be
 * able to detect a no-op update and skip rebuilding the native menu (which
 * re-creates every menu item and re-triggers menu-related work).
 */
export function menuStateEquals(a: MenuSyncState, b: MenuSyncState): boolean {
  return (
    a.hasFocusedTrack === b.hasFocusedTrack &&
    a.hasDraft === b.hasDraft &&
    a.isDirty === b.isDirty &&
    a.hasLyrics === b.hasLyrics &&
    a.workerReady === b.workerReady &&
    a.preserveWordTags === b.preserveWordTags &&
    a.sidebarVisible === b.sidebarVisible &&
    a.mode === b.mode &&
    a.editorLayout === b.editorLayout &&
    a.isPlaying === b.isPlaying &&
    a.canPlay === b.canPlay &&
    a.canStop === b.canStop &&
    a.selectedCount === b.selectedCount &&
    a.embedding === b.embedding
  )
}

/**
 * Defensively normalizes an untrusted renderer payload into a `MenuSyncState`.
 * Unknown shapes fall back to defaults; enums are allow-listed and the selected
 * count is clamped to a sane integer range.
 */
export function sanitizeMenuSyncState(input: unknown): MenuSyncState {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_MENU_SYNC_STATE }
  }
  const candidate = input as Record<string, unknown>
  return {
    hasFocusedTrack: asBoolean(candidate.hasFocusedTrack),
    hasDraft: asBoolean(candidate.hasDraft),
    isDirty: asBoolean(candidate.isDirty),
    hasLyrics: asBoolean(candidate.hasLyrics),
    workerReady: asBoolean(candidate.workerReady),
    preserveWordTags: asBoolean(candidate.preserveWordTags),
    sidebarVisible: asBoolean(candidate.sidebarVisible),
    mode: asWorkspaceMode(candidate.mode),
    editorLayout: asEditorLayout(candidate.editorLayout),
    isPlaying: asBoolean(candidate.isPlaying),
    canPlay: asBoolean(candidate.canPlay),
    canStop: asBoolean(candidate.canStop),
    selectedCount: asSelectedCount(candidate.selectedCount),
    embedding: asBoolean(candidate.embedding)
  }
}

/** True when an accelerator is the unmodified Space key (Poweramp playback uses Alt+P). */
export function isBareSpaceAccelerator(accelerator: string): boolean {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  return parts.length === 1 && parts[0] === 'space'
}

export function collectAccelerators(items: readonly MenuTemplateItem[]): string[] {
  const accelerators: string[] = []
  const walk = (list: readonly MenuTemplateItem[]): void => {
    for (const item of list) {
      if (item.accelerator) accelerators.push(item.accelerator)
      if (item.submenu) walk(item.submenu)
    }
  }
  walk(items)
  return accelerators
}

export function findBareSpaceAccelerators(items: readonly MenuTemplateItem[]): string[] {
  return collectAccelerators(items).filter(isBareSpaceAccelerator)
}

function actionable(
  label: string,
  action: MenuAction,
  options: { accelerator?: string; enabled?: boolean } = {}
): MenuTemplateItem {
  return {
    label,
    id: action,
    action,
    ...(options.accelerator ? { accelerator: options.accelerator } : {}),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled })
  }
}

/**
 * Builds the full application menu template for a given renderer state.
 * Accelerators are intentionally explicit: playback never binds bare Space.
 */
export function buildMenuTemplate(state: MenuSyncState): MenuTemplateItem[] {
  const hasTrack = state.hasFocusedTrack
  const hasText = hasTrack && state.hasLyrics

  return [
    {
      label: 'File',
      submenu: [
        actionable('Add Library Folder…', 'add-library-folder', { accelerator: 'Ctrl+O' }),
        actionable('Scan All Roots', 'scan-all-roots', {
          accelerator: 'Ctrl+Shift+R',
          enabled: state.workerReady
        }),
        actionable('Import .lrc…', 'import-lrc', {
          accelerator: 'Ctrl+I',
          enabled: hasTrack
        }),
        { type: 'separator' },
        // Drafts auto-save; the only draft action left is reverting to the
        // lyrics embedded in the file.
        actionable('Revert to Embedded File', 'discard-draft', {
          enabled: hasTrack && state.hasDraft
        }),
        { type: 'separator' },
        actionable('Embed Current Track', 'embed-current-track', {
          accelerator: 'Ctrl+E',
          enabled: hasTrack && state.workerReady && !state.embedding
        }),
        { type: 'separator' },
        { label: 'Exit', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' },
        actionable('Normalize LRC', 'normalize-lrc', {
          accelerator: 'Ctrl+Shift+N',
          enabled: hasText
        }),
        {
          label: 'Preserve A2 <mm:ss.xx> Tags',
          id: 'toggle-preserve-word-tags',
          action: 'toggle-preserve-word-tags',
          type: 'checkbox',
          checked: state.preserveWordTags
        },
        { type: 'separator' },
        actionable('Send Primary to Translation', 'send-primary-to-translation', {
          enabled: hasText
        }),
        actionable('Send Primary to Romanization', 'send-primary-to-romanization', {
          enabled: hasText
        })
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Library Sidebar',
          id: 'toggle-sidebar',
          action: 'toggle-sidebar',
          type: 'checkbox',
          accelerator: 'Ctrl+B',
          checked: state.sidebarVisible
        },
        { type: 'separator' },
        {
          label: 'Edit Mode',
          id: 'mode-edit',
          action: 'mode-edit',
          type: 'radio',
          accelerator: 'Ctrl+1',
          checked: state.mode === 'edit'
        },
        {
          label: 'Layers Mode',
          id: 'mode-layers',
          action: 'mode-layers',
          type: 'radio',
          accelerator: 'Ctrl+2',
          checked: state.mode === 'layers'
        },
        {
          label: 'Find Lyrics Mode',
          id: 'mode-find',
          action: 'mode-find',
          type: 'radio',
          accelerator: 'Ctrl+3',
          checked: state.mode === 'find'
        },
        { type: 'separator' },
        {
          label: 'Editor Layout',
          submenu: [
            {
              label: 'Live Editor',
              id: 'layout-live',
              action: 'layout-live',
              type: 'radio',
              checked: state.editorLayout === 'live'
            },
            {
              label: 'Raw LRC Text',
              id: 'layout-raw',
              action: 'layout-raw',
              type: 'radio',
              checked: state.editorLayout === 'raw'
            }
          ]
        },
        { type: 'separator' },
        { label: 'Toggle DevTools', role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Playback',
      submenu: [
        actionable(state.isPlaying ? 'Pause' : 'Play', 'toggle-play-pause', {
          accelerator: 'Alt+P',
          enabled: state.canPlay
        }),
        actionable('Stop & Unload Audio', 'stop-and-unload', {
          accelerator: 'Alt+S',
          enabled: state.canStop
        })
      ]
    },
    {
      label: 'Help',
      submenu: [
        actionable('TagLib / WASI Engine Status', 'show-tag-engine-status')
      ]
    }
  ]
}
