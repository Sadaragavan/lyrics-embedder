# Active Handoff

- Updated: 2026-11-26 19:05 IST
- Last agent: builder
- Branch: `arena/bae40d43-lyrics-embedder`
- Base commit: `213da83` (verified with `git log -n 1 --format=%h -- . ":(exclude)docs/"`). This clone is shallow (`git rev-parse --is-shallow-repository` → `true`); do not assume history was squashed. Pass A is `b021dea`/`b73e9ab` on this branch; the branch was rebased onto the published remote head, so older notes citing `9b4f114`/`96a8164`/`e7f962e`/`ac2044d` refer to pre-rebase SHAs of identical content.

## Current Goal
Pass B (NetEase multi-layer sources + opt-in OpenAI-compatible AI translation/romanization) is implemented and verified on Linux. Remaining: Windows packaging + `--smoke-test`, interactive desktop walkthrough, Poweramp Android hardware spot-check.

## Completed Since Last Handoff
1. **NetEase provider** (`src/main/providers/netease.ts`): `id: 'netease'`, `concurrency = 1` queue, >= 500 ms end-to-start pacing recorded in `finally`, `AbortSignal`, bounded 429/503 backoff with `Retry-After`, typed `ProviderError`s. Queries `/api/search/get/web` then `/api/song/lyric` with `Referer: https://music.163.com/` + browser `User-Agent`; extracts `lrc.lyric` / `tlyric.lyric` / `romalrc.lyric`, scores with `scoreCandidate` + `detectLyricsTimingKind`, routes through `evaluateCandidate`. `searchAllCandidates` caps lyric fetches to the top 5 metadata-scored songs.
2. **Multi-layer transport**: `LyricsProviderId` is `'lrclib' | 'netease' | 'localSidecar'`; candidates/results carry `translatedLyrics`/`romanizedLyrics`; `LyricsSearchRequest.providerIds` filters the sifter. `lyrics:searchCandidates` runs providers sequentially, tolerates a single-provider failure (partial results still return), and only throws when nothing was collected. Batch fetch now persists bundled layers into the draft.
3. **Encrypted settings** (`src/main/settingsStore.ts`, Electron-free): atomic `userData/settings.json` behind a `writeQueue`, injected async `SecretCipher`, `0600` file mode, re-encrypt on `shouldReEncrypt`. `getPublicSettings()` returns `hasApiKey` only — the plaintext key never reaches the renderer.
4. **safeStorage wiring** (`src/main/index.ts`): Electron 45 async API only (`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`); Linux `basic_text` is treated as unavailable. Deprecated sync calls are not used. AI jobs are aborted on `before-quit`.
5. **AI translator** (`src/main/providers/aiTranslator.ts`): `/chat/completions`, `concurrency = 1`, 60 s timeout, per-job `AbortController`, `Authorization: Bearer` only when a key is set, `ProviderError` classification (401/403 → credentials, 429 → rate limit).
6. **Prompt/parse boundary** (`src/shared/aiTranslate.ts`): `validateAiBaseUrl`, `extractTranslatableLines`, `buildAiLyricsMessages`, `parseAiResponseAndRebuildLrc`. Model output is JSON-keyed by integer index and timestamps are always taken from the source — LLM timestamps are never trusted.
7. **UI**: `SettingsModal.tsx` (5 presets, Base URL, write-only API key + `Saved securely` + `Clear Key`, model, target language, romanization style) opened via `File > Settings…` / `Ctrl+,` / gear buttons. Find gained provider pills (All/Local/LRCLIB/NetEase), `+T`/`+R` badges, and `Load All Layers`. Layers mode + Actions popover gained `AI Translate` / `AI Romanize` with inline `Cancel`; results land in the secondary layers only and trigger auto-save.
8. **Docs**: `AGENTS.md` no longer claims the AI client is v2-only; it now records the NetEase + AI invariants.

## Verification Status (Linux workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm test`: PASS (364 passed, 4 platform-skipped, 368 total, 20 files)
- `npm run build`: PASS
- NOT run here on purpose: `npm run build:unpack`, `dist:win`, packaged `--smoke-test` (Windows-only; no Electron binary in this container).

## Exact Next Step
1. On Windows: `npm ci` → `npm run build:unpack` → `.\release\win-unpacked\"Poweramp LRC Embedder.exe" --smoke-test`; confirm exit 0, `ready: true`, `2.5.1 (TagLib 2.3.2)`.
2. `npm run dev` walkthrough: open `Ctrl+,` and confirm the key saves with a `Saved securely` badge and never reappears in plaintext; point at `http://localhost:11434/v1` with Ollama and confirm AI Translate fills only the Translation column while the primary is untouched; run Find on a J-pop/C-pop track and confirm NetEase `+T`/`+R` badges, provider pills, and `Load All Layers`; confirm `http://` remote URLs are rejected in Settings.
3. Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`, including a stacked NetEase translation embed.

## Constraints / Open Blockers
- Physical Android device with Poweramp required for the hardware spot-check.
- No Electron binary/Xvfb here, so the renderer was validated by `tsc`, `vitest`, and the Vite production build only.
- No live NetEase or chat-endpoint calls were made from this container; both clients are covered by injected-`fetch` unit tests.
