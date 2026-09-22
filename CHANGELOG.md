# Changelog

All notable changes to WebMCPify are documented here.

## [Unreleased]

### Fixed: provider task/tool output mixing

- Generation now recovers when a provider accidentally appends an unmistakable
  verification-task entry to `TOOL_PROPOSALS_JSON`, while malformed real tool
  definitions remain validation errors.
- Prompt guidance now explicitly forbids placing the tool-registration
  verification task in the WebMCP tool array.

### Changed: selectable run security policy

- Added `webmcpify run --security balance|ignore|strict`, defaulting to
  `balance`.
- Balanced mode gates genuinely high-impact actions such as checkout and
  payment without requiring backend identity, quotas, replay controls, or
  arbitrary string limits for reversible cart and filtering actions.
- Ignore mode bypasses automated security findings while retaining exact-patch
  human approval; strict mode preserves the previous security behavior.

### Added: Core security checkpoint

- Added per-tool access declarations for user authentication, agent identity, backend authorization, origin scope, quotas, and idempotency.
- Added `webmcpify security` and the `audit_webmcp_security` MCP tool, both writing `.webmcpify/security-report.json`.
- Generation now stops before creating an approvable patch when a state-changing proposal has blocking access-control gaps.
- Review surfaces non-blocking privacy and schema findings and refuses tools that still have blocking findings after edits.
- Added focused verification for secure consequential tools and missing agent, quota, and replay controls.
- Kept cryptographic provider attestation and production policy storage out of scope until an interoperable trust format and backend adapters are defined.

### Simplified: first-run and package architecture

- Added `webmcpify run` as the normal discover, draft, review, apply, test, and verification path.
- Added provider auto-detection and automatic isolated Chrome management for normal browser checks.
- Safely merges Chrome DevTools MCP into a generated config when a target's `.mcp.json` does not provide it.
- Made target paths default to the current directory where practical.
- Stopped loading target-project `.env` files into provider subprocesses.
- Removed the no-op `init` command and the residual demo project.
- Moved Temporal to an optional advanced install instead of making every user download its runtime.
- Restricted npm contents to compiled runtime files and essential documentation.
- Cleaned compiled output before builds so removed modules cannot enter a release.
- Moved all run evidence into the target project's ignored `.webmcpify/` directory.
- Made CLI and MCP version reports read directly from package metadata.
- Updated the local review server dependencies and resolved the production audit findings.
- Aligned the Node requirement with the pinned Chrome DevTools MCP runtime.
- Added concise architecture, target-state, contribution, and release documentation.
- Replaced the duplicated long-form README with a concise usage and safety guide.

### Hardened: review, approval, and final-evaluation lifecycle

The review boundary now requires a two-step confirmation and persists the
complete approved tool/task state with a shared approval ID and task
fingerprint. Reopening an already-approved draft shows a locked state, while
stale approvals are invalidated when a new generation starts. Task selection
is taken only from the generated draft, fixing the failure mode where a
review could leave `tasks.json` empty.

Focused review, patch, evaluation, repair, and final-eval fixtures passed,
including approval gating, atomic persistence verification, repeated-form
selection, and failed-build rollback. The available local Coffee Store
directory was empty, so no new live discovery or browser result is claimed.

### Added: end-to-end final evaluation orchestration

Added `pnpm webmcpify final-eval --path <project>` to connect the existing
discovery/generation, human review, source apply, independent scoring, repair,
and Temporal workflow stages. It preserves one approved task snapshot and
fingerprint across Level 1 plain baseline, Level 2 WebMCP, and Level 3 durable
Temporal results, then records a project-scoped comparison trajectory.

The baseline stage is read-only and runs before the approved patch is applied.
Repairs still enter the existing repair → review → apply path; approved repair
results are retested, while rejected, failed, or unavailable stages remain
explicitly recorded. Focused orchestration verification passed. No live final
benchmark result is claimed until the command is run against the target with
Antigravity, Chrome DevTools MCP, and Temporal available.

### Added: approved repair workflow

