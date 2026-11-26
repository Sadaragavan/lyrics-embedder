import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Download,
  FolderPlus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
  XCircle
} from 'lucide-react'
import type { LibraryRoot, ScanProgress, TagEngineHealth } from '@shared/ipc'
import type { TrackLyricsFilter } from '@shared/trackSelection'

export interface LibrarySidebarProps {
  health: TagEngineHealth | null
  roots: LibraryRoot[]
  activeRootFilter: string
  onActiveRootFilterChange: (rootId: string) => void
  tracksCount: number
  filteredCount: number
  selectedCount: number
  scanning: boolean
  scanProgress: ScanProgress | null
  search: string
  onSearchChange: (value: string) => void
  statusFilter: TrackLyricsFilter
  onStatusFilterChange: (filter: TrackLyricsFilter) => void
  activeFetchCount: number
  /** Most recent fetch failure (`provider: message`) for the cancel tooltip. */
  lastFetchError?: string | null
  embedding: boolean
  onAddRoot: () => void
  onRemoveRoot: (rootId: string) => void
  onScanAll: () => void
  onScanRoot: (rootId: string) => void
  onFetchSelected: () => void
  onCancelActiveFetches: () => void
  onEmbedSelected: () => void
  onClearSelection: () => void
}

/**
 * Compact library controls that live inside the library sidebar header instead
 * of a permanent two-row banner across the top of the window.
 */
