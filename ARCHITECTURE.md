# WebMCPify Core architecture

Core is a local CLI and MCP server. It turns discovered application behavior into a reviewable source patch, applies only an exact human-approved patch, and verifies the live result independently.

```mermaid
flowchart LR
    CLI[CLI or Core MCP server] --> Discover[Source discovery]
    Discover --> Workspace[Disposable agent workspace]
    Workspace --> Proposal[Tools, tasks, and patch]
    Proposal --> Security[Core security checkpoint]
    Security --> Review[Local human review]
    Review --> Apply[Exact patch and build check]
    Apply --> Bridge[Chrome DevTools MCP]
    Bridge --> Browser[Isolated Chrome]
    Browser --> Verify[Independent task scoring]
    Verify --> Evidence[Target .webmcpify evidence]
    Verify -. failed task .-> Repair[Focused repair]
    Repair --> Review
    Temporal[Optional Temporal service] -. durable orchestration .-> Repair
```

## Runtime boundaries

- The target checkout is read during discovery and changed only by `apply` after approval.
- Coding agents edit a disposable copy without the target's `.git`, `.webmcpify`, or `node_modules` contents.
- Selected entries from the target's installed dependencies are linked into the disposable workspace for typecheck/build validation; they are not copied into it.
- Browser agents receive empty disposable workspaces, not copied source. Each task uses a fresh browser context and independent scoring of the exact acted-on page. Non-Claude adapters do not enforce the requested tool allowlist as an OS sandbox. See the [runtime audit](docs/audits/2026-10-01-runtime-compatibility.md).
- The independent scorer evaluates each approved `verify` expression against fresh live-page state.
- Temporal stores workflow progress only for optional durable repair. It does not replace approval or verification.

## Entry points

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Defines commands, options, package version, and managed-browser wrappers. |
| `src/mcp/server.ts` | Exposes repository analysis, generation, approved apply, and browser testing over stdio MCP; confines paths to its starting workspace. |
| `src/temporal/worker.ts` | Starts the optional Temporal worker and loads activities. |

## Commands

| File | Responsibility |
| --- | --- |
| `src/commands/run.ts` | Runs the normal discover → draft → review → apply → test → verify path. |
| `src/commands/discover.ts` | CLI wrapper for static project discovery. |
| `src/commands/generate.ts` | Creates a disposable workspace, invokes a provider, validates its source changes, and stores a pending proposal. |
| `src/commands/security.ts` | Audits proposed or approved tools and writes the project security report. |
| `src/commands/review.ts` | Serves tool-only selection with read-only contracts/tasks, asynchronous locked revision, and exact-patch two-step approval. |
| `src/commands/apply.ts` | Validates approval/source identity, applies the patch, runs target checks, and rolls back failure. |
| `src/commands/test.ts` | Runs approved tasks through the live browser and records independent results. |
| `src/commands/eval.ts` | Prints the latest project-scoped WebMCP test result. |
| `src/commands/repair.ts` | Drafts a focused patch from failed task evidence; optionally starts a Temporal workflow. |
| `src/commands/baseline.ts` | Measures the same approved tasks against the existing interface for comparison. |
| `src/commands/final-eval.ts` | Coordinates baseline, WebMCP, optional repair, Temporal comparison, checkpoints, and final evidence. |

## Core libraries