Repair now selects the project-scoped baseline or WebMCP evaluation, supplies
failed task definitions and their actual verification details to the agent,
and runs the agent in a temporary copy of the target. The resulting Git diff
is extracted into the existing `pending-diff.patch` flow; the target checkout
is not modified until human review and `apply` approval.

Successful approved application records an affected-task `repair-eval` with
before/after results and explicit improved, unchanged, or regressed status.
Failed repair attempts, no-change repairs, patch failures, and evaluation
errors remain as timestamped trajectory artifacts. Temporal repair remains
compatible because it continues to use the existing plain repair activity
boundary.

The focused repair verification covers failed-task selection, project-scoped
evaluation lookup, repair context, real diff extraction, approval refusal,
successful patch application, and preserved no-improvement/regression
evidence. No live provider or browser success is claimed.

### Added: project-scoped baseline and WebMCP evaluation

Baseline and WebMCP test runs now snapshot the same approved `tasks.json`,
record a task-set fingerprint, run ID, target project, evaluation mode, and
task-level independent scores. The scorer opens a fresh page for every task,
clears cookies and web storage, reloads the target, and closes the page after
verification so task state does not leak across runs.

Trajectory lookup can now be scoped to a target project; `eval`, review, and
plain repair no longer have to select a globally latest artifact. Focused
fixture verification confirms identical task definitions, per-task baseline
versus WebMCP comparison data, and project-isolated trajectory selection.
No live AI provider was used.

### Added: structured human review and verification integrity

Review now consumes `.webmcpify/proposed-tools.json`, displays each complete
structured tool proposal, allows practical JSON edits, and persists the final
approved definitions in `.webmcpify/approved-tools.json`. Approval remains an
explicit human decision; rejection leaves the prior manifest unchanged.

Task verification is now checked for empty, syntactically invalid, and trivial
expressions. Review surfaces statically detectable missing selectors, state,
and tool references as warnings without introducing a security sandbox.

The focused review fixture verified structured tool display/edit persistence,
approval and rejection, valid task persistence, and verification error/warning
detection. `pnpm tsc --noEmit` and `pnpm build` pass. No live AI provider is
required for this phase.

### Added: structured tool generation

Generation now consumes the target project's structured `discovery.json` and
requires a JSON tool proposal containing names, descriptions, parameter
schemas, implementation handlers/actions, placement strategy, and source
files. Valid proposals are written to `.webmcpify/proposed-tools.json` and
recorded as `proposed-tools-*` trajectory artifacts.

Validation rejects malformed schemas, duplicate names, unknown source files,
unsupported authentication/API capabilities, and declarative tools when no
discovered forms exist. The implementation remains domain-agnostic and does
not apply source changes.

Focused validation passed against both local requested project checkouts,
including proposal-file serialization, duplicate-name rejection, malformed
schema rejection, and unsupported-source rejection.
Real Codex generation was attempted for the Coffee Store checkout but the
provider did not return a result, so no target generation success is claimed.
`pnpm tsc --noEmit` and `pnpm build` pass.

### Added: structured project discovery

Added a domain-agnostic discovery module and `webmcpify discover` command.
Discovery scans project metadata and focused source files for the stack,
package manager, routes, UI actions, APIs/handlers, authentication and state
signals, existing WebMCP, and project capabilities. Results are persisted to
`.webmcpify/discovery.json` and recorded as `discovery-*` trajectory artifacts.

Generation now runs discovery first and supplies the saved structured result to
the generation agent, making discovery reusable rather than prompt-only.

Verification ran against local checkouts of `webmcp-coffee-store` and
`commerce`; both produced valid JSON with useful project signals. `pnpm
tsc --noEmit` and `pnpm build` pass, and the focused discovery verification
script passes for both projects.

### Added: approved source-diff application pipeline

Generation now extracts and validates the provider's real unified diff into
the target project's `.webmcpify/pending-diff.patch`, with commit, working-tree,
changed-file, and run metadata in `pending-diff.meta.json`. Review displays the
exact patch and requires an explicit source-diff approval tied to that run.

