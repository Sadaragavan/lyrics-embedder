/**
 * Native application menu for the main process.
 *
 * The template itself lives in `src/shared/menu.ts` (pure and unit-tested);
 * this module adapts it to Electron, dispatches renderer commands, and owns the
 * live `MenuSyncState` snapshot sent from the renderer.
 */

import { dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron'
import { buildMenuTemplate, sanitizeMenuSyncState, type MenuTemplateItem } from '@shared/menu'
import type { MenuAction, MenuSyncState, TagEngineHealth } from '@shared/ipc'

export interface ApplicationMenuOptions {
  getWindow: () => BrowserWindow | null
  getHealth: () => TagEngineHealth
  /** Sends non-Help menu actions to the renderer. */
  dispatch: (action: MenuAction) => void
}

let currentState: MenuSyncState = sanitizeMenuSyncState(null)
let activeOptions: ApplicationMenuOptions | null = null

function toElectronItem(item: MenuTemplateItem): MenuItemConstructorOptions {
  const { action, submenu, ...rest } = item
  const result: MenuItemConstructorOptions = { ...rest }
  if (submenu) {
    result.submenu = submenu.map(toElectronItem)
  }
  if (action) {
    result.click = () => {
      void handleMenuAction(action)
    }
  }
  return result
}

function describeHealth(health: TagEngineHealth): MessageBoxOptions {
  const ready = health.ready
  return {
    type: ready ? 'info' : 'error',
    title: 'TagLib / WASI Engine Status',
    message: ready ? 'TagLib WASI engine ready' : 'TagLib WASI engine unavailable',
    detail: [
      `TagLib version: ${health.taglibVersion ?? 'unknown'}`,
      `WASM path: ${health.wasmPath ?? 'unresolved'}`,
      `Worker PID: ${health.workerPid ?? 'none'}`,
      health.error ? `Error: ${health.error}` : 'No errors reported'
    ].join('\n'),
    buttons: ['Close'],
    defaultId: 0,
    noLink: true
  }
}

async function showEngineStatusDialog(): Promise<void> {
  if (!activeOptions) return
  const health = activeOptions.getHealth()
  const win = activeOptions.getWindow()
  const options = describeHealth(health)
  try {
    if (win && !win.isDestroyed()) {
      await dialog.showMessageBox(win, options)
    } else {
      await dialog.showMessageBox(options)
    }
  } catch (error) {
    console.error('[menu] failed to show TagLib status dialog:', error)
  }
}

async function handleMenuAction(action: MenuAction): Promise<void> {
  // Help > Engine Status is answered entirely in main so it works even when the
  // renderer is busy (for example mid-embed).
  if (action === 'show-tag-engine-status') {
    await showEngineStatusDialog()
    return
  }
  activeOptions?.dispatch(action)
}

function rebuildMenu(): void {
  const template = buildMenuTemplate(currentState).map(toElectronItem)
  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Installs the native menu. Must run after `app.whenReady()` resolves. */
export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  activeOptions = options
  rebuildMenu()
}

/**
 * Applies a renderer state snapshot. The payload is sanitized before use so a
 * malformed or hostile renderer message cannot inject menu roles or accelerators.
 */
export function updateMenuState(rawState: unknown): MenuSyncState {
  currentState = sanitizeMenuSyncState(rawState)
  rebuildMenu()
  return currentState
}

/** Clears the menu and detaches handlers during shutdown. */
export function disposeApplicationMenu(): void {
  activeOptions = null
  currentState = sanitizeMenuSyncState(null)
  Menu.setApplicationMenu(null)
}
