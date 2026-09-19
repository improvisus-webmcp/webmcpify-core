# Repository Instructions

## Session startup and continuity

- At the start of every Codex session, read this `AGENTS.md` first, then read `.codex/PROJECT_MEMORY.md`.
- Inspect the current Git branch, status, and relevant diff as needed. Treat the working tree and current code as the source of truth, preserve user-owned changes, and continue from the current state rather than reconstructing prior work.
- After meaningful work, update `.codex/PROJECT_MEMORY.md` with durable changes, decisions, current work, limitations, and next steps. Update its existing sections; do not turn it into a chronological chat log.
- Never put credentials, private values, temporary debugging output, large diffs, or copies of source files in project memory.

## Context efficiency

- Verify that a tool is available in the current session before relying on it or claiming it is connected.
- Use Serena to locate symbols and references before reading large source files. Read only relevant files or ranges, and avoid rereading unchanged content.
- Use Context7 for current framework, library, SDK, API, CLI, or cloud-service documentation when needed.
- When RTK is installed, use `rtk <command>` for noisy tests, builds, Git output, and logs.
- Use Repomix only when broad or whole-repository analysis is genuinely required. Do not load repository-wide context for small tasks.

## Repository workflow

- Keep changes scoped. Do not refactor or modify unrelated application code.
- Source lives in `src/`; `dist/` is generated output and must not be edited directly.
- Preserve the human approval boundary, patch/source identity checks, workspace confinement, rollback behavior, and independent verification when changing generation or apply flows.
- Add or update a focused script under `scripts/` when behavior changes. Prefer focused verification while iterating; before release, run the checks documented in `CONTRIBUTING.md`.
- Keep secrets server-side and out of commits. Do not inspect or commit `.env`, target-owned `.webmcpify/` state, generated trajectories, or temporary workspaces. Never put private values in `NEXT_PUBLIC_*` variables.
