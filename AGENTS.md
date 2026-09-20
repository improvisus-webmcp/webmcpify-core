# Repository Instructions

## Session startup and continuity

- At the start of every Codex session, read this file and run `pnpm run barry resume --task "<task>" --budget 800` before non-trivial work. Pass `--paths "path-a,path-b"` when the likely scope is known, and load only the routes Barry returns.
- Inspect the current Git branch, status, and relevant diff. Treat the working tree and code as the source of truth, preserve user-owned changes, and continue from the current state.
- Barry Cache is the sole persistent project-memory system. Do not create or use `.codex/PROJECT_MEMORY.md` or Serena memories for project history.
- After meaningful work, update source-backed Barry facts or an ADR when durable behavior changed, run `pnpm run barry validate`, then record the handoff with `pnpm run barry finalize --status <status> --summary "<summary>" --files "path-a,path-b"`.
- Never store credentials, private values, temporary debugging output, large diffs, or source-file copies in project memory.

## Context efficiency

- Verify a tool is available before relying on it or claiming it is connected.
- Use Serena to locate symbols and references before reading large source files. Read only relevant files or ranges and avoid rereading unchanged content.
- Use Context7 for current framework, library, SDK, API, CLI, or cloud-service documentation when needed.
- When RTK is installed, use `rtk <command>` for noisy tests, builds, Git output, and logs.
- Use Repomix only for genuinely broad repository analysis. Do not load repository-wide context for small tasks.

## Repository workflow

- Keep changes scoped. Do not refactor or modify unrelated application code.
- Source lives in `src/`; `dist/` is generated output and must not be edited directly.
- Preserve the human approval boundary, patch/source identity checks, workspace confinement, rollback behavior, and independent verification when changing generation or apply flows.
- Add or update a focused script under `scripts/` when behavior changes. Prefer focused verification while iterating; before release, run the checks documented in `CONTRIBUTING.md`.
- Keep secrets server-side and out of commits. Do not inspect or commit `.env`, target-owned `.webmcpify/` state, generated trajectories, or temporary workspaces. Never put private values in `NEXT_PUBLIC_*` variables.

<!-- barry-cache:start -->
## Barry Cache

- Canonical, reviewed context lives in `docs/context/`; operational handoffs live in ignored `.context-state/`; `.context-cache/` is disposable.
- Use `pnpm run barry route|search|load ...` for focused retrieval. Start narrow tasks at 800 tokens; use 1600–2000 for cross-cutting work, and expand specific missing fact IDs before loading more.
- Update or retire existing facts instead of duplicating them. Facts must exclude routine edits, transient test/debug output, commit logs, and source-file copies.
- Keep `finalize` to one outcome sentence plus status and affected files. Run `stats summary` and maintenance after releases or context restructuring, not after every small task.
- If user validation contradicts saved work, run `pnpm run barry failure record ...` before or while fixing it.
- Do not enable or contribute to Barry's shared CQ knowledge base without explicit user approval.
<!-- barry-cache:end -->
