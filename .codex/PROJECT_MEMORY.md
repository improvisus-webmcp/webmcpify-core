# Project Memory

## Project Overview

- `@improvisus/webmcpify-core` is an MIT-licensed TypeScript/ESM package that creates, reviews, applies, tests, and independently verifies WebMCP capabilities for existing web applications.
- It ships three entry points: the `webmcpify` CLI, a local stdio MCP server (`webmcpify-mcp`), and an optional Temporal worker (`webmcpify-worker`).
- The normal product flow is: discover → draft → security check → human review → apply → browser test → independent verification.
- Development uses pnpm and strict TypeScript. Supported Node versions are `^20.19.0`, `^22.12.0`, or `>=23`.

## Architecture

- `src/cli.ts` defines CLI commands and managed-browser wrappers; `src/mcp/server.ts` exposes the confined stdio MCP surface; `src/temporal/worker.ts` starts optional durable workflows.
- `src/commands/` contains workflow stages. `run.ts` is the standard orchestration path; discovery, generation, security, review, apply, test, evaluation, repair, baseline, and final evaluation remain separately callable.
- `src/lib/` contains discovery, provider execution, disposable agent workspaces, proposal/task validation, security auditing, patch lifecycle, preflight checks, browser/CDP management, scoring, trajectories, configuration, and optional Temporal loading.
- Coding agents work in disposable copies. The target checkout changes only when an exact approved patch is applied; failed target checks trigger rollback.
- Browser agents receive approved tasks and browser tooling rather than source access. Independent scoring checks fresh live-page state instead of trusting provider output.
- Target-owned state and run evidence live under the target project's ignored `.webmcpify/` directory. `tasks.json` is the approved browser-verifiable task set. Generated `dist/` mirrors compiled `src/` and is never edited directly.

## Important Decisions

- Human approval is mandatory and bound to the exact tool set, task set, patch, source state, approval ID, and task fingerprint.
- Generation is grounded in discovered application behavior and produces a pending patch; it does not modify the target directly.
- Consequential tools must declare access-control evidence. Blocking gaps in user/agent binding, backend authorization, origin scope, quotas, replay protection, or input bounds prevent approval.
- MCP repository paths are confined to the server's starting workspace.
- Browser checks use Chrome DevTools MCP with an existing CDP endpoint or a managed isolated Chrome process.
- Temporal is optional and lazily loaded; ordinary `run` and one-shot repair do not require it.
- Core does not load a target application's `.env`, require GitHub access, or upload the target repository.

## Conventions / Constraints

- Use ESM with NodeNext resolution, strict TypeScript, and source files under `src/`.
- Preserve user changes and keep patches narrowly scoped. Do not edit `dist/`, secrets, target `.webmcpify/` artifacts, or generated trajectories.
- A target must have an initial Git commit for generation/apply, and installed dependencies are used for available target checks.
- Behavioral changes should include a self-contained focused verifier under `scripts/`; user-visible changes also require `CHANGELOG.md` updates.
- Standard validation is `pnpm typecheck`, `pnpm test`, `pnpm audit --prod`, `npm pack --dry-run`, and `git diff --check`; use the smallest relevant subset during iteration.
- Keep secrets server-side and out of commits. Never expose private values through `NEXT_PUBLIC_*` variables.
- Use Serena, Context7, RTK, and Repomix conditionally as described in `AGENTS.md`; verify availability in each session.

## Completed Major Work

- Implemented structured project discovery, grounded tool proposals, task validation, and disposable-workspace diff capture.
- Implemented two-step human review, exact approval persistence, stale-approval invalidation, safe patch application, build checks, and rollback.
- Added the Core security checkpoint and both CLI/MCP security audit surfaces.
- Added isolated browser testing, independent task scoring, project-scoped baseline/WebMCP evaluation, repair evidence, and final-evaluation orchestration.
- Added the normal end-to-end `webmcpify run` path, provider auto-detection, managed Chrome support, MCP configuration merging, and target-local evidence storage.
- Added optional durable Temporal repair orchestration and focused verification scripts for the major lifecycle boundaries.
- Package metadata currently reports version `1.0.3`; `CHANGELOG.md` contains additional unreleased work after that release.

## Current Work

- Project-context initialization added root `AGENTS.md` and this durable memory file only; no application source was changed.
- At initialization, HEAD matched `main`/`origin/main` at commit `28c6577`, with no tracked application-code diff.
- A pre-existing untracked `.serena/` directory contains local Serena configuration. It is user-owned and has intentionally been left unchanged.

## Known Issues / Limitations

- WebMCP and supporting browser behavior are experimental and runtime capability must be detected rather than assumed.
- Static security analysis cannot prove backend enforcement. Universal provider attestation and production policy storage/adapters are not implemented.
- Browser testing requires a reachable development or staging URL plus a compatible WebMCP-enabled Chrome/Chromium build; first-time Chrome DevTools MCP use may require registry access if it is not cached.
- Durable repair/final-evaluation requires optional Temporal packages, a running Temporal service, and a worker.
- The changelog does not claim a live final benchmark result for the advanced evaluation flow; focused fixture verification is the current documented evidence.

## Next Steps

- Keep the context files current and commit future durable updates with the relevant scoped work.
- Replace this initialization snapshot in `Current Work` when a concrete feature, fix, or release task begins.
- For behavior changes, add focused verification, update `CHANGELOG.md`, and run the relevant validation before the full release checklist.
- Treat provider attestation, backend policy adapters, and live final-evaluation runs as explicit future work only when separately scoped.