The new `apply` command validates the approval and source fingerprint, applies
the patch through Git, runs available `typecheck` and `build` scripts, and
records the patch/apply/build evidence in the existing trajectory system. It
creates per-file rollback snapshots and restores them if application or build
verification fails.

The implementation deliberately uses Git as the safety boundary instead of
introducing a second patch/version-control system. Focused lifecycle
verification covers successful application, missing approval, invalid patches,
and failed-build rollback; `pnpm tsc --noEmit` and `pnpm build` also pass.

### Added

- Provider-agnostic baseline execution for Gemini, Claude Code, Codex, and Antigravity CLI (`agy`).
- Raw agent trajectory capture in `trajectories/baseline.json`.
- Independent Playwright/Chrome checks for catalog rendering, roast filtering, cart updates, localStorage persistence, reload persistence, and login state.
- Executable discovery through `PATH`, Codex VS Code extension installs, and optional `.env` overrides.
- `.env.example` for local provider and Chrome path configuration without committing machine-specific settings.
- Optional MCP configuration bridging for providers that support it.
- Generation strategy selection (`declarative`, `imperative`, or `auto`) with
  drafts captured in `trajectories/generate.json`.
- A local review UI that records the human-approved tool manifest before an
  isolated test run.
- Isolated test, repair, and evaluation commands with separate raw agent and
  independently scored evaluation artifacts.
- Baseline and generation prompts now infer the site's actions from its
  codebase instead of assuming a coffee-store domain.
- The independent evaluator now discovers generic page actions and structural
  WebMCP surface checks instead of using coffee-store selectors or state keys.

### Changed

- Baseline no longer requires a pre-existing `.mcp.json`, native WebMCP registration, or WebMCP-enabled source code. A plain site is a valid baseline starting point.
- Missing optional MCP configuration is skipped instead of failing the baseline.
- Baseline trajectories are saved in WebMCPify's tracked `trajectories/` directory regardless of the directory from which the command is launched.
- CLI failures now print a concise error instead of an uncaught stack trace.
- Test runs create a project-local Chrome DevTools MCP configuration only when
  the site does not already provide one; existing `.mcp.json` files are left
  untouched.

### Architectural note

The agent runner is intentionally provider-agnostic so baseline results are reproducible across supported coding agents rather than being tied to Claude Code. The independent evaluator remains separate from the agent session so pass/fail results are based on live site behavior, not the agent's self-report.

Cross-provider pass-rate comparisons are pending additional runs using the same site and task list.

### Iteration: added Temporal for durable execution — motivated by large-codebase failures

**What I tried and why:** The initial repair loop was plain async code with a
manual retry counter. Testing against a small site (`webmcp-coffee-store`)
worked fine, but running the same pipeline against a larger, real-world
codebase (`vercel/commerce`) exposed the actual problem: the underlying agent
session timed out or errored partway through exploring a much bigger codebase.
A plain retry restarted the entire attempt from scratch, losing the progress it
had made and re-burning tokens re-reading files it had already seen.

**Evidence:** On `vercel/commerce`, the plain (`--no-durable`) `generate` call
failed after approximately 300 seconds with `Command timed out after 300000ms`,
having already consumed over 800K input tokens re-scanning the codebase. The
retry started over from zero rather than resuming. Under `--durable`, the same
failure was caught as a Temporal `ActivityTaskFailed` event, automatically
retried according to `maximumAttempts: 3`, and the workflow state (which task
and which attempt) persisted across the failure. This was confirmed through the
Temporal Web UI event history.

**Decision:** Kept Temporal opt-in through `init --with-temporal`. The gain is
not in the model's reasoning; it is reliability. Durable execution matters
specifically once codebase size pushes a single agent session close to its
time/context limits, which is a realistic failure mode for any site larger than
a small demo app. The plain version remains available for simpler runs and
reproductions without Temporal.

### Iteration: added placement and wiring guidance for generated tools

