import { useState, useRef, useEffect } from 'react'
import {
  ChevronDown,
  Download,
  FolderPlus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import type { LibraryRoot, ScanProgress, TagEngineHealth } from '@shared/ipc'
import type { TrackLyricsFilter } from '@shared/trackSelection'
import { Popover } from './Popover'

export interface TopBarProps {
  health: TagEngineHealth | null
  roots: LibraryRoot[]
  activeRootFilter: string
  onActiveRootFilterChange: (rootId: string) => void
  tracksCount: number
  filteredCount: number
  scanning: boolean
  scanProgress: ScanProgress | null
  search: string
  onSearchChange: (value: string) => void
  statusFilter: TrackLyricsFilter
  onStatusFilterChange: (filter: TrackLyricsFilter) => void
  activeFetchCount: number
  onAddRoot: () => void
  onRemoveRoot: (rootId: string) => void
  onScanAll: () => void
  onScanRoot: (rootId: string) => void
  onOpenSettings: () => void
  workerReady: boolean
  selectedCount: number
}

/**
 * Single non-wrapping top bar with all library controls.
 * At <1000px, secondary labels collapse to icon+tooltip.
 */
export function TopBar({
  health,
  roots,
  activeRootFilter,
  onActiveRootFilterChange,
  tracksCount,
  filteredCount,
  scanning,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  activeFetchCount,
  onAddRoot,
  onRemoveRoot,
  onScanAll,
  onScanRoot,
  onOpenSettings
}: TopBarProps) {
  const [foldersOpen, setFoldersOpen] = useState(false)
  const foldersRef = useRef<HTMLDivElement | null>(null)

  const workerReady = Boolean(health?.ready)

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

  const activeRootName = roots.find((root) => root.id === activeRootFilter)?.name ?? 'All Roots'

  // Show full labels above 1000px, icon+tooltip below
  const showLabels = typeof window !== 'undefined' && window.innerWidth >= 1000

  return (
    <header className="flex shrink-0 h-[38px] items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/95 px-2">
      {/* Folders Popover */}
      <div className="relative shrink-0" ref={foldersRef}>
        <Popover
          label={showLabels ? `Folders (${roots.length})` : ''}
          title={`Library folders — ${activeRootName} (${tracksCount} tracks indexed)`}
          icon={<ChevronDown className="h-3 w-3" />}
          disabled={false}
          align="left"
        >
          {(close) => (
            <>
              <button
                type="button"
                aria-expanded={foldersOpen}
                aria-haspopup="dialog"
                onClick={() => setFoldersOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium ${
                  activeRootFilter
                    ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                <ChevronDown className="h-3 w-3" />
                {showLabels && `Folders (${roots.length})`}
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
                      aria-expanded={foldersOpen}
                      aria-haspopup="dialog"
                      onClick={() => { close(); onAddRoot(); }}
                      disabled={scanning}
                      title="Add a library folder and scan it for supported audio files"
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FolderPlus className="h-3 w-3" />
                      {showLabels && 'Add Folder'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { close(); onScanAll(); }}
                      disabled={scanning || roots.length === 0 || !workerReady}
                      title={
                        workerReady
                          ? 'Rescan every library root for audio files and embedded lyrics'
                          : 'Rescan is unavailable until the tag worker is ready'
                      }
                      className="inline-flex items-center justify-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
                      {showLabels && (scanning ? 'Scanning...' : 'Scan All')}
                    </button>
                  </div>

                  <div className="space-y-1 border-t border-zinc-800 pt-1">
                    <button
                      type="button"
                      onClick={() => { onActiveRootFilterChange(''); close(); }}
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
                              close()
                            }}
                            className="min-w-0 flex-1 truncate text-left text-[11px] font-medium"
                          >
                            {root.name}
                          </button>
                          <button
                            type="button"
                            title={`Rescan ${root.path}`}
                            disabled={scanning || !workerReady}
                            onClick={() => { close(); onScanRoot(root.id); }}
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
            </>
          )}
        </Popover>
      </div>

      {/* Search */}
      <div className="relative min-w-0 flex-1 max-w-[400px]">
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

      {/* Status Filter */}
      <select
        aria-label="Filter by lyrics status"
        value={statusFilter}
        onChange={(event) => onStatusFilterChange(event.target.value as TrackLyricsFilter)}
        title="Filter tracks by their lyrics state"
        className="shrink-0 min-w-[140px] max-w-[180px] rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 focus:border-emerald-500 focus:outline-none"
      >
        <option value="all">All Status</option>
        <option value="missing">Missing Lyrics</option>
        <option value="synced">Synced LRC</option>
        <option value="plain">Plain Only</option>
        <option value="sidecar">.lrc Sidecar</option>
        <option value="draft">Has Draft</option>
      </select>

      {/* Track Count */}
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400 hidden sm:inline">
        {filteredCount}/{tracksCount}
      </span>

      {/* Active Fetch Count */}
      {activeFetchCount > 0 && (
        <span className="shrink-0 inline-flex items-center gap-1 rounded border border-sky-700 bg-sky-950/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-200">
          <Download className="h-3 w-3 animate-spin" />
          {activeFetchCount}
        </span>
      )}

      {/* Settings */}
      <button
        type="button"
        onClick={onOpenSettings}
        title="AI provider settings (base URL, model, API key, target language)"
        aria-label="Open AI settings"
        className="shrink-0 rounded border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      {/* TagLib Health Dot */}
      <span
        title={
          health?.ready
            ? `TagLib ${health.taglibVersion ?? ''} (PID ${health.workerPid ?? '?'})`
            : (health?.error ?? 'Worker initializing')
        }
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${workerReady ? 'bg-emerald-400' : 'bg-amber-400'}`}
      />
    </header>
  )
}