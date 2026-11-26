# Architecture

## Runtime & Process Model
- Shell: Electron `^45.4.1` (Node.js `24.22.3`), `"type": "module"`, built with `electron-vite` `^6.0.0`.
- Processes:
  1. Main (`src/main/` -> `out/main/index.js`, ESM): Window lifecycle, IPC validation, atomic JSON persistence (`userData`), HTTP 206 `media://` stream registry, sequential lyric fetch queue, and `utilityProcess` supervision.
  2. Utility Worker (`src/main/audioWorker.ts` via `?modulePath`): Isolated process for recursive directory scans and sequential `taglib-wasm` WASI read/write operations.
  3. Preload (`src/preload/index.ts` -> `out/preload/index.cjs`, bundled CJS): Exposes only typed IPC methods via `contextBridge`.
  4. Renderer (`src/renderer/` -> `out/renderer/`): React 19 + Tailwind CSS v4 + `lucide-react` + `@tanstack/react-virtual` UI and `<audio>` preview player.

## Planned Module Layout
- `src/shared/`
  - `ipc.ts`: Typed channel names, request/response payloads, and `ElectronApi` interface.
  - `types.ts`: `LyricsProviderId` is `'lrclib' | 'netease' | 'localSidecar'`; candidates carry optional `translatedLyrics`/`romanizedLyrics`.
  - `types.ts`: `TrackRecord`, `LyricDraft`, `LyricsCandidate`, `LyricsProvider`, `EmbedResult`.
  - `lrc.ts`: Pure LRC parser/formatter (line-synced normalization, `[offset:±ms]` baking, `[length:]` stripping, opt-in A2 preservation, same-timestamp line stacking).
- `src/main/`
  - `index.ts`: App startup, `BrowserWindow` creation, `app.whenReady()` worker boot, IPC registration, clean shutdown.
  - `wasmPath.ts`: Dev (`import.meta.resolve('taglib-wasm')`) and packaged (`app.asar.unpacked`) resolution for `taglib-wasi.wasm`.
  - `audioWorker.ts`: `utilityProcess` message loop initializing `TagLib.initialize({ wasmUrl, forceWasmType: 'wasi' })`.
  - `tagger.ts`: Pure Node/WASI tag read/write and Windows lock-safe atomic swap logic (imported by `audioWorker.ts` and tested directly by Vitest).
  - `mediaProtocol.ts`: Custom `media://` handler with HTTP 206 Partial Content byte-range support and active stream registry (`Map<filePath, Set<Stream>>`).
  - `store.ts`: Atomic JSON read/write for `library-index.json` and per-track drafts under `app.getPath('userData')`.
  - `providers/`: Pluggable `LyricsProvider` implementations (`lrclib.ts`, `netease.ts`, `localSidecar.ts`) plus `aiTranslator.ts` (opt-in OpenAI-compatible secondary-layer generation, single-flight with a 60 s timeout).
  - `settingsStore.ts`: Electron-free encrypted AI settings (`userData/settings.json`, `0600`, injected async `SecretCipher`). The API key is never returned to the renderer.
- `src/shared/aiTranslate.ts`: Pure prompt building, response JSON extraction, and deterministic LRC rebuild that re-attaches the original `[mm:ss.xx]` timestamps (model timestamps are never trusted).
- `src/preload/`
  - `index.ts`: `contextBridge.exposeInMainWorld('api', ...)` implementing `ElectronApi`.
- `src/renderer/`
  - `index.html`, `src/main.tsx`, `src/App.tsx`, `src/app.css` (`@import 'tailwindcss' source(none);` + explicit `@source`).

## Format & Storage Matrix
| Format | Storage Target | Notes |
| :--- | :--- | :--- |
| `.flac` | Vorbis `LYRICS` | Sequential atomic `.lrcembed.<pid>.tmp.flac` write + verify + rename + `mtime` restore |
| `.opus` | Vorbis `LYRICS` | Same sequential atomic pipeline |
| `.m4a` | MP4 `©lyr` | Same sequential atomic pipeline |
| `.mp3` | ID3v2 `USLT` via TagLib `PropertyMap` | Strip existing `"LYRICS"` and `"LYRICS:*"` before setting `"LYRICS"` |
| `.wav` | Sibling `<track>.lrc` (UTF-8) | Default sidecar avoids WAV RIFF limits and full-file RAM copies |

## Data Flow (Embed Pipeline)
1. Renderer requests embed for selected track IDs via `window.api`.
2. Main instructs Renderer to unload `<audio>` if the target path is loaded, and closes matching handles in `mediaProtocol.ts`.
3. Main sends sequential (`concurrency = 1`) embed jobs to `audioWorker.ts`.
4. Worker stages `<basename>.lrcembed.<pid>.tmp.<ext>` in the same folder, writes tags, re-opens to verify clean parsing, swaps via bounded-retry `fs.rename`, and restores `atime`/`mtime` via `fs.utimes`.
5. Main updates `library-index.json` atomically and emits progress events back to Renderer.
