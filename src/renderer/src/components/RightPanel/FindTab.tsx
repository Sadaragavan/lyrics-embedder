import { useMemo, useState } from 'react'
import { Loader2, Search, Settings } from 'lucide-react'
import type { LyricsSearchResult, TrackRecord, LyricsProviderFilter } from '@shared/ipc'
import {
  providerLabel,
  timingBadge,
  durationDeltaLabel,
  hasTranslationLayer,
  hasRomanizationLayer,
  candidateKey
} from './findTabUtils'

interface FindTabProps {
  focusedTrack: TrackRecord | null
  searchTitle: string
  onSearchTitleChange: (value: string) => void
  searchArtist: string
  onSearchArtistChange: (value: string) => void
  searchAlbum: string
  onSearchAlbumChange: (value: string) => void
  searchDuration: string
  onSearchDurationChange: (value: string) => void
  searchResults: LyricsSearchResult[]
  searchLoading: boolean
  searchError: string | null
  searchSearched: boolean
  onSearchCandidates: () => void
  onLoadCandidate: (result: LyricsSearchResult) => void
  onLoadAllLayers: (result: LyricsSearchResult) => void
  providerFilter: LyricsProviderFilter
  onProviderFilterChange: (filter: LyricsProviderFilter) => void
  onOpenSettings: () => void
  onTranslationChange: (text: string) => void
  onRomanizationChange: (text: string) => void
}

