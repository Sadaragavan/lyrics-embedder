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
3. Capture `git branch --show-current` and `git rev-parse --short HEAD`.
4. Overwrite `docs/HANDOFF.md` with accurate timestamps (IST), last agent name, branch, base commit SHA, completed changes, exact check results, exact next step, files in scope, and open blockers. Keep `docs/HANDOFF.md` under 60 lines.
5. Update `docs/PROGRESS.md` only if a milestone checkbox changed or a new technical constraint was discovered.
6. Propose a concise commit message explaining why the change was made (commit only with user confirmation if shell approval is required).
7. Output a 3-line baton block for the next agent: `Commit SHA`, `Next Step`, and `Files in Scope`.
