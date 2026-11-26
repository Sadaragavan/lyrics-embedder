# Active Handoff

- Updated: 2026-11-26 13:22 IST
- Last agent: builder
- Branch: main
- Base commit: 7b32611

## Current Goal
v1.1 (Query Normalizer, Multi-Factor Track Matcher, SelectionDecision Router) complete and verified. Remaining: interactive desktop walkthrough and Poweramp Android hardware spot-check (Phase 4 verification milestone, unchanged).

## Completed Since Last Handoff
1. **Shared types + timing detection**: `src/shared/types.ts` gained `SelectionDecision`, `ProviderErrorKind`, `LyricsTimingKind`, `CandidateEvaluation`; `timingKind?` on `LyricsCandidate` and `errorKind?` on `LyricsFetchProgress`. `src/shared/lrc.ts` gained `detectLyricsTimingKind(synced, plain, instrumental?)` classifying `word`/`line`/`plain`/`instrumental`/`none` using valid `[mm:ss.xx]` and A2 `<mm:ss.xx>` tags.
2. **Query normalizer + matcher** (`src/shared/trackMatching.ts`, new): NFKC normalization preserving Unicode letters/numbers/marks (Tamil, Cyrillic), `cleanTrackTitle` (strips `(From "...")`, remaster/official/feature/OST noise), `splitArtists`/`extractPrimaryArtist` (`;`, `,`, `/`, `&`, feat./ft./featuring, `x`), `buildQueryVariants` (raw, cleaned+album, cleaned; fingerprint-deduped), `computeTrackFingerprint`, `textSimilarity`, and multi-factor `scoreCandidate` (duration tiers, album bonus, local baseline 100).
3. **SelectionDecision router** (`src/main/providers/router.ts`, new): typed `ProviderError` + `classifyProviderError` (`RATE_LIMITED`/`NOT_FOUND`/`NETWORK`/`BAD_RESPONSE`/`ABORTED`/`UNKNOWN`), `evaluateCandidate` returning ACCEPT_FINAL/KEEP_AS_FALLBACK/CONTINUE/REJECT, `pickBetterCandidate`/`compareEvaluations`, `MIN_USABLE_SCORE = 8`.
4. **Provider integration**: LRCLIB walks query variants with ~400 ms pacing, `/api/search` structured then broad `q` fallback, early stop on ACCEPT_FINAL, dedup by record ID, `timingKind` populated, typed errors. Local sidecar keeps fixed scores (100 synced / 6 plain) and adds `timingKind`. Queue routes via `evaluateCandidate`/`pickBetterCandidate`, honors `preferWordSynced` (default true), keeps line-synced remote results as fallback, and emits `errorKind` on error phase. Concurrency remains 1.
5. **Tests**: new `tests/trackMatching.test.ts` and `tests/providerRouter.test.ts`; extended `lrc`, `lrclib`, `lyricsQueue`, and `localSidecar` tests.

## Verification Status
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm test`: PASS (225/225 tests across 14 files)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- Packaged `--smoke-test`: PASS (exit 0, `ready: true`, `2.5.1 (TagLib 2.3.2)`, unpacked WASI `.wasm` path, no error)

## Exact Next Step
1. `npm run dev` (or packaged exe) on Windows: exercise interactive search with noisy soundtrack titles, Tamil/Cyrillic metadata, multi-artist credits, and verify word-synced candidates win over line-synced/plain fallbacks and that provider errors surface with the right kind.
2. Interactive desktop walkthrough and Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc` as described in Phase 4 milestone.

## Files in Scope
- `src/shared/{types.ts,lrc.ts,trackMatching.ts}`; `src/main/providers/{router.ts,lrclib.ts,localSidecar.ts,queue.ts}`
- `tests/{trackMatching.test.ts,providerRouter.test.ts,lrc.test.ts,lrclib.test.ts,lyricsQueue.test.ts,localSidecar.test.ts}`
- `docs/{PROGRESS.md,HANDOFF.md}`

## Constraints / Open Blockers
- Physical Android device with Poweramp required for hardware spot-check; cannot run in automated Windows CLI checks.
- Sandbox note: `.git`/`node_modules` owned by `BUILTIN/Administrators` can cause `EPERM` on `.git/index.lock`; run Git/Vitest/build/packaging outside the sandbox if needed.
