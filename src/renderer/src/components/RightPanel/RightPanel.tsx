import { TrackHeader } from './TrackHeader'
import { TabBar } from './TabBar'
import { LyricsTab } from './LyricsTab'
import { TextTab } from './TextTab'
import { FindTab } from './FindTab'
import type { TrackRecord } from '@shared/ipc'
import type { EditorState } from '@shared/editorState'
import type { LyricsSearchResult, LyricsProviderFilter, AiJobState, LyricsFetchProgress } from '@shared/ipc'

interface RightPanelProps {
  focusedTrack: TrackRecord | null
  editorState: EditorState | null
  focusedEditorState: EditorState | null
  playbackTimeMs: number
  loadedTrackId: string | null
  preserveWordTags: boolean
  onPreserveWordTagsChange: (value: boolean) => void
  onLyricsChange: (nextLyrics: string) => void
  onTranslationChange: (text: string) => void
  onRomanizationChange: (text: string) => void
  onSeekToMs: (trackId: string, timeMs: number) => void
  onImportLrc: () => void
  onRevert: () => void
  onEmbedFocused: () => void
  onNormalize: () => void
  onPreviewTextChange: (trackId: string, text: string) => void
  workerReady: boolean
  embedStatus: { phase: 'idle' | 'embedding' | 'verified' | 'error'; targetPath?: string; lyricsSource?: string; error?: string } | undefined
  fetchProgress: LyricsFetchProgress | undefined
  aiJob: AiJobState | null
  onAiGenerate: (mode: 'translation' | 'romanization') => void
  onAiCancel: () => void
  onOpenSettings: () => void
  aiConfigured: boolean
  // Search state
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
  // Layer visibility
  showTranslationLayer: boolean
  onShowTranslationLayerChange: (value: boolean) => void
  showRomanizationLayer: boolean
  onShowRomanizationLayerChange: (value: boolean) => void
  // Stacked output
  stackedOutput: string
  // Workspace mode
  workspaceMode: 'lyrics' | 'text' | 'find'
  onWorkspaceModeChange: (mode: 'lyrics' | 'text' | 'find') => void
}

export function RightPanel({
  focusedTrack,
  focusedEditorState,
  playbackTimeMs,
  loadedTrackId,
  preserveWordTags,
  onPreserveWordTagsChange,
  onLyricsChange,
  onTranslationChange,
  onRomanizationChange,
  onSeekToMs,
  onImportLrc,
  onRevert,
  onEmbedFocused,
  onNormalize,
  onPreviewTextChange,
  workerReady,
  embedStatus,
  fetchProgress,
  aiJob,
  onAiGenerate,
  onAiCancel,
  onOpenSettings,
  aiConfigured,
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
  showTranslationLayer,
  onShowTranslationLayerChange,
  showRomanizationLayer,
  onShowRomanizationLayerChange,
  stackedOutput,
  workspaceMode,
  onWorkspaceModeChange
}: RightPanelProps) {
  const isEmbedding = embedStatus?.phase === 'embedding'

  // Compute derived values
  const secondaryLayerText = focusedEditorState?.translation.text ?? ''
  const romanizationLayerText = focusedEditorState?.romanization.text ?? ''
  const hasTranslation = secondaryLayerText.trim().length > 0
  const hasRomanization = romanizationLayerText.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Track Header */}
      <TrackHeader
        focusedTrack={focusedTrack}
        hasDraft={Boolean(focusedTrack?.draftId) || (focusedEditorState?.dirty ?? false)}
        isDirty={focusedEditorState?.dirty ?? false}
        saveState={focusedEditorState?.saveState ?? 'idle'}
        onRevert={onRevert}
        onEmbedFocused={onEmbedFocused}
        workerReady={workerReady}
        isEmbedding={isEmbedding}
        showTranslationLayer={showTranslationLayer}
        showRomanizationLayer={showRomanizationLayer}
        hasTranslation={hasTranslation}
        hasRomanization={hasRomanization}
      />

      {/* Tab Bar */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900 px-3 py-1">
        <TabBar
          activeTab={workspaceMode}
          onTabChange={onWorkspaceModeChange}
          hasTrack={!!focusedTrack}
        />
      </div>

      {/* Tab Content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {workspaceMode === 'lyrics' && (
          <LyricsTab
            focusedTrack={focusedTrack}
            editorState={focusedEditorState}
            playbackTimeMs={playbackTimeMs}
            loadedTrackId={loadedTrackId}
            preserveWordTags={preserveWordTags}
            onPreserveWordTagsChange={onPreserveWordTagsChange}
            onLyricsChange={onLyricsChange}
            onTranslationChange={onTranslationChange}
            onRomanizationChange={onRomanizationChange}
            onSeekToMs={onSeekToMs}
            onImportLrc={onImportLrc}
            onNormalize={onNormalize}
            onPreviewTextChange={onPreviewTextChange}
            fetchProgress={fetchProgress}
            aiJob={aiJob}
            onAiGenerate={onAiGenerate}
            onAiCancel={onAiCancel}
            onOpenSettings={onOpenSettings}
            aiConfigured={aiConfigured}
            showTranslationLayer={showTranslationLayer}
            onShowTranslationLayerChange={onShowTranslationLayerChange}
            showRomanizationLayer={showRomanizationLayer}
            onShowRomanizationLayerChange={onShowRomanizationLayerChange}
          />
        )}

        {workspaceMode === 'text' && (
          <TextTab
            focusedTrack={focusedTrack}
            editorState={focusedEditorState}
            preserveWordTags={preserveWordTags}
            onPreserveWordTagsChange={onPreserveWordTagsChange}
            onLyricsChange={onLyricsChange}
            onTranslationChange={onTranslationChange}
            onRomanizationChange={onRomanizationChange}
            onImportLrc={onImportLrc}
            onNormalize={onNormalize}
            onApplyStacked={() => {
              if (stackedOutput) onLyricsChange(stackedOutput)
            }}
            onAiGenerate={onAiGenerate}
            onAiCancel={onAiCancel}
            onOpenSettings={onOpenSettings}
            aiJob={aiJob}
            aiConfigured={aiConfigured}
            showTranslationLayer={showTranslationLayer}
            showRomanizationLayer={showRomanizationLayer}
            stackedOutput={stackedOutput}
            hasTranslation={hasTranslation}
            hasRomanization={hasRomanization}
          />
        )}

        {workspaceMode === 'find' && (
          <FindTab
            focusedTrack={focusedTrack}
            searchTitle={searchTitle}
            onSearchTitleChange={onSearchTitleChange}
            searchArtist={searchArtist}
            onSearchArtistChange={onSearchArtistChange}
            searchAlbum={searchAlbum}
            onSearchAlbumChange={onSearchAlbumChange}
            searchDuration={searchDuration}
            onSearchDurationChange={onSearchDurationChange}
            searchResults={searchResults}
            searchLoading={searchLoading}
            searchError={searchError}
            searchSearched={searchSearched}
            onSearchCandidates={onSearchCandidates}
            onLoadCandidate={onLoadCandidate}
            onLoadAllLayers={onLoadAllLayers}
            providerFilter={providerFilter}
            onProviderFilterChange={onProviderFilterChange}
            onOpenSettings={onOpenSettings}
            onTranslationChange={onTranslationChange}
            onRomanizationChange={onRomanizationChange}
          />
        )}
      </div>
    </div>
  )
}