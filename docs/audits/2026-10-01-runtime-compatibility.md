# End-to-end runtime and platform audit

Initially audited the pending agent-readiness source on Linux with Node 22.23.0, Chrome 154.0.8037.92, Codex CLI 0.155.1, OpenCode 1.18.26, and the installed AGY CLI. The numbered findings below retain the **original observations**; they are historical and must be read alongside the updated status here.

## Remediation status — 2026-10-03

| Finding | Current implementation |
| --- | --- |
| 1: discarded page/cookies | Fixed: fresh per-task context, explicit same-page verification, no personal-context cookie clearing; real Chrome regression passes. Baselines execute and score per task. |
| 2: OpenCode adapter | Fixed: supported flags, named MCP map, inline overlay preserving owner config; synthetic adapter regression. |
| 3: Gemini MCP | Fixed: merged workspace settings receive browser MCP configuration; workspace trust is not bypassed. |
| 4: Temporal backend mismatch | Fixed: shared address, namespace, TLS/API-key options and connection cleanup. Isolated live development-service/worker fixtures now exercise matching configuration; production TLS/auth deployment remains unverified. |
| 5: timeout/retry overlap | Fixed activity budgets, provider remaining-time defaults, real heartbeats, local deadlines and cancellation propagation through owned process trees. Live SDK cancellation and completed-stage restart/replay are exercised; arbitrary in-flight crash safety and signal-based durable approval remain unimplemented. |
| 6: Git worktree copy | Fixed and regression-tested with a real disposable worktree; generation and repair share isolated workspace initialization. |
| 7: patch paths | Fixed C/octal quoting and spaced/Unicode paths; full changed-file metadata is checked. Approval additionally binds exact patch bytes and untracked source content. |
| 8: Codex environment TOML | Fixed escaped per-key assignments; synthetic provider adapter regression. |
| 9: Cursor provider | Still not implemented; README explicitly documents the gap. |
| 10: platform support | Added PATHEXT, execute checks, Chrome installation discovery, extension platform/architecture selection, junctions, tsc.cmd, process-tree handling and native CI. Windows/macOS execution has not been performed locally; CI results are not yet available. |

Additional fixes: browser-only workspaces contain no copied source; browser MCP/scoring share a CDP endpoint; all providers have deadlines; copied Git baselines disable inherited hooks/signing/line-ending conversion; large source diffs have a higher capture limit; package-manager selection is shared and honors Bun/declarations; Chrome profile cleanup retries handle exit-time file races; Vite asset-root paths, Windows absolute readiness paths, malformed merge markers, private build-error output and review cancellation have regressions.

The complete Linux test suite and separate real-Chrome state check have passed during remediation. Provider fixtures do not make authenticated model calls. An OS matrix is configured but has not been executed here. Temporal peers retain their existing optional peer/development dependency structure.

No authenticated model requests were made. macOS and Windows findings are source/documentation checks, not native execution results. Passing fixture tests must not be presented as universal end-to-end compatibility.

### Follow-up: complete optional durable pipeline

`run --durable` now starts at discovery rather than only orchestration after a
failed task. It checkpoints generation/preflight, security, initial tool-selection
review, optional original-source UI baseline, exact approved apply/build, every
approved Chrome WebMCP task and evaluation. Activities bind patch/task/source
identities and keep generated source, verification expressions and raw provider
output local. Normal CLI/MCP startup remains independent of optional Temporal peers.

The isolated SDK 1.21.1 fixture exercises a 13-task run, security/rejection gates,
heartbeat survival beyond the heartbeat timeout, cancellation cleanup, restart
after a completed stage, invalid-input failure and current/legacy history replay.
The separate full pipeline fixture uses the actual Core CLI/worker, local service,
real Chrome MCP and a disposable JS app with a credential-free provider. It
covers review port fallback, duplicate launches, client disconnect/reattach,
pre-apply UI baseline, expected business rejection, subset source/task revision
and exact-source apply. These are local development fixtures, not certification
of arbitrary crash recovery, every OS, paid provider capacity or production setup.