function CandidateSiftingRow({
  result,
  focusedDurationSec,
  selected,
  onSelect
}: {
  result: LyricsSearchResult
  focusedDurationSec: number
  selected: boolean
  onSelect: () => void
}) {
  const badge = timingBadge(result)
  const delta = result.durationSec > 0 && focusedDurationSec > 0 ? Math.round(result.durationSec - focusedDurationSec) : null

  const hasTranslation = hasTranslationLayer(result)
  const hasRomanization = hasRomanizationLayer(result)

  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        title={`${result.title} — ${result.artist || 'Unknown Artist'}${result.album ? ` (${result.album})` : ''}`}
        className={`w-full space-y-0.5 rounded border px-2 py-1.5 text-left transition-colors ${
          selected
            ? 'border-emerald-700/80 bg-emerald-950/40'
            : 'border-zinc-800 bg-zinc-900/80 hover:bg-zinc-800/80'
        }`}
      >
        <div className="flex items-center gap-1">
          <span className="shrink-0 rounded border border-sky-800/70 bg-sky-950/60 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
            {providerLabel(result.providerId)}
          </span>
          <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium ${badge.className}`}>
            {badge.label}
          </span>
          {hasTranslation && (
            <span title="Ships a bundled translation layer" className="shrink-0 rounded border border-sky-800/70 bg-sky-950/60 px-1 py-0.5 text-[9px] font-semibold text-sky-300">
              +T
            </span>
          )}
          {hasRomanization && (
            <span title="Ships a bundled romanization layer" className="shrink-0 rounded border border-violet-800/70 bg-violet-950/60 px-1 py-0.5 text-[9px] font-semibold text-violet-300">
              +R
            </span>
          )}
          <span
            title="Duration difference against the focused track"
            className={`ml-auto shrink-0 font-mono text-[10px] tabular-nums ${
              delta !== null && Math.abs(delta) > 30
                ? 'text-red-300'
                : delta !== null && Math.abs(delta) > 5
                  ? 'text-amber-300'
                  : 'text-zinc-400'
            }`}
          >
            {durationDeltaLabel(result, focusedDurationSec)}
          </span>
        </div>
        <div className="truncate text-[11px] font-medium leading-snug text-zinc-200">
          {result.title || 'Untitled'}
        </div>
        <div className="truncate text-[10px] leading-snug text-zinc-400">
          {[result.artist || 'Unknown Artist', result.album].filter(Boolean).join(' — ')}
        </div>
      </button>
    </li>
  )
}

export function FindTab({
  focusedTrack,
  searchTitle,
  onSearchTitleChange,
  searchArtist,
  onSearchArtistChange,
  searchAlbum,
  onSearchAlbumChange,
  searchDuration,
  onSearchDurationChange,
  searchResults,
  searchLoading,
  searchError,
  searchSearched,
  onSearchCandidates,
  onLoadCandidate,
  onLoadAllLayers,
  providerFilter,
  onProviderFilterChange,
  onOpenSettings,
  onTranslationChange,
  onRomanizationChange
}: FindTabProps) {
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null)

  const visibleResults = useMemo(
    () =>
      providerFilter === 'all'
        ? searchResults
        : searchResults.filter((result) => result.providerId === providerFilter),
    [searchResults, providerFilter]
  )

  const selectedCandidateIndex = (() => {
    if (visibleResults.length === 0) return -1
    const found = visibleResults.findIndex((result, index) => candidateKey(result, index) === selectedCandidateKey)
    return found >= 0 ? found : 0
  })()

  const selectedCandidate = selectedCandidateIndex >= 0 ? visibleResults[selectedCandidateIndex] : null
  const selectedCandidateLyrics = selectedCandidate?.syncedLyrics ?? selectedCandidate?.plainLyrics ?? ''

  if (!focusedTrack) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/70 p-6 text-center">
        <p className="text-sm font-medium text-zinc-300">No track focused</p>
        <p className="mt-1 text-xs text-zinc-500">Click a track row to search for lyrics.</p>
      </section>
    )
  }

  function handleSendToTranslation() {
    if (selectedCandidateLyrics) onTranslationChange(selectedCandidateLyrics)
  }

  function handleSendToRomanization() {
    if (selectedCandidateLyrics) onRomanizationChange(selectedCandidateLyrics)
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
      {/* Find content */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2.5">
        {/* Query Bar */}
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <input
            type="text"
            value={searchTitle}
            onChange={(event) => onSearchTitleChange(event.target.value)}
            placeholder="Title"
            title="Search title override (pre-filled from the focused track)"
            className="min-w-0 flex-[2] rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />
          <input
            type="text"
            value={searchArtist}
            onChange={(event) => onSearchArtistChange(event.target.value)}
            placeholder="Artist"
            title="Search artist override (pre-filled from the focused track)"
            className="min-w-0 flex-[1.5] rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />
          <input
            type="text"
            value={searchAlbum}
            onChange={(event) => onSearchAlbumChange(event.target.value)}
            placeholder="Album"
            title="Search album override (pre-filled from the focused track)"
            className="min-w-0 flex-[1.5] rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />
          <input
            type="text"
            inputMode="decimal"
            value={searchDuration}
            onChange={(event) => onSearchDurationChange(event.target.value)}
            placeholder="Sec"
            title="Search duration in seconds (pre-filled from the focused track)"
            className="w-14 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={onSearchCandidates}
            disabled={searchLoading}
            title="Query the sibling .lrc, LRCLIB, and NetEase (sequential, paced requests with Retry-After handling)"
            className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {searchLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Search className="h-3 w-3" />
            )}
            {searchLoading ? 'Searching...' : 'Search'}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="AI provider settings (base URL, model, API key, target language)"
            aria-label="Open AI settings"
            className="shrink-0 rounded border border-zinc-700 bg-zinc-800 p-1 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Provider Filter Pills */}
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'localSidecar', label: 'Local' },
              { id: 'lrclib', label: 'LRCLIB' },
              { id: 'netease', label: 'NetEase' }
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={providerFilter === entry.id}
              onClick={() => onProviderFilterChange(entry.id)}
              title={entry.id === 'all' ? 'Search every provider' : `Search only ${entry.label}`}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                providerFilter === entry.id
                  ? 'border-emerald-700 bg-emerald-950/60 text-emerald-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
          {visibleResults.length !== searchResults.length && (
            <span className="ml-1 text-[10px] text-zinc-500">
              {visibleResults.length} of {searchResults.length}
            </span>
          )}
        </div>

        {!searchLoading && searchError && (
          <p className="shrink-0 truncate text-[11px] text-red-300" title={searchError}>
            {searchError}
          </p>
        )}

        {/* Candidate Sifter */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-2">
          {/* Candidates List */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
              <span>Candidates</span>
              <span className="tabular-nums">
                {searchLoading ? 'searching…' : `${visibleResults.length}`}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {visibleResults.length > 0 ? (
                <ul className="space-y-1">
                  {visibleResults.map((result, index) => {
                    const key = candidateKey(result, index)
                    return (
                      <CandidateSiftingRow
                        key={key}
                        result={result}
                        focusedDurationSec={focusedTrack.durationSec}
                        selected={index === selectedCandidateIndex}
                        onSelect={() => setSelectedCandidateKey(key)}
                      />
                    )
                  })}
                </ul>
              ) : searchSearched && !searchLoading ? (
                <p className="p-2 text-[11px] text-zinc-500">
                  {searchResults.length > 0
                    ? 'No candidates from this provider. Try the All filter.'
                    : 'No candidates matched those fields. Adjust the search and try again.'}
                </p>
              ) : (
                <p className="p-2 text-[11px] text-zinc-500">
                  Press Search to list a sibling `.lrc` first, then LRCLIB matches.
                </p>
              )}
            </div>
          </div>

          {/* Preview + Actions */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-2 py-1">
              <span className="min-w-0 truncate text-[11px] font-medium text-zinc-300">
                {selectedCandidate
                  ? `${providerLabel(selectedCandidate.providerId)} — ${selectedCandidate.title}`
                  : 'Live lyric preview'}
              </span>
              {selectedCandidate && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                  {durationDeltaLabel(selectedCandidate, focusedTrack.durationSec)}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
                {selectedCandidate
                  ? selectedCandidateLyrics || '(no lyrics payload — instrumental)'
                  : 'Select a candidate to preview its lyrics here.'}
              </pre>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-zinc-800 p-1.5">
              <button
                type="button"
                disabled={!selectedCandidateLyrics}
                onClick={() => selectedCandidate && onLoadCandidate(selectedCandidate)}
                title="Replace the primary LRC with this candidate's synced (or plain) lyrics and save the draft"
                className="rounded border border-emerald-700/80 bg-emerald-950/60 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Load Primary
              </button>
              {selectedCandidate &&
                (hasTranslationLayer(selectedCandidate) || hasRomanizationLayer(selectedCandidate)) && (
                  <button
                    type="button"
                    onClick={() => onLoadAllLayers(selectedCandidate!)}
                    title="Load this candidate's primary lyrics plus its bundled translation and romanization layers, then save the draft"
                    className="rounded border border-sky-700/80 bg-sky-950/60 px-2 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-900/60"
                  >
                    Load All Layers
                    {hasTranslationLayer(selectedCandidate) ? ' +T' : ''}
                    {hasRomanizationLayer(selectedCandidate) ? ' +R' : ''}
                  </button>
                )}
              <button
                type="button"
                disabled={!selectedCandidateLyrics}
                onClick={() => handleSendToTranslation()}
                title="Put this candidate's lyrics into the translation layer (keeps the primary untouched)"
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                To Translation
              </button>
              <button
                type="button"
                disabled={!selectedCandidateLyrics}
                onClick={() => handleSendToRomanization()}
                title="Put this candidate's lyrics into the romanization layer (keeps the primary untouched)"
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                To Romanization
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}