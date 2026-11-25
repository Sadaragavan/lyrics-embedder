# Active Handoff

- Updated: 2026-11-25 19:27 IST
- Last agent: antigravity-builder
- Branch: main
- Base commit: ef6e22b

## Current Goal
Execute Phase 4: build the virtualized library table UI, `<audio>` preview player with `media://` range playback + unload handshake, LRC/stacked-layer editor, and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav`.

## Completed Since Last Handoff
- Cleared Phase 2.5 blockers: `cleanupStaleTempFiles` in `src/main/tagger.ts` now retries transient lock errors and tolerates/skips `ENOENT` or persistent locks without aborting sweeps; `app.whenReady().then(...).catch(...)` in `src/main/index.ts` surfaces startup errors visibly (`console.error` + `dialog.showErrorBox`) and exits 1.
- Added Phase 3 shared types (`src/shared/types.ts`) and pure LRC parser/normalizer (`src/shared/lrc.ts`) with `[offset:±ms]` baking, `[length:]` + header stripping, centisecond rounding, opt-in A2 word-tag preservation (default strip), stable sort, `stackLrcLayers`, and `shiftLrcOffset`.
- Implemented `LrclibProvider` (`src/main/providers/lrclib.ts`, sequential `concurrency = 1`, ~400ms pacing, custom `User-Agent`, `/api/get` -> `/api/search` fallback, `429`/`503` `Retry-After` seconds/HTTP-date + jittered exponential backoff), `LocalSidecarProvider` + `importLrcFile` (`src/main/providers/localSidecar.ts`, UTF-8/BOM, `<= 1 MiB`, symlink rejection), and cancellable `LyricsFetchQueue` (`src/main/providers/queue.ts`).
- Wired preload/IPC channels (`dialog:selectLrcFile`, `lyrics:fetch`, `lyrics:fetchBatch`, `lyrics:cancelFetch`, `lyrics:fetchProgress`, `lyrics:importFile`) with `trackId`, root containment / dialog authorization, and `ALLOWED_PROVIDER_IDS` validation (`src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`).
- Added unit suites `tests/{lrc,lrclib,localSidecar,lyricsQueue}.test.ts` and temp-sweep lock test in `tests/tagger.test.ts`; updated `docs/PROGRESS.md`.

## Verification Status
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (138/138 tests across 9 files)
- `npm run build`: PASS
- `npm run build:unpack` + `--smoke-test`: PASS (exit 0, `ready: true`, `2.5.1 (TagLib 2.3.2)`)

## Exact Next Step
1. Build Phase 4 renderer shell (`src/renderer/src/App.tsx` and components): library root picker, scan progress, and `@tanstack/react-virtual` track table with React-managed Shift/Ctrl multi-selection.
2. Add `<audio>` preview player wired to `media://track/<id>` via `getMediaUrl` and `onUnloadAudio` (`removeAttribute('src')` + `load()`) lock-release handshake before embedding.
3. Build LRC editor panel using `src/shared/lrc.ts` (`normalizeLrc`, `shiftLrcOffset`, `stackLrcLayers`, opt-in A2 toggle), LRCLIB/sidecar fetch + progress controls, `.lrc` import (`selectLrcFile` + `lyricsImportFile`), draft autosave, and batch embed trigger.
4. Verify all gates and spot-check embedded `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav`+`.lrc` outputs on Poweramp Android.

## Files in Scope
- `src/renderer/src/{App.tsx,app.css,components/*}`
- `src/shared/{ipc.ts,types.ts,lrc.ts}`
- `src/preload/index.ts`
- `src/main/index.ts`

## Constraints / Open Blockers
- None. (Environment note: on this Windows host, `.git` and `node_modules` ownership by `BUILTIN/Administrators` caused workspace sandbox `EPERM` on `.git/index.lock` and Vite `.mjs` temp config files; running outside sandbox succeeded.)
