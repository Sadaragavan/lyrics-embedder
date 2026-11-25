---
name: handoff
description: Run lyrics-embedder verification gates, update docs/HANDOFF.md with exact Git state, and prepare a clean commit before switching AI agents.
---

# Handoff Exit Gate (`lyrics-embedder`)

Execute these steps in order before ending the session:

1. Run mandatory verification commands from `AGENTS.md`:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run build:unpack` (required if `audioWorker.ts`, `wasmPath.ts`, `electron.vite.config.ts`, or `electron-builder.yml` changed)
2. Run `git status --short` and `git diff --stat`. Confirm no `*.lrcembed.*.tmp.*` files, `.env` secrets, or unintended artifacts are modified or untracked.
3. Commit code, test, and `docs/PROGRESS.md` changes first (with user approval if shell confirmation is required), then capture `git branch --show-current` and `git log -n 1 --format=%h -- . ":(exclude)docs/"`.
4. Overwrite `docs/HANDOFF.md` with accurate timestamps (IST), last agent name, branch, that exact `Base commit` SHA, completed changes, exact check results, exact next step, files in scope, and open blockers. Keep `docs/HANDOFF.md` under 60 lines.
5. Commit `docs/HANDOFF.md` as a dedicated handoff commit (`docs: update handoff baton`) and leave the working tree clean.
6. Propose a concise commit message explaining why the change was made (commit only with user confirmation if shell approval is required).
7. Output a 3-line baton block for the next agent: `Commit SHA`, `Next Step`, and `Files in Scope`.
