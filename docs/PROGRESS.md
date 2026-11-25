# Progress

## Current Phase
Phase 2 complete (recursive folder scanner, atomic JSON `library-index.json` + per-track draft store, HTTP 206 `media://` protocol with stream handle registry, startup/pre-scan `*.lrcembed.*.tmp.*` sweep, Windows path containment). Ready to start Phase 3.

## Milestones
- [x] Phase 0: Clean-slate workspace (`package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`, `electron-builder.yml`, `.gitignore`), dependencies installed (`electron@^45.4.1`, `taglib-wasm@^2.5.1`, Tailwind v4, Vitest, `@tanstack/react-virtual`), `electron-winstaller` install script denied, `taglib-wasi.wasm` verified on disk, multi-agent docs and handoff skill installed.
- [x] Phase 1: Minimal Electron + React shell, `utilityProcess` + `taglib-wasm` WASI initialization, `tagger.ts` atomic Windows-safe read/write, Vitest round-trip tag fixture tests, and passing `npm run build:unpack` smoke gate.
- [x] Phase 2: Recursive folder scanner, atomic JSON `library-index.json` + draft store, HTTP 206 `media://` protocol with handle registry, and startup `*.lrcembed.*.tmp.*` sweep.
- [ ] Phase 3: LRC parser/normalizer (`src/shared/lrc.ts`), `LyricsProvider` queue (LRCLIB + sibling `.lrc`), and stacked translation/romanization support.
- [ ] Phase 4: Virtualized track table, `<audio>` timestamp preview/scrubber, lyric editor, and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav`.

## Verified Technical Findings
- `taglib-wasm@2.5.1` ships `dist/taglib-wasi.wasm` and `dist/taglib-web.wasm`, but `package.json` `exports` does not expose `./dist/taglib-wasi.wasm`. Dev mode must resolve `taglib-wasm` root via `fileURLToPath(import.meta.resolve('taglib-wasm'))` and join `'taglib-wasi.wasm'`.
- `npm install-scripts deny electron-winstaller` is active; do not approve it unless Squirrel.Windows builds are ever introduced.
- In `taglib-wasm@2.5.1` WASI mode, `audioFile.properties()` strips `"lyrics"` (`"LYRICS"`) while still returning custom `"LYRICS:*"` keys (such as MP3 `USLT` frames with custom descriptions), whereas `audioFile.getLyrics()` only reads the bare `"LYRICS"` property. Reading must check both `getLyrics()` and `LYRICS:*` keys in `properties()`, and writing must strip all `LYRICS` / `LYRICS:*` keys before calling `setProperty('LYRICS', ...)` to avoid duplicate `USLT` frames.
- `electron-vite` `?modulePath` + `utilityProcess.fork` inside `app.asar` initializes `TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })` cleanly on Windows against `app.asar.unpacked` (`Poweramp LRC Embedder.exe --smoke-test` verified `ready: true`, `TagLib 2.3.2`).
