# Progress

## Current Phase
Phase 2A (Renderer Architecture Refactor) and Phase 2B (Playwright E2E Suite) complete on Windows. The monolithic `LyricsEditorPanel.tsx` has been split into a hook-based architecture (7 hooks, ~18 components). The 26/26 E2E test suite validates data-safety invariants with mock LRCLIB/NetEase providers and captures a 3-viewport layout matrix.

## Previously
Pass B (Multi-Layer Lyric Sources + Opt-In AI Translation/Romanization) implemented and verified on Linux. Stabilization + UI Refinement complete with correct `media://` stream lifecycle, dynamic 1366x768 UI with zero permanent top chrome, and unified live editor. v1.1 matching enforces real confidence gates.

## Milestones
- [x] Phase 0: Clean-slate workspace, dependencies installed, multi-agent docs and handoff skill installed.
- [x] Phase 1: Minimal Electron + React shell, `utilityProcess` + `taglib-wasm` WASI init, `tagger.ts` atomic Windows-safe read/write, Vitest round-trip tag fixture tests, passing `npm run build:unpack` smoke gate.
- [x] Phase 2: Recursive folder scanner, atomic JSON `library-index.json` + draft store, HTTP 206 `media://` protocol with handle registry, startup `*.lrcembed.*.tmp.*` sweep.
- [x] Phase 2.5: Security and lock-safety hardening (`trackId` hex validation, `StreamRegistry` OS handle destruction + `'close'` await, `Cache-Control: no-store`, `JsonStore` write queue, `realpath`/empty-root containment, ref-counted `activeTargetDirs`, worker RPC timeouts, scanner temp exclusion).
- [x] Phase 3: LRC parser/normalizer (`src/shared/lrc.ts`), `LyricsProvider` queue (LRCLIB + sibling `.lrc`), stacked translation/romanization support.
- [x] Phase 4 (UI): Virtualized track table (`@tanstack/react-virtual`), `<audio>` timestamp preview/scrubber with `onUnloadAudio` handshake, raw/stacked LRC editor + fetch/embed workflows.
- [x] Phase 4.5 (UI polish): Collapsible Candidate Sifter, focus-prefilled search fields, per-result Load Primary / To Translation / To Romanization, send/swap toolbar, Primary Only / Stacked Preview toggle, tooltips.
- [x] Phase 5: Native app menu, dynamic workspace (collapsible sidebar, Edit/Layers/Find mode bar), compact track rows, three-mode editor, bottom-dock player.
- [x] v1.1: Query normalizer + multi-factor matcher, timing detection, SelectionDecision router, LRCLIB variant walking, queue routing. Tests: `trackMatching.test.ts`, `providerRouter.test.ts`, extended `lrc`/`lrclib`/`lyricsQueue`/`localSidecar` tests.
- [x] Stabilization + UI Refinement: menu-action ref, memoized `loadedTrackParsedLines`, `menuStateEquals` no-op guard, `StreamRegistry` resolves on `close`/`error`, zero top chrome, 48px two-line virtualized cards, persisted `sidebarWidth`, full-width scrubber, `editorLayout` single source of truth, three-column layers, two-column Find sifter, router confidence gates.
- [x] Pass A (UX Cleanup & Unified Live Editor): `src/shared/lrcEditor.ts` row model, multi-layer draft persistence with 1 MiB cap, `EditorLayout = 'live' | 'raw'`, 500 ms debounced auto-save, floating toasts replaced by player-dock status slot, unified live editor with clickable timestamp pills, inline layer sub-rows, auto-run Find search, sidebar-only `Fetch Selected`.
- [x] Pass B (NetEase + opt-in AI layers): `LyricsProviderId` gains `netease`; `NeteaseProvider` (concurrency=1, >=500ms pacing, `AbortSignal`, bounded 429/503 backoff, `Referer`/`User-Agent`, `lrc`/`tlyric`/`romalrc` extraction, top-5 lyric-fetch cap); `translatedLyrics`/`romanizedLyrics` on candidates/results persisted into drafts; `LyricsSearchRequest.providerIds` + Find provider pills and `+T`/`+R` badges and `Load All Layers`; sequential `lyrics:searchCandidates` tolerating partial provider failure; encrypted `userData/settings.json` (`0600`, injected `SecretCipher`, `hasApiKey` only); async-only `safeStorage` with Linux `basic_text` rejection; `aiTranslator.ts` single-flight `/chat/completions` with 60s timeout; pure `src/shared/aiTranslate.ts` re-attaches original timestamps; `SettingsModal` (5 presets, write-only key) via `File > Settings…` / `Ctrl+,`; `AI Translate`/`AI Romanize` with inline Cancel; AI jobs aborted on `before-quit`.
- [x] **Phase 2A (Renderer Architecture Refactor):** Split `LyricsEditorPanel.tsx` into 7 hooks (`useEditorState`, `useDraftPersistence`, `useLyricsSearch`, `useAiGeneration`, `useSidebarState`, `useMenuSync`, `useVirtualTracks`) and ~18 components (`TopBar`, `LibrarySidebar`, `TrackTable`, `RightPanel` with TrackHeader/TabBar/ContextualToolbar/LyricsTab/TextTab/FindTab/LayerTabs, `AudioPreviewPlayer`, `Popover`, `AiLayerButton`). Removed `EditorLayout` type, global `autoSaveState`, local `sidebarVisible`. Type updates: `WorkspaceMode` (`lyrics|text|find`), `LyricsProviderFilter`, `AiJobState`, `TrackEmbedStatus`, `TrackEmbedPhase`.
- [x] **Phase 2B (Playwright E2E Suite):** Created `tests/e2e/` with Playwright + mock HTTP servers (LRCLIB, NetEase). 7 data-safety E2E tests: layer isolation across track switch, idempotent embed (no duplicate lines), batch embed preserves non-focused track layers (Test 5), embed during playback unloads audio and completes cleanly without seek replay (Test 6), zero console errors, focus without crash, no draft on focus. 18 layout screenshot tests across 3 viewports (1366x690, 1120x700, 840x690) covering empty states, Lyrics/Text/Find tabs, narrow overflow checks. Fixture audio uses real tracked files from `tests/fixtures/` (`.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`). All 26/26 tests passing.
- [ ] Phase 4 (Verification): Interactive desktop walkthrough and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc`.

## Verification (Phase 2A + 2B, Windows workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm run lint`: PASS (0 errors, 11 pre-existing `react-hooks/exhaustive-deps` warnings)
- `npm test`: PASS (430 tests, 23 files including hookOrder)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- `& ".\release\win-unpacked\Poweramp LRC Embedder.exe" --smoke-test`: PASS (`ready: true`)
- `npm run test:e2e`: PASS (26/26 tests)

