# Active Handoff

- Updated: 2026-11-25 18:45 IST
- Last agent: opencode-builder + manual-verify
- Branch: main
- Base commit: 07c8bd2

## Current Goal
Execute Phase 3: pure LRC parser/normalizer (`src/shared/lrc.ts`), `LyricsProvider` queue (LRCLIB + local sidecar), IPC wiring, and Vitest suite.

## Completed Since Last Handoff
- Phase 2.5 hardening committed at `07c8bd2`: `trackId` hex validation, `StreamRegistry` OS handle destruction + `'close'` await + `Cache-Control: no-store`, `JsonStore` writeQueue + `draftId` preservation, `realpath`/empty-root containment, ref-counted `activeTargetDirs`, worker RPC timeouts, scanner temp exclusion, and SHA check updated to `:(exclude)docs/`.

## Verification Status
- `npm run typecheck`: PASS (0 errors)
- `npm test`: PASS (65/65 tests)
- `npm run build`: PASS
- `npm run build:unpack` + `--smoke-test`: PASS (exit 0, `ready: true`, TagLib 2.3.2)

## Exact Next Step
1. `src/shared/types.ts`: add `LyricsProviderId`, `LyricsQuery`, `LyricsCandidate`, `LyricsProvider`, `LyricsFetchPhase`, and `LyricsFetchProgress`.
2. `src/shared/lrc.ts`: pure parser/normalizer with `[offset:±ms]` baking, `[length:]` stripping, centisecond rounding, opt-in A2 word-tag preservation (default strip), stable timestamp sort, `stackLrcLayers`, and `shiftLrcOffset`.
3. `src/main/providers/lrclib.ts`: sequential `concurrency = 1` queue (~400ms pacing), custom `User-Agent`, `/api/get` -> `/api/search` fallback, and `429`/`503` `Retry-After` (seconds + HTTP-date) + jittered exponential backoff.
4. `src/main/providers/localSidecar.ts` and `queue.ts`: sibling `.lrc` UTF-8/BOM reader (`<= 1 MiB`, symlink rejection), dialog `.lrc` import helper, and cancellable sequential `LyricsFetchQueue`.
5. Wire IPC/preload (`lyrics:fetch`, `lyrics:fetchBatch`, `lyrics:cancelFetch`, `lyrics:fetchProgress`, `lyrics:importFile`) with `trackId`, root containment, and provider allow-list validation.
6. Add `tests/{lrc,lrclib,localSidecar,lyricsQueue}.test.ts` and pass all 4 gates.

## Files in Scope
- `src/shared/{types.ts,ipc.ts,lrc.ts}`
- `src/main/{index.ts,tagger.ts,providers/lrclib.ts,providers/localSidecar.ts,providers/queue.ts}`
- `src/preload/index.ts`
- `tests/{lrc,lrclib,localSidecar,lyricsQueue}.test.ts`

## Constraints / Open Blockers
- Leftover Phase 2.5 nit: wrap `fs.unlink` in `src/main/tagger.ts:155` (`cleanupStaleTempFiles`) with `ENOENT` tolerance and lock-error retry/skip so one locked temp file does not abort the sweep.
- Confirm `app.whenReady().then(...)` in `src/main/index.ts:746` has a `.catch()` handler so startup store corruption fails visibly.