**What I tried and why:** Generated WebMCP code can look correct while still
being ineffective when an imperative registration is left in an unimported
file or a declarative registration is separated from the markup it annotates.
The generation, baseline, and repair prompts now require imperative tools to
follow the site's existing organization and run on an app-load or route-load
path, while declarative tools must be edited into the existing form or input
component.

**Evidence:** Each tool is now required to report its edited or created file,
the reason for that location, and where its registration is wired at runtime.
The generated diff also uses explicit file paths so the human review step can
inspect the placement before approval.

**Decision:** Kept the guidance as a shared prompt block used by every
code-writing path, avoiding separate placement rules that could drift between
generation, baseline, and repair.

### Iteration: added focused discovery before tool drafting

**What I tried and why:** Choosing tools by scanning arbitrary components can
miss the site's real handlers and state while wasting tokens reading an entire
repository file by file. On larger codebases, that unnecessary exploration
also consumes the context window, increases runtime and repeated prompting,
and leaves less context available for understanding the actual interactive
surface. The prompts now require a focused discovery pass over the stack,
README, sitemap/robots, routes, interactive elements, server handlers, and
state sources before any tool is drafted.

**Evidence:** The agent must report the detected stack, routes/pages, candidate
actions, each action's real handler and state location, preconditions, and any
actions deliberately skipped before presenting the diff. This keeps schemas
and registrations grounded in the site's actual implementation.

**Decision:** Kept discovery as a shared prompt block for generation, baseline,
and repair. It narrows exploration while preserving domain-agnostic behavior.

### Iteration: preserved complete trajectories and run checkpoints

**What I tried and why:** The repository previously kept one static baseline
trajectory, while later generation, test, repair, review, and Temporal runs
could overwrite or leave no judge-friendly record of the instructions,
permissions, feedback, retries, or human decisions that shaped the result.

**Evidence:** Every agent run now writes a timestamped raw JSON trajectory and
a matching metadata sidecar containing its prompt, provider, target, allowed
tools, timing, status, and related context. Structured artifacts record
independent evaluations, review decisions, and Temporal checkpoints, while
`trajectories/README.md` maintains an index. The trajectory capture layer
compiled successfully with `pnpm build`; no new provider run was needed for
this storage change.

**Decision:** Kept the original `baseline.json` as historical evidence and
moved all future runs to non-overwriting, timestamped artifacts so the full
workflow can be followed from discovery through final result.

### Iteration: generalized task authoring and scoring per target project

**What I tried and why:** The earlier evaluator relied on generic or
coffee-store-specific assumptions instead of a task list describing the real
outcome a user wanted. That made it difficult to score another site's actions
honestly and left no single, reviewed definition of success. The generation
prompt now authors 5-6 project-specific tasks with observable JavaScript
`verify` expressions, and the review page treats those tasks as part of the
same approval boundary as the tools.

**Evidence:** Review validates the proposed task JSON, shows each description
and verify expression, writes only the approved definitions to the target
project's `tasks.json`, and records the decision in the trajectory index.
Baseline, test, repair, and Temporal scoring all load that same task file and
evaluate its expressions in the live page. The implementation compiles with
`pnpm build`; a new live task run is still required to report a pass-rate
number.

**Decision:** Kept task authoring per project rather than bundling domain
knowledge in WebMCPify. Required human approval because a verify expression
that is accidentally lenient could silently invalidate the entire evaluation.

### Iteration: made Temporal opt-in via `init --with-temporal`

**What I tried and why:** Initially, durable execution was exposed only as a
per-run `--durable` flag on `repair`. That made the normal reproduction flow
remember a Temporal-specific option and could make someone stand up a Temporal
server even when they only wanted the core baseline/test/eval result.

**Decision:** Added a project-level `.webmcpify/config.json` toggle created by
`init --with-temporal`. It defaults to the plain repair loop, while explicit
`--durable` and `--no-durable` flags remain available for per-run overrides.
`WEBMCPIFY_DURABLE` sits between the CLI flags and project config for scripted
environments.
