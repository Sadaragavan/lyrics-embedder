import {
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

export interface LibraryToolbarProps {
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
}

export function LibraryToolbar({
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
  onEmbedSelected
}: LibraryToolbarProps) {
  const progressTotal = scanProgress?.total ?? 0
  const progressProcessed = scanProgress?.processed ?? 0
  const progressPercent =
    progressTotal > 0 ? Math.min(100, Math.round((progressProcessed / progressTotal) * 100)) : 0
  const workerReady = Boolean(health?.ready)

  return (
    <header className="shrink-0 border-b border-zinc-800 bg-zinc-900/90 px-4 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-100 whitespace-nowrap">
            Poweramp LRC Embedder
          </h1>
          <span
            title={
              health?.ready
                ? `TagLib ${health.taglibVersion ?? ''} (PID ${health.workerPid ?? '?'})`
                : (health?.error ?? 'Worker initializing')
            }
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              workerReady
                ? 'border-emerald-800/80 bg-emerald-950/60 text-emerald-300'
                : 'border-amber-800/80 bg-amber-950/60 text-amber-300'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${workerReady ? 'bg-emerald-400' : 'bg-amber-400'}`}
            />
            {workerReady ? (health?.taglibVersion ?? 'TagLib Ready') : (health?.error ?? 'Starting')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onAddRoot}
            title="Add a library folder and scan it for supported audio files"
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            Add Folder
          </button>
          <button
            type="button"
            onClick={onScanAll}
            title={
              workerReady
                ? 'Rescan every library root for audio files and embedded lyrics'
                : 'Rescan is unavailable until the tag worker is ready'
            }
            disabled={scanning || roots.length === 0 || !workerReady}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? 'Scanning...' : 'Scan All'}
          </button>

          <div className="h-4 w-px bg-zinc-700 mx-0.5" />

          <button
            type="button"
            onClick={onFetchSelected}
            title={
              selectedCount === 0
                ? 'Select one or more tracks to fetch lyrics'
                : `Fetch lyrics for ${selectedCount} selected track(s) from LRCLIB or a sibling .lrc file`
            }
            disabled={selectedCount === 0 || activeFetchCount > 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            Fetch Selected ({selectedCount})
          </button>

          {activeFetchCount > 0 && (
            <button
              type="button"
              onClick={onCancelActiveFetches}
              title={`Cancel ${activeFetchCount} in-flight lyrics fetch(es) from LRCLIB or a sibling .lrc.${
                lastFetchError ? `\nLast fetch error — ${lastFetchError}` : ''
              }`}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-800 bg-red-950/70 px-2.5 py-1.5 text-xs font-medium text-red-200 hover:bg-red-900/70"
            >
              <XCircle className="h-3.5 w-3.5" />
              Cancel Fetch ({activeFetchCount})
            </button>
          )}

          <button
            type="button"
            onClick={onEmbedSelected}
            title="Atomically write lyrics to selected files (unloads playback, closes media:// handles, restores mtime)"
            disabled={selectedCount === 0 || embedding || !workerReady}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {embedding ? 'Embedding...' : `Embed Selected (${selectedCount})`}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {roots.length === 0 ? (
            <span className="text-xs text-zinc-500">No library folders added yet.</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onActiveRootFilterChange('')}
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  activeRootFilter === ''
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                All Roots ({tracksCount})
              </button>
              {roots.map((root) => {
                const isActive = activeRootFilter === root.id
                return (
                  <div
                    key={root.id}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                      isActive
                        ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                        : 'border-zinc-700/80 bg-zinc-800/70 text-zinc-300'
                    }`}
                  >
                    <button
                      type="button"
                      title={root.path}
                      onClick={() => onActiveRootFilterChange(isActive ? '' : root.id)}
                      className="max-w-[160px] truncate font-medium hover:underline"
                    >
                      {root.name}
                    </button>
                    <button
                      type="button"
                      title={`Rescan ${root.path}`}
                      disabled={scanning || !workerReady}
                      onClick={() => onScanRoot(root.id)}
                      className="text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title={`Remove ${root.path}`}
                      disabled={scanning}
                      onClick={() => onRemoveRoot(root.id)}
                      className="text-zinc-400 hover:text-red-400 disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search title, artist, album, file..."
              className="w-56 rounded-md border border-zinc-700 bg-zinc-950 py-1 pl-7 pr-6 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            {search.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onSearchChange('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <select
            aria-label="Filter by lyrics status"
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value as TrackLyricsFilter)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
          >
            <option value="all">All Status</option>
            <option value="missing">Missing Lyrics</option>
            <option value="synced">Synced LRC</option>
            <option value="plain">Plain Only</option>
            <option value="sidecar">.lrc Sidecar</option>
            <option value="draft">Has Draft</option>
          </select>

          <span className="text-[11px] tabular-nums text-zinc-400 whitespace-nowrap">
            {filteredCount}/{tracksCount}
          </span>
        </div>
      </div>

      {scanning && scanProgress && (
        <div className="space-y-1 pt-0.5">
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <span className="truncate max-w-[75%]">
              Scanning: {scanProgress.currentPath ?? '...'}
            </span>
            <span className="tabular-nums shrink-0">
              {progressProcessed}
              {progressTotal > 0 ? ` / ${progressTotal}` : ''}
              {scanProgress.errors ? ` (${scanProgress.errors} errors)` : ''}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${progressTotal > 0 ? progressPercent : 35}%` }}
            />
          </div>
        </div>
      )}
    </header>
  )
}
