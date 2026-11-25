# Active Handoff

- Updated: 2026-11-25 20:29 IST
- Last agent: antigravity-builder
- Branch: main
- Base commit: 0150f45

## Current Goal
Run interactive Electron desktop verification and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc` outputs.

## Completed Since Last Handoff
- Part A Phase 3 fixes: `LrclibProvider` now throws on exhausted `429`/`503` or network errors (only falling back to `/api/search` on `404`/empty match) and records `lastRequestTime` in `finally`; `LyricsFetchQueue` emits `phase: 'error'` when providers fail without a match and short-circuits on `localSidecar` synced hits; `src/shared/lrc.ts` fixes `[offset:±ms]` polarity (`timeMs - offset`) without premature clamping before `shiftLrcOffset`; `src/main/index.ts` rejects symlinks in `selectLrcFile` and caps fetch query metadata fields at 512 chars.
- Part B Phase 4 UI: added pure DOM-free `src/shared/{trackSelection,lyricsSync}.ts`, `src/renderer/src/types.ts`, `LibraryToolbar.tsx`, `TrackTable.tsx` (`@tanstack/react-virtual`, React-managed Shift/Ctrl selection), `AudioPreviewPlayer.tsx` (`media://track/<id>`, active-line display, click-to-seek, synchronous ref-backed `onUnloadAudio` unload before preload ack), `LyricsEditorPanel.tsx` (raw/stack layers, offset nudge, normalize, opt-in A2 toggle, LRCLIB/sidecar fetch + cancel, `.lrc` import, drafts, sequential embed), and split `h-screen` `App.tsx` layout keeping `app.css` `@source` directives intact.
- Added `tests/{trackSelection,lyricsSync}.test.ts` and updated `tests/{lrc,lrclib,lyricsQueue}.test.ts` + `docs/PROGRESS.md`.

## Verification Status
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (156/156 tests across 11 files)
- `npm run build`: PASS
- `npm run build:unpack` + `--smoke-test`: PASS (exit 0, `ready: true`, `2.5.1 (TagLib 2.3.2)`)

## Exact Next Step
1. Launch `npm run dev` (or packaged app) on Windows to verify interactive folder scan, Shift/Ctrl table selection, `media://` playback/seeking, live `onUnloadAudio` lock release during active playback embed, draft badge sync, and stacked translation output.
2. Transfer embedded `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc` sample tracks to Poweramp on Android and spot-check synced lyric rendering, `[offset:±ms]` polarity, and UTF-8/UTF-16 tag compatibility; update `docs/PROGRESS.md` once verified.

## Files in Scope
- `src/renderer/src/{App.tsx,app.css,types.ts,components/*}`
- `src/shared/{lrc.ts,lyricsSync.ts,trackSelection.ts}`
- `docs/{PROGRESS.md,HANDOFF.md}`

## Constraints / Open Blockers
- Physical Android device with Poweramp is required for the Phase 4 hardware spot-check (cannot be run inside automated Windows CLI checks).
- Workspace sandbox note: `.git` and `node_modules` ownership by `BUILTIN/Administrators` causes `EPERM` on `.git/index.lock` and Vite `.mjs` temp config files inside the sandbox; Vitest, Electron-vite build, packaging, smoke test, and Git commits succeed outside the sandbox.
