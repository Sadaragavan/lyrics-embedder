# Poweramp Lyrics Embedder

An Electron desktop app (`"type": "module"`, Electron `^45.4.1`, Node.js `24.22.3`, `electron-vite`, TypeScript, React, Tailwind CSS v4) that scans local audio libraries, fetches and edits synced lyrics, previews timing against local audio, and embeds Poweramp-compatible lyrics safely on Windows without native C++ addons.

Read `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, and `docs/HANDOFF.md` before planning or editing.

## Repository Layout
- `src/shared/`: Shared TypeScript interfaces (`TrackRecord`, `LyricDraft`, `LyricsProvider`, IPC contracts). Keep free of Node-only and DOM-only imports.
- `src/main/`: Electron main process (atomic JSON store, HTTP 206 `media://` stream registry, sequential provider fetch queue, `utilityProcess` supervisor) and `src/main/audioWorker.ts` (`?modulePath`).
- `src/preload/`: Minimal typed `contextBridge` API exposed to the renderer (`out/preload/index.cjs`).
- `src/renderer/`: React UI (`lucide-react`, Tailwind CSS v4, `@tanstack/react-virtual`) and `<audio>` preview player.
- `tests/`: Vitest unit tests and round-trip audio tag fixture tests (`.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`).
- `docs/`: `ARCHITECTURE.md` (module contracts), `PROGRESS.md` (milestones and known gaps), `HANDOFF.md` (live baton between agents).

## Sequential Multi-Agent Protocol
- Startup check: Read `docs/HANDOFF.md` and compare its `Base commit` SHA against `git log -n 1 --format=%h -- . ":(exclude)docs/"`. If they differ, inspect `git log -n 5 --oneline` before doing any work.
- Single-writer boundary: Do not begin edits on a dirty working tree without reporting `git status --short` first. Never force-push `main`.
- Exit gate: Run all applicable verification commands below, overwrite `docs/HANDOFF.md` (keep under 60 lines), update `docs/PROGRESS.md` only when a milestone or invariant changes, and leave a clean commit before switching tools. Use the `.agents/skills/handoff/SKILL.md` workflow when running in OpenCode or Antigravity CLI.

## Mandatory Verification Gates
OpenCode V2 does not run LSP diagnostics. Run these commands before finishing changes:
1. `npm run typecheck` (`tsc --noEmit -p tsconfig.node.json` and `tsconfig.web.json`) — must pass with 0 errors.
2. `npm test` (`vitest run`) — must pass all unit and tag fixture tests.
3. `npm run build` (`electron-vite build`) — must succeed cleanly.
4. `npm run build:unpack` (`electron-builder --dir --publish never`) — required whenever modifying `audioWorker.ts`, `wasmUrl` resolution, `asarUnpack`, `electron.vite.config.ts`, or `electron-builder.yml` to verify packaged WASI `.wasm` loading on Windows.

## Rules That Are Easy to Break

### Process Isolation & WASI Tag Engine
- Spawn `utilityProcess.fork(workerModulePath, [], { stdio: 'pipe' })` strictly after `app.whenReady()` resolves. Forward worker `stdout`/`stderr` and non-zero exit codes to main-process logs.
- Resolve the `taglib-wasm` `.wasm` path in `src/main/` and pass it explicitly into `TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })`:
  - Packaged (`app.isPackaged`): `path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'taglib-wasm', 'dist', 'taglib-wasi.wasm')` backed by `asarUnpack` in `electron-builder.yml`.
  - Development (`!app.isPackaged`): `taglib-wasm@2.5.1` does not export `./dist/taglib-wasi.wasm` in `package.json` `exports`. Resolve the exported root entry via `fileURLToPath(import.meta.resolve('taglib-wasm'))` and join `'taglib-wasi.wasm'` with `path.dirname(...)`. Never use bare `require.resolve` or unexported subpath imports.
- Run all `taglib-wasm` writes sequentially (`concurrency = 1`) because `saveToFile()` loads the full file into memory.
- Read and write lyrics through TagLib's `PropertyMap` API (`"LYRICS"`). Before writing `"LYRICS"`, inspect and strip both `"LYRICS"` and any `"LYRICS:*"` keys so MP3 `USLT` frames with custom descriptions are detected and replaced without duplicates while TagLib handles ID3v2.3 UTF-16 vs. ID3v2.4 UTF-8 automatically.
- Default `.wav` tracks to sibling `<track>.lrc` (UTF-8) sidecar files instead of mutating uncompressed WAV containers.

### Windows File-Lock & Crash Safety
- Track active `media://` HTTP 206 byte-range file streams in a `Map<filePath, Set<Stream>>` registry in `src/main/`.
- Before embedding a track: instruct the renderer to unload `<audio>` (`audioEl.removeAttribute('src'); audioEl.load()`) if that track is loaded, and abort/close all open `media://` streams for that path.
- Stage writes in the same directory as the target file using `<basename>.lrcembed.<pid>.tmp.<ext>` (prevents cross-drive `EXDEV` errors and preserves extension detection for TagLib).
- Write tags to the `.tmp` copy, re-open and verify clean tag parsing, then run `fs.rename(tmp, target)` and `fs.utimes(target, atime, mtime)` wrapped in bounded exponential backoff catching `EBUSY`, `EPERM`, and `EACCES`.
- Restrict startup and pre-scan temp cleanup strictly to `*.lrcembed.*.tmp.*` so unrelated `.tmp` files are never deleted.

### Persistence, Providers & Lyrics Formatting
- Persist `library-index.json` and per-track draft JSON files in `app.getPath('userData')` via atomic `.tmp` + `fs.rename`. Do not introduce `node:sqlite` or native addons (`node-gyp`).
- Keep lyric fetching behind the `LyricsProvider` interface (`src/shared/`). Ship LRCLIB (sequential `concurrency = 1`, ~400 ms pacing, custom `User-Agent`, `Retry-After` handling on `429`/`503`) and local sibling `.lrc` import in v1.
- Output standard line-synced `[mm:ss.xx]` LRC by default (strip `<mm:ss.xx>` A2 word tags unless the user enables the opt-in preserve toggle).
- Bake `[offset:±ms]` directly into line timestamps and strip `[length:]` headers so Poweramp does not reject tracks on duration mismatches.
- Support manual paste and same-timestamp multi-line stacking for translations/romanization in v1; defer any OpenAI-compatible `{ baseUrl, apiKey, model }` translation client to v2.

### Electron Security & Renderer UI
- Enforce `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and minimal typed IPC methods in `src/preload/`. Validate all file paths and IPC payloads in `src/main/`.
- Use `import.meta.dirname` (never `__dirname`) in ESM main-process files and load preload from `../preload/index.cjs`.
- Keep `@import 'tailwindcss' source(none);` and explicit `@source` directives at the top of the Tailwind v4 CSS entry so Vite never scans `node_modules` or media folders.
- Virtualize the track table with `@tanstack/react-virtual` and maintain Shift-click / Ctrl-click selection state in React state rather than DOM nodes.

## OpenCode Agent Roles
- `planner`: Specify typed IPC contracts, `LyricsProvider` interfaces, Windows lock-release sequences, and affected Vitest fixtures before implementation.
- `builder`: Maintain all invariants above and leave `npm run typecheck`, `npm test`, and `npm run build` green.
- `reviewer`: Audit for unexported `taglib-wasm` subpath imports, pre-`whenReady()` worker forks, unclosed `media://` handles, generic temp globs, `LYRICS:*` duplicates, and raw preload exposure.
