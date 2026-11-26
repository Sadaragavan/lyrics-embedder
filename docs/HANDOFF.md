# Active Handoff

- Updated: 2026-11-26 14:05 IST
- Last agent: builder
- Branch: `arena/bae40d43-lyrics-embedder`
- Base commit: `9b4f114` (only commit in this repo; `docs/HANDOFF.md` previously recorded `7b32611`, which does not exist in history — checked with `git log -n 5 --oneline`)

## Current Goal
Stabilization + UI Refinement pass over Phase 4.5 / Phase 5 / v1.1 is complete and verified on Linux. Remaining: local Windows packaging + `--smoke-test`, interactive desktop walkthrough, and the Poweramp Android hardware spot-check.

## Completed Since Last Handoff
1. **Runtime loop fixes**: `App.tsx` keeps `handleMenuAction` in `handleMenuActionRef` (startup effect deps are now just `[applyFetchedCandidate]`, so `getHealth`/`getRoots`/`getTracks` and every IPC subscription no longer re-run per render); parsed player lines are memoized as `loadedTrackParsedLines` before the `playbackTimeMs` lookup so `parseLrc` no longer runs at 60fps; `src/main/menu.ts:updateMenuState` shallow-compares the sanitized snapshot via the new pure `menuStateEquals` and returns without `rebuildMenu()` on a no-op.
2. **`StreamRegistry` lifecycle**: `register()` resolves `closedPromise` and unregisters on `'close'`/`'error'` only (`'end'` fires before the OS descriptor closes); the duplicate `end`/`close` handlers in `createTrackedStream` were removed.
3. **UI (dynamic 1366x768)**: permanent top `LibraryToolbar` banner deleted (file removed) and replaced by `LibrarySidebar` in the sidebar header (search, status filter, scan progress, `Folders (N)` popover with Add Folder / per-root filter+rescan+remove / Scan All, and a batch bar only at `selectedCount >= 2`); `TrackTable` rows are 48px two-line virtualized cards (`leading-snug`, wide-script safe at 280px); `sidebarWidth` persists in `localStorage` clamped `[280, 720]`; transient messages float as a toast.
4. **Player**: full-width scrubber, quiet TagLib status dot (green ready / amber + error tooltip), synchronous ref-backed `onUnloadAudio` handler untouched.
5. **Editor**: `editorLayout` prop + `onModeChange` replace the duplicate local `activeTab`; raw/split/preview layouts; plain lyrics render cleanly in preview instead of an empty box; stacked secondary lines dimmer/smaller while all `findActiveLineIndices` indices highlight; single `Offset` popover (custom ms input + ±100/±500) and `Actions` popover; layers mode is full-height three-column with Swap/Clear, Preview Primary/Stacked and Apply Stacked to Primary; `find` is a full-height two-column sifter (single-row query bar, candidate cards with provider + Word/Synced/Plain/Instrumental badge + duration delta, pinned Load Primary / To Translation / To Romanization); Limusic-style footer with the `resolveLyricsSourceChip` source chip and Translation/Romanization visibility toggles. `EditorCommand`/`EditorCommandKind` removed.
6. **Matching/scoring**: `timingKind?` on `LyricsSearchResult`; `scoreCandidate` falls back to the raw title when cleaning empties it and takes the max artist similarity across `splitArtists(queryArtist)`; `evaluateCandidate` gates (REJECT `none`/`instrumental`/`score < 35`/delta `> 30s`; `ACCEPT_FINAL` for non-local `word`/`line` only at `score >= 70` with delta ≤ 5s or unknown; mid-confidence `KEEP_AS_FALLBACK`; local synced sidecars stay final); `preferWordSynced` defaults to `false`; LRCLIB breaks the variant loop on `RATE_LIMITED`/`NETWORK` and validates timestamps (`toSearchResult` downgrades invalid timing to plain and attaches `timingKind`); `lyrics:searchCandidates` prepends the sibling `.lrc` hit ahead of LRCLIB.
7. **Tests**: extended `providerRouter`, `trackMatching`, `lrclib`, `lyricsQueue`, `menu`; fixed `mediaProtocol` to use `VALID_TRACK_ID` (the old `valid-track-id` never reached `fs.stat`/`fs.open`); new `lyricsSourceChip` tests.

## Verification Status (Linux workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm test`: PASS (247 passed, 4 platform-skipped, 251 total, 15 files)
- `npm run build`: PASS
- NOT run here on purpose: `npm run build:unpack`, `dist:win`, and the packaged `--smoke-test` (Windows-only; no Electron binary in this container).

## Exact Next Step
1. On Windows after merge/pull: `npm ci` → `npm run build:unpack` → run `Poweramp LRC Embedder.exe --smoke-test`; confirm exit 0, `ready: true`, `2.5.1 (TagLib 2.3.2)`.
2. `npm run dev` walkthrough at 1366x768: verify no top chrome, sidebar resize clamp + reload persistence, 2-line rows with Tamil/Cyrillic metadata, scrubber spanning the dock, Offset/Actions popovers, plain lyrics preview, Find sifter sidecar-first ordering, and that the menu no longer re-renders in a loop (DevTools console quiet while playing).
3. Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`.

## Files in Scope
- `src/renderer/src/{App.tsx,types.ts}`, `src/renderer/src/components/{LibrarySidebar.tsx,TrackTable.tsx,LyricsEditorPanel.tsx,AudioPreviewPlayer.tsx,lyricsSourceChip.ts}`
- `src/main/{index.ts,menu.ts,mediaProtocol.ts}`, `src/main/providers/{router.ts,lrclib.ts,queue.ts}`, `src/shared/{types.ts,trackMatching.ts,menu.ts}`
- `tests/{providerRouter,trackMatching,lrclib,lyricsQueue,menu,mediaProtocol,lyricsSourceChip}.test.ts`

## Constraints / Open Blockers
- Physical Android device with Poweramp required for the hardware spot-check.
- This container has no Electron binary (download blocked) and no Xvfb, so the renderer was validated by `tsc`, the Tailwind build output, and transpile-time checks only; visual walkthrough must happen on a desktop.