export function LibrarySidebar({
  health,
  roots,
  activeRootFilter,
  onActiveRootFilterChange,
  tracksCount,
  filteredCount,
  selectedCount,
  scanning,
  scanProgress,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  activeFetchCount,
  lastFetchError,
  embedding,
  onAddRoot,
  onRemoveRoot,
  onScanAll,
  onScanRoot,
  onFetchSelected,
  onCancelActiveFetches,
  onEmbedSelected,
  onClearSelection
}: LibrarySidebarProps) {
  const workerReady = Boolean(health?.ready)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const foldersRef = useRef<HTMLDivElement | null>(null)

  const progressTotal = scanProgress?.total ?? 0
  const progressProcessed = scanProgress?.processed ?? 0
  const progressPercent =
    progressTotal > 0 ? Math.min(100, Math.round((progressProcessed / progressTotal) * 100)) : 0

  useEffect(() => {
    if (!foldersOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!foldersRef.current?.contains(event.target as Node)) setFoldersOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFoldersOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [foldersOpen])

  const activeRootName =
    roots.find((root) => root.id === activeRootFilter)?.name ?? 'All Roots'

  return (
    <div className="shrink-0 space-y-1.5 border-b border-zinc-800 bg-zinc-900/95 px-0 pb-1.5">
      {/* Row 1: folders popover + search + status filter */}
      <div className="flex items-center gap-1">
        <div className="relative shrink-0" ref={foldersRef}>
          <button
            type="button"
            aria-expanded={foldersOpen}
            aria-haspopup="dialog"
            onClick={() => setFoldersOpen((prev) => !prev)}
            title={`Library folders — ${activeRootName} (${tracksCount} tracks indexed)`}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium ${
              activeRootFilter
                ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
                : 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            }`}
          >
            <ChevronDown className="h-3 w-3" />
            Folders ({roots.length})
          </button>

          {foldersOpen && (
            <div
              role="dialog"
              aria-label="Library folders"
              className="absolute left-0 top-full z-30 mt-1 w-64 space-y-1.5 rounded-md border border-zinc-700 bg-zinc-900 p-2 shadow-xl shadow-black/50"
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setFoldersOpen(false)
                    onAddRoot()
                  }}
                  disabled={scanning}
                  title="Add a library folder and scan it for supported audio files"
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderPlus className="h-3 w-3" />
                  Add Folder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFoldersOpen(false)
                    onScanAll()
                  }}
                  disabled={scanning || roots.length === 0 || !workerReady}
                  title={
                    workerReady
                      ? 'Rescan every library root for audio files and embedded lyrics'
                      : 'Rescan is unavailable until the tag worker is ready'
                  }
                  className="inline-flex items-center justify-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
                  {scanning ? 'Scanning...' : 'Scan All'}
                </button>
              </div>

              <div className="space-y-1 border-t border-zinc-800 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onActiveRootFilterChange('')
                    setFoldersOpen(false)
                  }}
                  className={`w-full truncate rounded px-1.5 py-1 text-left text-[11px] font-medium ${
                    activeRootFilter === ''
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  All Roots ({tracksCount})
                </button>

                {roots.length === 0 && (
                  <p className="px-1.5 py-1 text-[11px] text-zinc-500">
                    No library folders added yet.
                  </p>
                )}

                {roots.map((root) => {
                  const isActive = activeRootFilter === root.id
                  return (
                    <div
                      key={root.id}
                      className={`flex items-center gap-1 rounded px-1.5 py-1 ${
                        isActive
                          ? 'bg-emerald-950/60 text-emerald-200 ring-1 ring-inset ring-emerald-700/70'
                          : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      <button
                        type="button"
                        title={`${root.path}\nClick to filter the library by this folder`}
                        onClick={() => {
                          onActiveRootFilterChange(isActive ? '' : root.id)
                          setFoldersOpen(false)
                        }}
                        className="min-w-0 flex-1 truncate text-left text-[11px] font-medium"
                      >
                        {root.name}
                      </button>
                      <button
                        type="button"
                        title={`Rescan ${root.path}`}
                        disabled={scanning || !workerReady}
                        onClick={() => {
                          setFoldersOpen(false)
                          onScanRoot(root.id)
                        }}
                        className="shrink-0 text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title={`Remove ${root.path} from the library`}
                        disabled={scanning}
                        onClick={() => onRemoveRoot(root.id)}
                        className="shrink-0 text-zinc-400 hover:text-red-400 disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search title, artist, album..."
            title="Filter the library by title, artist, album, or file name"
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 py-1 pl-6 pr-6 text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          {search.length > 0 && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearchChange('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Row 2: status filter + counts + worker dot */}
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Filter by lyrics status"
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as TrackLyricsFilter)}
          title="Filter tracks by their lyrics state"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 focus:border-emerald-500 focus:outline-none"
        >
          <option value="all">All Status</option>
          <option value="missing">Missing Lyrics</option>
          <option value="synced">Synced LRC</option>
          <option value="plain">Plain Only</option>
          <option value="sidecar">.lrc Sidecar</option>
          <option value="draft">Has Draft</option>
        </select>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400">
          {filteredCount}/{tracksCount}
        </span>
        <span
          title={
            health?.ready
              ? `TagLib ${health.taglibVersion ?? ''} (PID ${health.workerPid ?? '?'})`
              : (health?.error ?? 'Worker initializing')
          }
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            workerReady ? 'bg-emerald-400' : 'bg-amber-400'
          }`}
        />
      </div>

      {scanning && scanProgress && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400">
            <span className="min-w-0 flex-1 truncate">
              Scanning: {scanProgress.currentPath ?? '...'}
            </span>
            <span className="shrink-0 tabular-nums">
              {progressProcessed}
              {progressTotal > 0 ? ` / ${progressTotal}` : ''}
              {scanProgress.errors ? ` (${scanProgress.errors} errors)` : ''}
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${progressTotal > 0 ? progressPercent : 35}%` }}
            />
          </div>
        </div>
      )}

      {/* Contextual batch bar: only when a multi-selection is active */}
      {selectedCount >= 2 && (
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-sky-900/70 bg-sky-950/40 px-1.5 py-1">
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-sky-200">
            {selectedCount} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onFetchSelected}
              disabled={activeFetchCount > 0}
              title={`Fetch lyrics for ${selectedCount} selected track(s) from LRCLIB or a sibling .lrc file`}
              className="inline-flex items-center gap-1 rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-3 w-3" />
              Fetch Selected
            </button>
            {activeFetchCount > 0 && (
              <button
                type="button"
                onClick={onCancelActiveFetches}
                title={`Cancel ${activeFetchCount} in-flight lyrics fetch(es).${
                  lastFetchError ? `\nLast fetch error — ${lastFetchError}` : ''
                }`}
                className="inline-flex items-center gap-1 rounded border border-red-800 bg-red-950/70 px-1.5 py-0.5 text-[10px] font-medium text-red-200 hover:bg-red-900/70"
              >
                <XCircle className="h-3 w-3" />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={onEmbedSelected}
              disabled={embedding || !workerReady}
              title="Atomically write lyrics to the selected files (unloads playback, closes media:// handles, restores mtime)"
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              {embedding ? 'Embedding...' : 'Embed Selected'}
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              title="Clear the current selection"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