| File | Responsibility |
| --- | --- |
| `src/lib/discovery.ts` | Detects stack, routes, forms, actions, APIs, auth, state, and existing WebMCP signals. |
| `src/lib/agent-workspace.ts` | Copies a target into a temporary Git workspace, captures its real diff, and removes it. |
| `src/lib/agent-readiness.ts` | Merges target-root agent guides and public capability/crawler documentation into the same reviewed patch. |
| `src/lib/agent-discovery-content.ts` | Renders safe static HTML capability guidance and source-backed deployment/GEO/AEO checks without invented deployment URLs or indexing promises. |
| `src/lib/project-identity.ts` | Chooses a bounded project display name from discovery or the repository folder, shared by review and public guidance. |
| `src/lib/agent.ts` | Normalizes provider invocation, MCP configuration, timeouts, output capture, and process cleanup. |
| `src/lib/claude.ts` | Implements the Claude-specific provider invocation. |
| `src/lib/ai-provider.ts` | Validates a selected provider or detects an installed provider CLI. |
| `src/lib/executables.ts` | Resolves provider executables from `PATH`, optional overrides, standalone/editor Codex installations, and classifies launch failures without exposing raw diagnostics. |
| `src/lib/generation-metadata.ts` | Validates generated tools/tasks and permits one metadata-only correction with source/Git identity and valid-contract preservation checks. |
| `src/lib/review-selection.ts` | Revises a pending patch for selected tools in a disposable workspace, checks retained contracts/source/security, updates tasks/docs, and returns a new unapproved draft. |
| `src/lib/review-ui.ts` | Locks review controls immediately, polls revision progress, and automatically reopens a fresh draft. |
| `src/lib/review-files.ts` | Describes every actual patch path with change type and grounded file-role/tool-placement explanations. |
| `src/lib/cli-progress.ts` | Provides safe stderr-only phase activity with elapsed time and cleanup on success or failure. |
| `src/lib/canonical-json.ts` | Compares immutable JSON contracts without treating object-key order as a change. |
| `src/lib/prompts.ts` | Holds deterministic discovery, placement, proposal, and task-authoring instructions. |
| `src/lib/webmcp-spec-guidance.ts` | Holds the WebMCP compatibility, lifecycle, privacy, and security rules supplied to providers. |
| `src/lib/tool-proposals.ts` | Parses, normalizes, validates, persists, and reloads structured tool proposals. |
| `src/lib/security-audit.ts` | Checks declared user/agent binding, backend authorization, origins, quotas, replay protection, sensitive inputs, and schema bounds. |
| `src/lib/task-verification.ts` | Checks task verification expressions for unsafe or invalid patterns. |
| `src/lib/tasks.ts` | Validates uncapped task sets with a rounded-up 30% margin over initial/retained tool count, enforces coverage, fingerprints them, and binds them to approval. Legacy approved task sets remain readable. |
| `src/lib/patches.ts` | Extracts safe Git patches, validates paths and source state, and stores patch metadata. |
| `src/lib/preflight.ts` | Runs target typecheck/build inside the disposable workspace before review. |
| `src/lib/package-manager.ts` | Chooses the target package manager and anchors its executable before changing workspace; environment launch failures do not trigger LLM source repair. |
| `src/lib/mcp-config.ts` | Reuses or safely merges user MCP configuration with Core's pinned Chrome DevTools MCP bridge. |
| `src/lib/browser.ts` | Reuses configured CDP or starts and cleans an isolated WebMCP-enabled Chrome process. |
| `src/lib/scoring.ts` | Creates isolated pages, checks the WebMCP runtime, evaluates tasks, and closes CDP. |
| `src/lib/target-url.ts` | Normalizes target URLs and checks reachability. |
| `src/lib/trajectories.ts` | Stores project-scoped run output and evidence under `.webmcpify/trajectories`. |
| `src/lib/config.ts` | Resolves optional feature flags such as durable repair. |
| `src/lib/temporal.ts` | Lazily loads optional Temporal packages with a clear installation error. |
| `src/lib/load-env.ts` | Loads optional Core development settings without importing the target application's `.env` secrets. |
| `src/lib/package-info.ts` | Reads the installed package name and version. |
| `src/lib/paths.ts` | Resolves the installed package root independently of the current directory. |
| `src/lib/eval.ts` | Keeps the former scoring import path compatible. |

## Temporal files

| File | Responsibility |
| --- | --- |
| `src/temporal/workflows.ts` | Defines the retry loop: test, draft repair, wait for review, apply, and retest. |
| `src/temporal/activities.ts` | Adapts existing Core command functions into Temporal activities. |
| `src/temporal/worker.ts` | Connects those workflows and activities to the configured task queue. |

## Verification and build files

