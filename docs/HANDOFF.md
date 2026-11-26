# Active Handoff

- Updated: 2026-11-26 10:46 IST
- Last agent: builder
- Branch: main
- Base commit: 05225d0

## Current Goal
Run the Phase 4 hardware verification walkthrough: interactive Electron desktop pass, then Poweramp Android spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc` outputs.

## Completed Since Last Handoff
Phase 4.5 delivered four items:
1. **Candidate Sifter**: `lyrics:searchCandidates` IPC + `LrclibProvider.searchAllCandidates` (`/api/get` then paced `/api/search`, dedup by source id), `LyricsSearchRequest`/`LyricsSearchResult` types, focus-prefilled search fields with stale-response guards, collapsible results with Load Primary / To Translation / To Romanization.
2. **Multi-line sync**: `findActiveLineIndices` in `src/shared/lyricsSync.ts` returns all stacked lines sharing the active timestamp; `AudioPreviewPlayer` highlights every stacked line (backwards-compatible with `findActiveLineIndex`).
3. **Transfer controls**: send/swap translation and romanization between layers in `LyricsEditorPanel`, Primary Only / Stacked Preview toggle whose live output feeds both the clickable preview and the player.
4. **Tooltips**: `title`/accessible labels across editor, toolbar, and table controls.

Tests: `tests/lrclib.test.ts` (+140 lines, candidate dedup/pacing) and `tests/lyricsSync.test.ts` (+33 lines, stacked timestamps).

## Verification Status
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (163/163 tests across 11 files)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- Packaged `--smoke-test`: PASS (`ready: true`, `2.5.1 (TagLib 2.3.2)`, no error)

## Exact Next Step
1. `npm run dev` (or `release/win-unpacked/Poweramp LRC Embedder.exe`) on Windows: verify folder scan, Shift/Ctrl table selection, `media://` playback/seek, live `onUnloadAudio` lock release while embedding the playing track, candidate sifter search/load, translation transfer/swap, stacked preview, and draft badge sync.
2. Copy embedded `.flac`, `.opus`, `.m4a`, `.mp3`, and `.wav` + `.lrc` samples to Poweramp on Android; spot-check synced rendering, `[offset:±ms]` polarity, stacked translation display, and UTF-8/UTF-16 tag compatibility. Then tick the Phase 4 verification milestone in `docs/PROGRESS.md`.

## Files in Scope
- `src/main/{index.ts,providers/lrclib.ts}`
- `src/preload/index.ts`
- `src/renderer/src/{App.tsx,components/{AudioPreviewPlayer,LibraryToolbar,LyricsEditorPanel,TrackTable}.tsx}`
- `src/shared/{ipc.ts,types.ts,lyricsSync.ts}`
- `tests/{lrclib,lyricsSync}.test.ts`, `docs/{PROGRESS.md,HANDOFF.md}`

## Constraints / Open Blockers
- Physical Android device with Poweramp is required for the hardware spot-check; it cannot run in automated Windows CLI checks.
- Local music samples in `tests/fixtures/*.m4a` and `*.opus` are excluded via `.git/info/exclude` (uncommitted by design) for the hardware pass.
- Sandbox note: `.git`/`node_modules` owned by `BUILTIN/Administrators` can cause `EPERM` on `.git/index.lock` and Vite `.mjs` temp files inside the sandbox; run Git, Vitest, build, and packaging outside the sandbox.
