# Active Handoff

- Updated: 2026-11-27 14:30 IST
- Last agent: builder
- Branch: `fix/editor-state-and-ui`
- Base commit: `03de30c` (verified with `git log -n 1 --format=%h -- . ":(exclude)docs/"`)

## Current Goal
Phase 2A UI overhaul complete. The monolithic `LyricsEditorPanel.tsx` has been split into a hook-based architecture with 7 new hooks and ~18 new components. All Phase 1 Pass A invariants preserved.

## Completed Since Last Handoff (Phase 2A)

### Type System Updates
- `WorkspaceMode`: `'lyrics' | 'text' | 'find'` (replacing `'edit' | 'layers' | 'find'`)
- Removed obsolete `EditorLayout` type entirely
- `MENU_ACTIONS`: removed `layout-live`/`layout-raw`, added `mode-lyrics`/`mode-text`
- `src/shared/menu.ts`: checkbox label changed to `Keep Word Timestamps`
- `tests/menu.test.ts`: updated for new WorkspaceMode/actions, verified absence of `editorLayout`/Editor Layout submenu
- `tests/hookOrder.test.ts`: updated to test `RightPanel` with new WorkspaceMode values, added `trackId` to mock `EditorState`

### New Hooks (7 files under `src/renderer/src/hooks/`)
- `useEditorState.ts` — per-track editor state management
- `useDraftPersistence.ts` — auto-save, flush, revert (per-track save state in `EditorState.saveState`)
- `useLyricsSearch.ts` — search state, candidate fetching, `flushAutoSave` integration
- `useAiGeneration.ts` — AI translation/romanization (track-scoped, no cross-track race)
- `useSidebarState.ts` — sidebar width/visibility/drag (single source of truth)
- `useMenuSync.ts` — menu state synchronization (uses `sidebarState.sidebarVisible`)
- `useVirtualTracks.ts` — virtualized track list wrapper

### New Components (~18 files under `src/renderer/src/components/`)
- `TopBar.tsx` — single non-wrapping top bar (folders popover, search, status filter, fetch count, settings, TagLib health dot)
- `LibrarySidebar/LibrarySidebar.tsx` — virtualized track list + batch bar (scan progress, draft badges, fetch/embed actions)
- `TrackTable/TrackTable.tsx` + `StatusPill.tsx` — virtualized rows with selection, status pills
- `RightPanel/RightPanel.tsx` — shell with TrackHeader, TabBar, tab routing
- `RightPanel/TrackHeader.tsx` — unified save indicator, Revert (inline confirm), Embed button
- `RightPanel/TabBar.tsx` — Lyrics | Text | Find tabs
- `RightPanel/ContextualToolbar.tsx` — Offset, Normalize, Import, Send/Swap, AI actions
- `RightPanel/LyricsTab.tsx` — full-width synced list editor (live rows, editable timestamps, stacked preview)
- `RightPanel/TextTab.tsx` — 3-col wide / tabbed narrow layer editors (inline Clear confirm, Apply Stacked)
- `RightPanel/FindTab.tsx` — query bar, provider pills, candidates list, preview, `Load Primary` / `Load All Layers` / `To Translation` / `To Romanization`
- `RightPanel/LayerTabs.tsx` — layer switching for narrow Text tab
- `RightPanel/findTabUtils.ts` — shared utilities (`providerLabel`, `timingBadge`, `durationDeltaLabel`, `hasTranslationLayer`, `hasRomanizationLayer`, `candidateKey`)
- `AudioPreviewPlayer.tsx` — two-row fixed dock (~108px): Row 1 (64px) 3 stacked lines; Row 2 (44px) transport + scrubber
- `Popover.tsx`, `AiLayerButton.tsx` — shared primitives

### Removed
- Obsolete `LyricsEditorPanel.tsx` (monolithic editor)
- `EditorLayout` type and all references (`layout-live`/`layout-raw`, `editorLayout` field in `MenuSyncState`)

### App.tsx Rewire
- Replaced ~1600-line monolith with hook-based architecture
- Global `autoSaveState` / `setAutoSaveState` removed — per-track save indicator now derived from `EditorState.saveState`
- Local `sidebarVisible` / `setSidebarVisible` removed — use `sidebarState.sidebarVisible` / `sidebarState.setSidebarVisible`
- `providerFilter` state removed — sourced from `useLyricsSearch` hook
- `handleRevertToEmbedded` called with `focusedTrackId` guard
- `health` prop removed from `<AudioPreviewPlayer />` (TagLib health in TopBar only)
- `hasTranslation` / `hasRomanization` removed from `<RightPanel />` (derived from `editorState` in RightPanel)

### Type Additions
- `LyricsProviderFilter`, `AiJobState`, `TrackEmbedStatus`, `TrackEmbedPhase` added to `src/shared/types.ts` and exported from `src/shared/ipc.ts`

## Verification Status (Windows workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm run lint`: PASS (0 errors, 10 warnings - all `react-hooks/exhaustive-deps`)
- `npm test`: PASS (430 tests, 23 files including hookOrder)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- `& ".\release\win-unpacked\Poweramp LRC Embedder.exe" --smoke-test`: PASS (`ready: true`)

## Exact Next Step (Phase 2B)
1. Create `tests/e2e/` with Playwright + mock HTTP servers (LRCLIB, NetEase), fixture audio (`.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`)
2. Implement 7 data-safety E2E tests: local .lrc import/embed round-trip, LRCLIB fetch/embed round-trip, NetEase layered fetch/embed, AI translate/romanize writes only secondary layer, Revert restores embedded lyrics, Concurrent embeds (Windows file lock release), Draft persistence survives app restart
3. Screenshot matrix: empty library, focused track (Lyrics/Text/Find tabs), sidebar batch bar, settings modal, error boundary
4. Run `npm run test:e2e` and verify all pass
5. Update `docs/HANDOFF.md` with Phase 2B results

## Constraints
- Do NOT push, merge, or start Phase 2B until explicit instruction
- Physical Android device with Poweramp required for hardware spot-check in Phase 2B