A further fault-injection pass reproduced a pending-patch race after approval/hash
validation and a typecheck command containing `build` that skipped the framework
build. Git now checks/applies the validated in-memory bytes through stdin, and
preflight runs both declared scripts. Existing unreadable/malformed manifests or
script/dependency maps fail clearly instead of disabling validation. Deterministic
disposable regressions cover these paths; no real target source was changed.

## Original release-blocking findings (historical)

### 1. P1: verification discards the agent's actual page and authentication

Source: `src/lib/scoring.ts:34`, `src/lib/scoring.ts:95`, `src/commands/test.ts:225`, `src/temporal/activities.ts:49`.

`getIsolatedPage` always clears the first browser context's cookies, creates another page, and navigates to the initial URL. `resetStorage: false` does not prevent this. A task that successfully changes DOM/component state, session storage, navigation, or a cookie-authenticated state can fail independent scoring. Expected-rejection tests can also examine the wrong precondition state. This affects all providers, ordinary testing, baseline comparison, and Temporal testing.

Reproduced using a localhost HTML fixture and a separate Chrome profile: the acted-on page had a filled local cart and one synthetic authentication cookie. `scoreTask` reported `tools → observed; verify → false`; the original page still had the filled cart, but its context now had zero cookies.

Recommendation: reset an isolated test context **before** each task, explicitly identify the same page to the browser agent, and independently evaluate that page after the action without clearing its cookies or recreating its session. Never clear cookies in a reused personal browser context.

### 2. P1: OpenCode invocation and MCP adapter do not match its interface

Source: `src/lib/agent.ts:103`, `src/lib/agent.ts:166`.

Core passes `--dangerously-skip-permissions`; installed OpenCode's help instead exposes `--auto`. Its generated config is `mcp: { servers: { ... } }`, but named servers belong directly under `mcp`. The wrapper is not a valid named-server entry. The adapter also replaces the copied `opencode.json`, dropping target model/provider/permission settings, and can include that adapter-only file in a repair patch because it is not excluded from the repair diff.

