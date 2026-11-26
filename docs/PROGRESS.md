# Progress

## Current Phase
v1.1 complete (query normalizer, Unicode-aware multi-factor track matcher, and SelectionDecision router wired through the provider queue). Provides NFKC text normalization, title/artist cleanup, query-variant generation, timing-kind detection (`word`/`line`/`plain`/`instrumental`/`none`), typed provider errors, and ACCEPT_FINAL/KEEP_AS_FALLBACK/CONTINUE/REJECT routing. Remaining: interactive desktop walkthrough and Poweramp Android hardware spot-check.

## Milestones
- [x] Phase 0: Clean-slate workspace (`package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`, `electron-builder.yml`, `.gitignore`), dependencies installed (`electron@^45.4.1`, `taglib-wasm@^2.5.1`, Tailwind v4, Vitest, `@tanstack/react-virtual`), `electron-winstaller` install script denied, `taglib-wasi.wasm` verified on disk, multi-agent docs and handoff skill installed.
- [x] Phase 1: Minimal Electron + React shell, `utilityProcess` + `taglib-wasm` WASI initialization, `tagger.ts` atomic Windows-safe read/write, Vitest round-trip tag fixture tests, and passing `npm run build:unpack` smoke gate.
- [x] Phase 2: Recursive folder scanner, atomic JSON `library-index.json` + draft store, HTTP 206 `media://` protocol with handle registry, and startup `*.lrcembed.*.tmp.*` sweep.
- [x] Phase 2.5: Security and lock-safety hardening (`trackId` hex validation, `StreamRegistry` OS handle destruction + `'close'` await, `Cache-Control: no-store`, `JsonStore` write queue, `realpath`/empty-root containment, ref-counted `activeTargetDirs`, worker RPC timeouts, scanner temp exclusion).
- [x] Phase 3: LRC parser/normalizer (`src/shared/lrc.ts`), `LyricsProvider` queue (LRCLIB + sibling `.lrc`), and stacked translation/romanization support.
- [x] Phase 4 (UI): Virtualized track table (`@tanstack/react-virtual`), `<audio>` timestamp preview/scrubber with `onUnloadAudio` handshake, and raw/stacked LRC editor + fetch/embed workflows.
- [x] Phase 4.5 (UI polish): Collapsible Candidate Sifter (`lyrics:searchCandidates` IPC + `LrclibProvider.searchAllCandidates`, `/api/get` + `/api/search` dedup, paced queue), focus-prefilled search fields with stale-response guards, per-result Load Primary / To Translation / To Romanization, send/swap translation+romanization toolbar, Primary Only / Stacked Preview toggle whose live output feeds both the clickable preview and `AudioPreviewPlayer` (`findActiveLineIndices`), and tooltips across editor/toolbar controls.
- [x] Phase 5: Native app menu (`src/shared/menu.ts` pure template + `src/main/menu.ts` adapter, `MenuAction`/`MenuSyncState` IPC, no bare Space, Alt+P/Alt+S playback), dynamic workspace (collapsible library sidebar with draggable divider, Edit/Layers/Find mode bar, Raw/Split/Preview editor layout), compact track rows, three-mode editor with lifted translation/romanization layers, bottom-dock player with one-shot `PlayerCommand`. `tests/menu.test.ts` covers sanitization/accelerators/template.
- [x] v1.1: Query normalizer + multi-factor matcher (`src/shared/trackMatching.ts`: NFKC normalization preserving letters/numbers/marks, `cleanTrackTitle`, `splitArtists`, `buildQueryVariants`, Unicode token similarity, duration tiers, album bonus, local baseline), timing detection (`detectLyricsTimingKind`), SelectionDecision router + typed `ProviderError` (`src/main/providers/router.ts`), LRCLIB variant walking / early `ACCEPT_FINAL` / typed failures, and queue routing (`evaluateCandidate`/`pickBetterCandidate`, `errorKind` on error phase). Tests: `trackMatching.test.ts`, `providerRouter.test.ts`, plus extended `lrc`/`lrclib`/`lyricsQueue`/`localSidecar` tests.
- [ ] Phase 4 (Verification): Interactive desktop walkthrough and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc`.

## Verification (v1.1 exit gate)
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (225/225 tests across 14 files)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- Packaged `--smoke-test`: PASS (`ready: true`, `2.5.1 (TagLib 2.3.2)`)

## Verified Technical Findings
- `taglib-wasm@2.5.1` ships `dist/taglib-wasi.wasm` and `dist/taglib-web.wasm`, but `package.json` `exports` does not expose `./dist/taglib-wasi.wasm`. Dev mode must resolve `taglib-wasm` root via `fileURLToPath(import.meta.resolve('taglib-wasm'))` and join `'taglib-wasi.wasm'`.
- `npm install-scripts deny electron-winstaller` is active; do not approve it unless Squirrel.Windows builds are ever introduced.
- In `taglib-wasm@2.5.1` WASI mode, `audioFile.properties()` strips `"lyrics"` (`"LYRICS"`) while still returning custom `"LYRICS:*"` keys (such as MP3 `USLT` frames with custom descriptions), whereas `audioFile.getLyrics()` only reads the bare `"LYRICS"` property. Reading must check both `getLyrics()` and `LYRICS:*` keys in `properties()`, and writing must strip all `LYRICS` / `LYRICS:*` keys before calling `setProperty('LYRICS', ...)` to avoid duplicate `USLT` frames.
- `electron-vite` `?modulePath` + `utilityProcess.fork` inside `app.asar` initializes `TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })` cleanly on Windows against `app.asar.unpacked` (`Poweramp LRC Embedder.exe --smoke-test` verified `ready: true`, `TagLib 2.3.2`).