| File | Responsibility |
| --- | --- |
| `scripts/clean.mjs` | Removes `dist` before compilation so stale modules cannot ship. |
| `scripts/verify-mcp.mjs` | Tests MCP identity, tools, workspace confinement, and browser MCP config merging. |
| `scripts/verify-discovery.mjs` | Tests framework, route, action, API, and WebMCP discovery with a temporary fixture. |
| `scripts/verify-tool-proposals.mjs` | Tests structured proposal parsing and grounding. |
| `scripts/verify-agent-invocation.mjs` | Tests provider invocation, executable paths, safe launch diagnostics, and terminal redaction. |
| `scripts/verify-generation-recovery.mjs` | Exercises generation metadata recovery and fail-closed source/contract checks using credential-free providers in disposable repositories. |
| `scripts/verify-browser-state.mjs` | Tests real Chrome same-tab scoring, retained task state, expected-error matching, forbidden-state rejection, and personal-context preservation. |
| `scripts/verify-security-audit.mjs` | Tests pass/block decisions for consequential access-control contracts. |
| `scripts/verify-review.mjs` | Tests read-only tasks/contracts, tamper rejection, confirmation, persistence, cancellation, and rejection. |
| `scripts/verify-partial-review.mjs` | Tests removal of rejected registrations, retained-only contracts/tasks/docs, preserved original app actions, fresh patch confirmation, and refused unsafe revisions. |
| `scripts/verify-review-browser.mjs` | Tests real Chrome review locking across tabs/refreshes, automatic reopen, repeated removal, and final confirmation. |
| `scripts/verify-patch-lifecycle.mjs` | Tests patch validation, approval gating, apply, and rollback. |
| `scripts/verify-repair.mjs` | Tests failure selection, focused repair patches, review boundaries, and regression evidence. |
| `scripts/verify-evaluation.mjs` | Tests shared task identity and project-scoped evaluation lookup. |
| `scripts/verify-final-eval.mjs` | Tests orchestration order, task-set consistency, and new-file diff capture. |
| `package.json` | Defines package metadata, commands, runtime dependencies, optional Temporal peers, tests, and publish contents. |
| `pnpm-lock.yaml` | Locks the development dependency graph. |
| `pnpm-workspace.yaml` | Defines approved dependency build scripts and the patched development resolution. |
| `tsconfig.json` | Compiles `src` to ESM in `dist`. |
| `.env.example` | Documents optional runtime overrides; no `.env` is required. |
| `.gitignore` | Excludes secrets, builds, local Core state, and generated evidence. |
| `README.md` | Provides the short product and usage guide. |
| `CONTRIBUTING.md` | Defines the pull-request, verification, security-reporting, and release process. |
| `CHANGELOG.md` | Records user-visible changes and verification claims. |
| `LICENSE` | Contains the MIT license. |

`dist/` is generated by TypeScript and published to npm. Do not edit it directly.

## Target-owned artifacts

Core writes these only inside the selected target project:

| Artifact | Purpose |
| --- | --- |
| `.webmcpify/discovery.json` | Static project map used as generation evidence. |
| `.webmcpify/proposed-tools.json` | Validated structured tool proposal. |
| `.webmcpify/pending-diff.patch` and `.meta.json` | Exact pending patch and its source identity/status. |
| `.webmcpify/approved-tools.json` | Human-approved tool/task manifest and fingerprint. |
| `.webmcpify/security-report.json` | Static Core access-control report shown before approval. |
| `tasks.json` | Approved browser-verifiable task set. |
| `.webmcpify/chrome-devtools-mcp.json` | Generated/merged browser MCP config when the target config is incomplete. |
| `.webmcpify/trajectories/` | Provider output, evaluations, and audit evidence. |
| `.webmcpify/rollback/` | Temporary snapshots used while applying a patch. |
| `.webmcpify/stale/` | Previous approval state invalidated by a new generation. |
| `.webmcpify/final-eval-state.json` | Resume checkpoint for advanced final evaluation. |
| `AGENTS.md` | One reviewed guide combining repository-maintenance and detailed site-capability instructions; separate from private run state. |
| Served `llms.txt`, `webmcp.md`, and `robots.txt` | Reviewed public discovery guidance and scoped metadata crawler policy; deployment location is framework-dependent. |