The flag mismatch was checked against installed help, not a paid model invocation. The config mismatch was checked against [OpenCode's MCP documentation](https://opencode.ai/docs/mcp-servers/) and [CLI reference](https://opencode.ai/docs/cli/).

Recommendation: use supported noninteractive permissions, merge the correct schema without replacing owner configuration, and keep adapter-only settings out of source patches.

### 3. P1: Gemini does not receive the generated browser MCP config

Source: `src/lib/agent.ts:36`, `src/lib/agent.ts:378`.

The Gemini branch ignores `opts.mcpConfig`; no Gemini-specific configuration preparation exists. A fresh workspace without a user-preconfigured browser bridge cannot load Core's generated Chrome MCP server. This blocks browser testing/baseline/repair even if generation succeeds.

Gemini loads MCP servers from `.gemini/settings.json`; see its [official MCP documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md). Workspace trust is an additional prerequisite, not something Core should silently bypass.

Recommendation: prepare a workspace-local Gemini adapter that preserves settings and surfaces trust/permission failures clearly.

### 4. P1: Temporal worker and client can connect to different backends

Source: `src/temporal/worker.ts:14`, `src/commands/repair.ts:315`, `src/commands/final-eval.ts:214`.

Clients honor `WEBMCPIFY_TEMPORAL_ADDRESS` and `WEBMCPIFY_TEMPORAL_NAMESPACE`; the worker supplies neither a connection nor a namespace. SDK defaults are insecure localhost:7233 and namespace `default`. For a custom address/namespace, workflows can start while this worker never polls them. Cloud TLS/authentication is also not configurable through these paths.

Recommendation: share explicit connection/namespace settings, provide appropriate TLS/auth configuration, close connections, and validate worker availability rather than waiting indefinitely for a result. This finding is established by source and the installed SDK option declarations; no user Temporal service was contacted.

### 5. P1: Temporal's activity timeout is shorter than valid repair/review work

Source: `src/temporal/workflows.ts:4`, `src/lib/agent.ts:246`, `src/temporal/activities.ts:101`.

All activities use a five-minute start-to-close timeout with up to three attempts. Codex repair/generation can run for fifteen minutes, and a human approval page can stay open indefinitely. Long operations can time out and retry while the original operation still owns its approval server or workspace. Activities do not wire cancellation/heartbeats through to providers or review servers; side-effect retries lack an explicit activity idempotency contract.

Recommendation: use operation-specific timeouts, cancellable/heartbeating work, durable signal-based approval, and idempotent/resumable apply handling. A live five-minute timeout was not intentionally triggered during this audit.

### 6. P1: Git worktree targets fail workspace initialization

Source: `src/lib/agent-workspace.ts:13`, `src/lib/agent-workspace.ts:31`, `src/commands/repair.ts:121`.

The copy filter excludes children of `.git`, but not the `.git` entry itself. A Git worktree's `.git` **file** is copied with its pointer to the original worktree metadata. Generation initialization then tries to create `.git/info`, producing `ENOTDIR`. Repair uses the same faulty exclusion and can reuse original Git metadata rather than an independent baseline.

Reproduced with a disposable repository and worktree; no user Git metadata was changed. Recommendation: exclude the complete `.git` entry and all descendants by relative path components, then initialize a genuinely independent repository.

### 7. P1: patch parsing cannot safely account for spaced/quoted filenames

Source: `src/lib/patches.ts:154`.

Changed-file extraction assumes whitespace-free unquoted paths. Git emits spaced filenames and quotes some Unicode paths; an otherwise valid diff can be rejected, or its changed-file list can omit files when other normal paths exist. Missing entries affect review completeness, source-path checks, and rollback coverage.

Reproduced with a real Git diff adding `Component Copy.jsx`: extraction rejected the valid patch. Recommendation: parse Git quoting correctly or derive changed paths from Git's NUL-delimited output, preserving complete patch/path identity.

## Original provider and platform-specific findings (historical)

### 8. P2: Codex MCP environment overrides are serialized as JSON, not TOML

Source: `src/lib/agent.ts:148`.

`JSON.stringify(server.env)` produces colon-separated object entries, not a TOML inline table. Using a synthetic environment mapping with installed `codex features list -c ...` reproduced: `invalid type: string ..., expected a map` in the configured server's `env`. Browser config without environment entries is unaffected.

Recommendation: emit individual escaped TOML assignments for each environment key or use a correct TOML serializer. Installed Codex help recognizes Core's other current invocation flags; this audit did not establish a generic flag failure for Codex or AGY.

### 9. P2: Cursor is not an implemented provider

Source: `src/lib/ai-provider.ts:4`, `src/cli.ts:20`.

`resolveProvider('cursor')` rejects it. There is no Cursor invocation, output, permission, or MCP adapter. Cursor can host the Codex extension, but that does not create a Cursor Agent provider. Recommendation: either explicitly document the gap or add a separately verified adapter.

### 10. P1/P2: Windows discovery, dependency links, and process cleanup are incomplete

Source: `src/lib/executables.ts:5`, `src/lib/executables.ts:36`, `src/lib/browser.ts:30`, `src/lib/preflight.ts:53`, `src/lib/agent.ts:393`.

- Executable discovery searches exact names and only `PATH`, not Windows `PATHEXT`/case variants such as `Path`. Typical `codex.exe`, `claude.cmd`, or `agy.exe` installations can be missed by provider auto-detection. Explicit provider selection may still work through execa's executable resolution.
- Chrome detection has no Windows installation paths. Without an existing CDP endpoint or `WEBMCPIFY_CHROME_BIN`, ordinary Windows Chrome installations are missed.
- Codex extension fallback chooses Linux x64 for every non-macOS platform; it also misses Linux ARM64 and Cursor's extension location.
- Dependency linking uses ordinary symlinks. Windows users without symlink privileges/Developer Mode can get `EPERM`; directory junctions are a relevant alternative. Implicit TS detection also assumes a Unix-style `tsc` entry rather than `tsc.cmd`.
- Detached POSIX process-group termination uses a negative PID. That does not terminate a Windows child-process tree, so interruption can leave descendants running.

These are source-backed risks, not native Windows test results. See [Node's symlink behavior](https://nodejs.org/api/fs.html#fspromisessymlinktarget-path-type) and [Windows child-process behavior](https://nodejs.org/api/child_process.html#optionsdetached).

Recommendation: platform-aware executable/browser resolution, privilege-safe dependency access, process-tree cleanup, and native Windows CI.

## Original additional limitations and verification gaps (historical)

- Linux/macOS executable discovery checks file existence, not execute permissions; a nonexecutable candidate can be selected instead of a working CLI later on PATH.
- Only Codex has a subprocess timeout in the generic provider runner. AGY has its own print-timeout argument; Claude, Gemini, and OpenCode lack a Core-level deadline. Claude also bypasses the shared process-group/interrupt lifecycle.
- Browser-test workspaces contain copied source, and provider `allowedTools` is enforced only by the Claude adapter. The claimed universal “MCP-only; no source access” boundary is not implemented for the other providers. Disposable copies protect target writes, but do not remove source visibility.
- Temporal's worker import catches every load failure and reports missing optional peers, which can mask incompatible native binaries. The SDK's [native target mapping](https://github.com/temporalio/sdk-typescript/blob/main/packages/core-bridge/common.js) supports glibc Linux, macOS, and Windows x64 targets; Alpine/musl and Windows ARM64 must not be claimed universally supported.
- Core does not automatically ignore target `.webmcpify` state or exclude it from deployment contexts. It can contain provider diagnostics, approvals, and rollback source. Dot-prefix hiding is not a confidentiality boundary.
- Fixture providers accept Core's arguments without validating real CLI schemas. Existing passing tests therefore did not catch the provider or browser-state defects above. No native OS CI matrix currently exists.

Recommended priority: same-page/context scoring → workspace/patch safety → provider adapters → Temporal connection/timeouts/cancellation → native OS compatibility and end-to-end coverage.

## Artifact layout and implemented addition

- Keep `.webmcpify/` local for approval, rollback, and resume. Ignore it in Git and deployment/build contexts; optionally hide it in the editor. Do not automatically delete it after a run.
- Keep `llms.txt` and `webmcp.md` in the website's served assets, never inside `.webmcpify`.
- One combined `AGENTS.md` is generated at the target repository root in the exact reviewed patch. It includes repository-maintenance instructions, proposed tools, input requirements/bounds, preconditions, outcomes, expected errors, effects, safe WebMCP usage, and Improvisus/WebMCPify attribution. It preserves owner sections and is available even when public deployment cannot be established. Core does not generate a second `.agent.md` or configure a public route for the guide; existing owner `.agent.md` files remain untouched. Deployments serving the whole repository root must review document exposure separately.
- README and focused JS/TS generation tests cover the addition. Public-safe guide rendering excludes internal security notes and input default values.

## Checks performed

- Real disposable Git-worktree and spaced-path reproductions.
- Real isolated Chrome scoring/cookie reproduction on localhost.
- Installed AGY/Codex/OpenCode help inspection; synthetic Codex MCP environment parsing.
- Temporal SDK workflow bundling succeeded.
- JavaScript/TypeScript generation fixtures and unified `AGENTS.md` content/merge/approval/separation checks succeeded, including regeneration, owner-file preservation, and malformed marker rejection.
- A missing Chrome executable returned an actionable `ENOENT`; a suspected cleanup hang did **not** reproduce and is not listed as a confirmed bug.

## Live generation follow-up (2026-10-02)

A reported Codex run reached generation after setting an explicit executable path, then failed because a negative remove-item task declared setup. Core previously rejected all rejection-task setup and stopped before its source-preflight repair path.

- Negative setup is now allowed to prepare and preserve the declared failure condition. Expected tool/error evidence and an independent no-forbidden-change postcondition remain required.
- Invalid tool/task metadata gets one separate metadata-only correction. Generated source/Git identity and already-valid contracts cannot change; corrected metadata becomes the review draft. Failed correction does not publish a pending proposal or apply source.
- Provider lookup anchors relative executable paths before workspace changes and includes standalone Codex discovery. Safe diagnostics distinguish a missing executable, missing working directory, and an executable with a missing interpreter/runtime. Raw subprocess details stay private.
- Credential-free generation fixtures cover successful correction, invalid corrections, contract/source/Git drift, provider failure, and unchanged target source. Real Chrome checks confirm unrelated errors and forbidden state changes fail rejection scoring. The complete automated suite passes.

The original shell-versus-Core Codex lookup discrepancy and the separate authenticated Antigravity failure have not been reproduced with the user's environment. These tests do not claim a successful authenticated model run or native Windows/macOS execution.
