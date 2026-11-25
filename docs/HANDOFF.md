# Active Handoff

- Updated: 2026-11-25 15:38 IST
- Last agent: builder (opencode)
- Branch: main
- Base commit: 50fa5c4

## Current Goal
Execute Phase 3: LRC parser/normalizer (`src/shared/lrc.ts`), `LyricsProvider` queue (LRCLIB + sibling `.lrc`), and stacked translation/romanization support.

## Completed Since Last Handoff
- Implemented Phase 2: recursive folder scanner, atomic JSON `library-index.json` + per-track draft store (`src/main/store.ts`), HTTP 206 `media://` protocol with stream handle registry (`src/main/mediaProtocol.ts`), Windows path containment (`src/main/utils/pathContainment.ts`), deterministic trackId hashing (`src/main/utils/trackId.ts`), startup/pre-scan `*.lrcembed.*.tmp.*` sweep with symlink avoidance, tightened temp PID regex (`\\d+`), worker init timeout + auto-restart with crash temp sweep, and pre-embed renderer `<audio>` unload + stream abort handshake.
- Added shared types: `TrackRecord`, `LyricDraft`, `LibraryRoot`, `ScanProgress`, `MediaUrl` in `src/shared/types.ts`.
- Extended IPC contracts in `src/shared/ipc.ts`: library roots, scan, drafts, media URLs, audio unload handshake.
- Added Vitest coverage: `tests/store.test.ts` (atomic writes, lock retry, draft CRUD), `tests/pathContainment.test.ts` (case-insensitive, cross-drive, sibling prefix bypass), `tests/mediaProtocol.test.ts` (200/206/416, range parsing, stream registry, abort), `tests/scanner.test.ts` (recursive scan, progress, extension filter, symlink skip). Total 46 tests passing.

## Verification Status
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (5 files, 46/46 tests)
- `npm run build`: PASS (main, preload CJS, Tailwind v4 + React renderer)
- `npm run build:unpack`: PASS (`electron-builder --dir`; packaged build verified)
- `release\win-unpacked\Poweramp LRC Embedder.exe --smoke-test`: PASS (exit 0, `ready: true`, TagLib 2.5.1 / TagLib 2.3.2)

## Exact Next Step
1. Design `src/shared/lrc.ts`: line-synced `[mm:ss.xx]` parser, `[offset:±ms]` baking into timestamps, `[length:]` stripping, opt-in A2 word-tag preservation toggle, same-timestamp multi-line stacking for translations/romanization.
2. Implement `LyricsProvider` interface in `src/shared/types.ts` and `src/main/providers/`: LRCLIB (sequential, 400ms pacing, custom User-Agent, Retry-After on 429/503) + local sibling `.lrc` import.
3. Add provider queue in main process (concurrency = 1) with progress events to renderer.
4. Extend renderer with lyric editor, virtualized track table, `<audio>` timestamp preview/scrubber.

## Files in Scope
- `src/shared/{types.ts,ipc.ts,lrc.ts}`
- `src/main/{index.ts,audioWorker.ts,tagger.ts,store.ts,mediaProtocol.ts,scanner.ts,providers/}`
- `src/main/utils/{pathContainment.ts,trackId.ts}`
- `src/preload/index.ts`
- `tests/`

## Constraints / Open Blockers
- None. Keep `taglib-wasm` writes sequential (`concurrency = 1`) and close active `media://` streams + renderer `<audio>` src before embedding.
- Provider implementations must be pure TypeScript (no native addons).
- LRCLIB rate limits: respect `Retry-After` header, implement exponential backoff with jitter.