## Verification (Pass B, Linux workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm test`: PASS (364 passed, 4 skipped, 20 files)
- `npm run build`: PASS
- `npm run build:unpack` / `--smoke-test`: NOT run (Windows-only; see `docs/HANDOFF.md`)

## Verified Technical Findings
- Electron 45's `safeStorage` exposes only async encrypt/decrypt in the main process (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync` returning `{ result, shouldReEncrypt }`); synchronous `encryptString`/`decryptString` are deprecated. On Linux, `getSelectedStorageBackend() === 'basic_text'` means effectively hardcoded key — treat as unavailable.
- `safeStorage.decryptStringAsync`'s `shouldReEncrypt` means "call decrypt again for the re-keyed value"; cipher adapter surfaces it and `SettingsStore` re-encrypts once and rewrites `settings.json` to converge.
- NetEase returns search durations in milliseconds and lyric layers as `{ lrc: { lyric }, tlyric: { lyric }, romalrc: { lyric } }`; layers without `[mm:ss.xx]` stamps must be dropped or they stack at the wrong position.
- `scoreCandidate` awards timing bonus even for wrong track; wrong-song rejection only bites when duration/album mismatches also present. Test fixtures must vary duration or album, not just title/artist.
- `taglib-wasm@2.5.1` ships `dist/taglib-wasi.wasm` and `dist/taglib-web.wasm`, but `package.json` `exports` does not expose `./dist/taglib-wasi.wasm`. Dev mode must resolve `taglib-wasm` root via `fileURLToPath(import.meta.resolve('taglib-wasm'))` and join `'taglib-wasi.wasm'`.
- `npm install-scripts deny electron-winstaller` is active; do not approve unless Squirrel.Windows builds are introduced.
- In `taglib-wasm@2.5.1` WASI mode, `audioFile.properties()` strips `"lyrics"` (`"LYRICS"`) while still returning custom `"LYRICS:*"` keys (MP3 `USLT` frames with custom descriptions), whereas `audioFile.getLyrics()` only reads bare `"LYRICS"`. Reading must check both `getLyrics()` and `LYRICS:*` keys in `properties()`, and writing must strip all `LYRICS` / `LYRICS:*` keys before calling `setProperty('LYRICS', ...)` to avoid duplicate `USLT` frames.
- Node's `Readable` emits `'end'` when readable side consumed but `'close'`/`'error'` only when descriptor released; `StreamRegistry` must await `'close'` before embed swap, otherwise Windows can still hold the file handle.
- Passing `{ ...defaults }`/template literals into memoized `useEffect` dependency created loop: startup effect depended on `handleMenuAction`, re-created each render, so IPC subscriptions re-ran at render frequency. Ref indirection plus `menuStateEquals` fix both halves.
- `electron-vite` `?modulePath` + `utilityProcess.fork` inside `app.asar` initializes `TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })` cleanly on Windows against `app.asar.unpacked` (`Poweramp LRC Embedder.exe --smoke-test` verified `ready: true`, `TagLib 2.3.2`).