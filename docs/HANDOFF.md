# Active Handoff

- Updated: 2026-11-27 01:40 IST
- Last agent: builder
- Branch: `arena/bae40d43-lyrics-embedder`
- Base commit: `213da83` (verified with `git log -n 1 --format=%h -- . ":(exclude)docs/"`). This clone is shallow (`git rev-parse --is-shallow-repository` → `true`); do not assume history was squashed. Pass A is `b021dea`/`b73e9ab` on this branch; the branch was rebased onto the published remote head, so older notes citing `9b4f114`/`96a8164`/`e7f962e`/`ac2044d` refer to pre-rebase SHAs of identical content.

## Current Goal
Pass B (NetEase multi-layer sources + opt-in OpenAI-compatible AI translation/romanization) is implemented and verified on Linux. **Bugs 2–8 fixed**: deduped `stackLrcLayers`, seek nonce guard, cross-track draft loading for batch embed, empty-primary persist, and renderer error boundary. Windows packaging + `--smoke-test` verified on Windows.

## Completed Since Last Handoff
1. **NetEase provider** (`src/main/providers/netease.ts`): `id: 'netease'`, `concurrency = 1` queue, >= 500 ms end-to-start pacing recorded in `finally`, `AbortSignal`, bounded 429/503 backoff with `Retry-After`, typed `ProviderError`s. Queries `/api/search/get/web` then `/api/song/lyric` with `Referer: https://music.163.com/` + browser `User-Agent`; extracts `lrc.lyric` / `tlyric.lyric` / `romalrc.lyric`, scores with `scoreCandidate` + `detectLyricsTimingKind`, routes through `evaluateCandidate`. `searchAllCandidates` caps lyric fetches to the top 5 metadata-scored songs.
2. **Multi-layer transport**: `LyricsProviderId` is `'lrclib' | 'netease' | 'localSidecar'`; candidates/results carry `translatedLyrics`/`romanizedLyrics`; `LyricsSearchRequest.providerIds` filters the sifter. `lyrics:searchCandidates` runs providers sequentially, tolerates a single-provider failure (partial results still return), and only throws when nothing was collected. Batch fetch now persists bundled layers into the draft.
3. **Encrypted settings** (`src/main/settingsStore.ts`, Electron-free): atomic `userData/settings.json` behind a `writeQueue`, injected async `SecretCipher`, `0600` file mode, re-encrypt on `shouldReEncrypt`. `getPublicSettings()` returns `hasApiKey` only — the plaintext key never reaches the renderer.
4. **safeStorage wiring** (`src/main/index.ts`): Electron 45 async API only (`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`); Linux `basic_text` is treated as unavailable. Deprecated sync calls are not used. AI jobs are aborted on `before-quit`.
5. **AI translator** (`src/main/providers/aiTranslator.ts`): `/chat/completions`, `concurrency = 1`, 60 s timeout, per-job `AbortController`, `Authorization: Bearer` only when a key is set, `ProviderError` classification (401/403 → credentials, 429 → rate limit).
6. **Prompt/parse boundary** (`src/shared/aiTranslate.ts`): `validateAiBaseUrl`, `extractTranslatableLines`, `buildAiLyricsMessages`, `parseAiResponseAndRebuildLrc`. Model output is JSON-keyed by integer index and timestamps are always taken from the source — LLM timestamps are never trusted.
7. **UI**: `SettingsModal.tsx` (5 presets, Base URL, write-only API key + `Saved securely` + `Clear Key`, model, target language, romanization style) opened via `File > Settings…` / `Ctrl+,` / gear buttons. Find gained provider pills (All/Local/LRCLIB/NetEase), `+T`/`+R` badges, and `Load All Layers`. Layers mode + Actions popover gained `AI Translate` / `AI Romanize` with inline `Cancel`; results land in the secondary layers only and trigger auto-save.
8. **Docs**: `AGENTS.md` no longer claims the AI client is v2-only; it now records the NetEase + AI invariants.
9. **Bug 2 (stackLrcLayers dedup)**: `stackLrcLayers` in `src/shared/lrc.ts` now collapses identical text at the same rounded centisecond timestamp so re-stacking is idempotent and embeds cannot grow the line count. Covered by `tests/lrc.test.ts`.
10. **Bug 4 (seek nonce guard)**: Pure `createNonceGuard` in `src/shared/nonceGuard.ts` ensures each `seekRequest.nonce` is applied once. Wired into `AudioPreviewPlayer.tsx`. Covered by `tests/nonceGuard.test.ts`.
11. **Bug 6 (renderer error boundary)**: Added `ErrorBoundary` in `src/renderer/src/components/ErrorBoundary.tsx` wrapping `<App />` in `main.tsx` to surface render crashes (e.g., React #310 hook-order) with a Reload button instead of a blank screen.
12. **Bug 7 (cross-track draft loading for batch embed)**: `handleEmbedSelected` in `App.tsx` now reads the on-disk draft for non-focused tracks before embedding, so translation/romanization layers saved to disk are merged even when a stale primary is cached in memory.
13. **Bug 8 (empty-primary persist)**: `persistDraftNow` now saves when `dirty` even if `hasContent` is false. Clearing the primary text is a real edit and skipping the write let stale text reappear from the old draft on next load.

## Verification Status (Windows workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm test`: PASS (423 passed, 22 files)
- `npm run build`: PASS
- `npm run build:unpack`: PASS
- `.\release\win-unpacked\"Poweramp LRC Embedder.exe" --smoke-test`: PASS (`ready: true`, `taglibVersion: "2.5.1 (TagLib 2.3.2)"`)

## Exact Next Step
1. `npm run dev` walkthrough on Windows: open `Ctrl+,` and confirm the key saves with a `Saved securely` badge and never reappears in plaintext; point at `http://localhost:11434/v1` with Ollama and confirm AI Translate fills only the Translation column while the primary is untouched; run Find on a J-pop/C-pop track and confirm NetEase `+T`/`+R` badges, provider pills, and `Load All Layers`; confirm `http://` remote URLs are rejected in Settings.
2. Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`, including a stacked NetEase translation embed.

## Constraints / Open Blockers
- Physical Android device with Poweramp required for the hardware spot-check.
- No live NetEase or chat-endpoint calls were made from this container; both clients are covered by injected-`fetch` unit tests.