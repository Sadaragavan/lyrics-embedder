# Progress

## Current Phase
Phase 4.5 desktop UI complete (Phase 3 audit fixes applied; pure selection/sync helpers; `@tanstack/react-virtual` library table with Shift/Ctrl selection; `<audio>` `media://` preview player with synchronous `onUnloadAudio` lock handshake and multi-line active display; raw/stacked LRC editor with offset nudge, normalize, opt-in A2 toggle, LRCLIB/sidecar fetch, `.lrc` import, drafts, and sequential embed; interactive Candidate Sifter over `LrclibProvider.searchAllCandidates`; primary/stacked live preview feeding both the clickable preview and the player). Remaining: interactive desktop walkthrough and Poweramp Android hardware spot-check.

## Milestones
- [x] Phase 0: Clean-slate workspace (`package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`, `electron-builder.yml`, `.gitignore`), dependencies installed (`electron@^45.4.1`, `taglib-wasm@^2.5.1`, Tailwind v4, Vitest, `@tanstack/react-virtual`), `electron-winstaller` install script denied, `taglib-wasi.wasm` verified on disk, multi-agent docs and handoff skill installed.
- [x] Phase 1: Minimal Electron + React shell, `utilityProcess` + `taglib-wasm` WASI initialization, `tagger.ts` atomic Windows-safe read/write, Vitest round-trip tag fixture tests, and passing `npm run build:unpack` smoke gate.
- [x] Phase 2: Recursive folder scanner, atomic JSON `library-index.json` + draft store, HTTP 206 `media://` protocol with handle registry, and startup `*.lrcembed.*.tmp.*` sweep.
- [x] Phase 2.5: Security and lock-safety hardening (`trackId` hex validation, `StreamRegistry` OS handle destruction + `'close'` await, `Cache-Control: no-store`, `JsonStore` write queue, `realpath`/empty-root containment, ref-counted `activeTargetDirs`, worker RPC timeouts, scanner temp exclusion).
- [x] Phase 3: LRC parser/normalizer (`src/shared/lrc.ts`), `LyricsProvider` queue (LRCLIB + sibling `.lrc`), and stacked translation/romanization support.
- [x] Phase 4 (UI): Virtualized track table (`@tanstack/react-virtual`), `<audio>` timestamp preview/scrubber with `onUnloadAudio` handshake, and raw/stacked LRC editor + fetch/embed workflows.
- [x] Phase 4.5 (UI polish): Collapsible Candidate Sifter (`lyrics:searchCandidates` IPC + `LrclibProvider.searchAllCandidates`, `/api/get` + `/api/search` dedup, paced queue), focus-prefilled search fields with stale-response guards, per-result Load Primary / To Translation / To Romanization, send/swap translation+romanization toolbar, Primary Only / Stacked Preview toggle whose live output feeds both the clickable preview and `AudioPreviewPlayer` (`findActiveLineIndices`), and tooltips across editor/toolbar controls.
- [ ] Phase 4 (Verification): Interactive desktop walkthrough and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc`.

## Verification (Phase 4.5 exit gate)
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (163/163 tests across 11 files)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- Packaged `--smoke-test`: PASS (`ready: true`, `2.5.1 (TagLib 2.3.2)`)

## Verified Technical Findings
- `taglib-wasm@2.5.1` ships `dist/taglib-wasi.wasm` and `dist/taglib-web.wasm`, but `package.json` `exports` does not expose `./dist/taglib-wasi.wasm`. Dev mode must resolve `taglib-wasm` root via `fileURLToPath(import.meta.resolve('taglib-wasm'))` and join `'taglib-wasi.wasm'`.
- `npm install-scripts deny electron-winstaller` is active; do not approve it unless Squirrel.Windows builds are ever introduced.
- In `taglib-wasm@2.5.1` WASI mode, `audioFile.properties()` strips `"lyrics"` (`"LYRICS"`) while still returning custom `"LYRICS:*"` keys (such as MP3 `USLT` frames with custom descriptions), whereas `audioFile.getLyrics()` only reads the bare `"LYRICS"` property. Reading must check both `getLyrics()` and `LYRICS:*` keys in `properties()`, and writing must strip all `LYRICS` / `LYRICS:*` keys before calling `setProperty('LYRICS', ...)` to avoid duplicate `USLT` frames.
- `electron-vite` `?modulePath` + `utilityProcess.fork` inside `app.asar` initializes `TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })` cleanly on Windows against `app.asar.unpacked` (`Poweramp LRC Embedder.exe --smoke-test` verified `ready: true`, `TagLib 2.3.2`).
