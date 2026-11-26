# Active Handoff

- Updated: 2026-11-26 15:35 IST
- Last agent: builder
- Branch: `arena/bae40d43-lyrics-embedder`
- Base commit: `9b4f114` (local branch point; this clone is shallow — `git rev-parse --is-shallow-repository` → `true` — so only 5 commits are visible. Non-docs HEAD after Pass A: `b021dea`.)

## Current Goal
Pass A (UX Cleanup & Unified Live Editor) is implemented and verified on Linux. Remaining: local Windows packaging + `--smoke-test`, interactive desktop walkthrough, Poweramp Android hardware spot-check.

## Completed Since Last Handoff
1. **Shared model**: new DOM-free `src/shared/lrcEditor.ts` (`parseEditableRows`, `serializeEditableRows`, `serializeEditableLayer`, `parseInlineTimestamp`, `isValidInlineTimestamp`); `LyricDraft`/`SaveDraftRequest` carry optional `translation`/`romanization`; `EditorLayout` is `'live' | 'raw'`; menu drops `save-draft`, renames `discard-draft` to `Revert to Embedded File`, exposes one `layout-live` radio.
2. **Persistence**: `validateSaveDraft` validates both layers as optional strings and applies the 1 MiB cap to the *combined* UTF-8 bytes; `JsonStore.saveDraft` writes non-empty (trimmed) layers atomically inside `enqueueWrite`; `readDraft` normalizes legacy single-layer drafts to `undefined`.
3. **Auto-save**: 500 ms debounced write on any primary/translation/romanization edit, with `flushAutoSave` before track switch and before embed; focus restores `draft.lyrics` + both layers so switching never drops layers; subtle `Saving...`/`Draft saved` indicator replaces manual Save Draft.
4. **No floating overlays**: transient info/success now uses a reserved status slot in the player dock beside the TagLib dot (auto-clears after 4 s); errors render in normal flex flow above `<main>`.
5. **Unified live editor**: `Edit | Layers | Find` mode bar with a single `Raw Text` toggle; per-row clickable `[mm:ss.xx]` pill (click seeks, double-click edits, validated by `parseInlineTimestamp`), inline primary input, hover `+`/`x`, indented dimmer Translation/Romanization sub-inputs, all matching rows highlighted together, auto-scroll only on timestamp change while focus is outside an input; plain lyrics fall back to a clean editable textarea; header has only `Revert` + `Embed`/`Embed Stacked`; footer keeps the source chip (→ Find) and layer visibility toggles.
6. **Find**: auto-runs the candidate search when the mode opens; `Load Primary` persists the draft and returns to Edit; single-track Fetch removed (only the sidebar `Fetch Selected` at `selectedCount >= 2`).
7. **Tests**: new `tests/lrcEditor.test.ts` (15 cases), multi-layer + legacy-draft cases in `tests/store.test.ts`, updated `tests/menu.test.ts`.

## Verification Status (Linux workspace)
- `npm run typecheck`: PASS (0 errors, node + web)
- `npm test`: PASS (265 passed, 4 platform-skipped, 269 total, 16 files)
- `npm run build`: PASS
- NOT run here on purpose: `npm run build:unpack`, `dist:win`, and the packaged `--smoke-test` (Windows-only; no Electron binary in this container).

## Exact Next Step
1. On Windows after merge/pull: `npm ci` → `npm run build:unpack` → run `Poweramp LRC Embedder.exe --smoke-test`; confirm exit 0, `ready: true`, `2.5.1 (TagLib 2.3.2)`.
2. `npm run dev` walkthrough at 1366x768: type into the live rows and confirm `Draft saved` appears with no manual save; switch tracks mid-edit and confirm the draft survives; double-click a timestamp pill and enter `00:75.00` (must be rejected); toggle Translation/Romanization and confirm the primary is untouched; confirm `Embed Stacked` writes both layers and `Revert` restores the embedded tags.
3. Poweramp Android hardware spot-check across `.flac`, `.opus`, `.m4a`, `.mp3`, `.wav` + `.lrc`.

## Constraints / Open Blockers
- Physical Android device with Poweramp required for the hardware spot-check.
- No Electron binary/Xvfb here, so the renderer was validated by `tsc`, `vitest`, the Vite production build, and emitted-CSS checks only.
- Pass A explicitly adds no new lyric providers and no LLM translation clients.
