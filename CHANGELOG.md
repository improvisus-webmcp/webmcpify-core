# Changelog

All notable changes to WebMCPify are documented here.

## Unreleased

- Bound Git patch inspection and source-identity checks; parse private patch files instead of synchronously piping patch input, so review cannot hang indefinitely or approve incomplete identity checks.
- Fix GitHub's Linux Chrome sandbox setup without disabling browser sandboxing; retain Windows/macOS browser checks.
- Restore declared Node 20 support by using Execa 9.6 instead of the Node-22-only Execa 10.
- Resolve macOS temporary-directory aliases when confining disposable-workspace symlinks, preserving external-link rejection.
- Run provider fixtures via their Node shebang on Windows instead of shell wrappers that corrupt multiline prompt arguments.
- Preserve safe missing-executable diagnostics when Windows reports a shell launch failure without `ENOENT`; restore macOS Chrome's `.app` bundle layout in CI for sandboxed subprocess communication.
- Classify missing explicit package-manager/build executables as environment errors on Windows, preserving private diagnostics rather than blaming generated source.
- Give Windows CI Chrome's sandboxed child processes read/execute access to the downloaded Chrome installation, without disabling sandboxing or granting write access.

## [1.0.7] - 2026-10-04

- Fail clearly on Codex MCP override keys containing dots or quotes instead of silently configuring the wrong server; update regressions for unquoted CLI override keys.

### Fixed: declarative forms waiting for human submission

- Require statically present form autosubmission for unattended declarative capabilities before generation/revision review; harmless filters/search render a string `toolautosubmit` attribute, including React spread attributes.
- Include missing submission in the existing aggregated form-repair report. Reject comment/type-only flags, React boolean props, and attributes on unrelated forms without automatically editing consent boundaries or sensitive actions.
- Preserve mandatory human confirmation and guide generation toward safe preparation/status capabilities or source-grounded omission instead of bypassing approval, clicking buttons, or extending timeouts.

### Changed: integrated generation diagnostics

- Bring the source-only diagnostic and its focused fixture into the main checkout; diagnostic generation flags belong to `generate`, not `run`.
- Retain safe provider/generation traces behind `WEBMCPIFY_TRACE=1`, without printing prompts or code during ordinary commands.
- Highlight agent readiness and clarify automatic `.gitignore` creation. Document opt-in agent analytics as a future roadmap, not a shipped feature.

### Changed: private approved task files

- Save approved browser tasks to `.webmcpify/tasks.json` instead of the target root. Review, testing, baseline and Temporal share the canonical path; existing root task files remain readable only when the private file is absent, without changing approval fingerprints or deleting owner files.
- Consolidate discovery, ignore policy, task storage and retention guidance in the README.

### Changed: private-state Git ignore rule from discovery

- Initialize a root `/.webmcpify/` rule before standalone discovery and before recording a fresh generation's source baseline, preserving owner ignore rules and line endings without duplicate rules.
- Keep metadata replay and existing repair/approval identities unchanged. Application integration still requires human approval; public capability guidance remains tracked, and local evidence stays available to normal and Temporal workflows.

### Changed: opt-in full UI baseline

- `test` and `final-eval` skip the UI baseline by default. Add `--baseline` to run every approved task through the human interface before WebMCP testing; final evaluation measures it before applying the patch.
- Keep standalone UI-only `baseline` and durable `run --baseline`. Saved `eval` reports show linked per-task comparisons and matching final-evaluation scores without rerunning the browser or attaching unrelated historical results.
- Preserve source/task identity guards and checkpoint the baseline choice. Baseline execution failures cannot masquerade as a successful comparison; low UI scores alone do not invalidate WebMCP results.

### Added: browser task connection diagnostics

- Match the advertised gateway method names and schemas rather than requiring one provider-specific fully qualified prefix. Permit metadata-only native tool discovery for deferred methods, without relaxing approved capabilities or browser isolation; clarify that Core's call_webmcp_tool alias delegates to Google's execute_webmcp_tool.
- Log per-task bridge initialization, offered/requested tool catalogs, WebMCP method and capability names, execution status and session counts. Codex MCP events log attempted server/method names separately from independent bridge evidence; prompts, arguments, results, raw errors and authentication tokens remain private.

### Fixed: source generation and metadata handoff

- Publish the saved discovery inventory when metadata continuation produces a review draft, so review can open without a separate discovery run. Diagnostic-only modes still preserve existing state.
- Report missing loaded form styles, accessible status regions and activation/submit feedback together for every declarative form. The single bounded source repair receives the complete private report and affected component paths, rather than fixing CSS before discovering the next missing requirement.
- Separate compact source editing from read-only tool-contract and browser-task authoring. Neither stage requests a large combined response schema; capability accounting uses the existing source mappings and bounded report/completion path.
- Freeze generated source and Git identity during metadata authoring, retain source provenance, and preserve existing bounded corrections, build/security checks and human approval.
- Save unapproved source checkpoints before metadata. Source-only and metadata-only diagnostics allow isolated retries without repeating source generation or changing target source/approval state; stale checkpoints are refused.
- Continue completed diagnostics with `generate --continue-from-metadata <file>`, binding metadata provenance to the saved source and freezing its contents before existing checks and human review, without repeating initial source/tool/task generation.

### Fixed: repeated generation metadata failures

- Accept the requested 20–30% extra verification coverage (20% minimum, 30% authoring target), instead of rejecting valid drafts such as 11 tools with 14 tests. Preserve complete tool coverage, grounded rejection checks and independent verification.
- Request a schema-constrained final response for Codex generation and normalize its tool/task/coverage envelope through the existing validators, preventing a prose-only summary from replacing required metadata. Other providers and Codex command roles keep their existing invocation.
- Constrain the coverage report as a native JSON object with candidate IDs restricted to the resolved discovery inventory, not JSON embedded in a string, so missing inner delimiters or invented IDs cannot invalidate an otherwise complete report. Preserve the actual correction error rather than masking it by reparsing a malformed original report.
- Distinguish the underlying application handler from its registration location in proposal instructions, so source-backed UI-only actions can be audited correctly. Require generated JSX form attributes to compile against the target's installed typings without replacing WebMCP attributes or disabling type checks.
- Try read-only accounting before editing source when a capability report is absent. An unsuccessful report-only attempt returns to the bounded missing-capability completion without approving invalid metadata or recovering source/Git drift.
- Label interim Codex diagnostic events as pending turn outcome; only a failed turn makes generation fail. Prompt and source output remain private.
- Remove identical duplicate named imports in changed disposable-workspace source before compilation, instead of asking a model to remove them. Keep type/value distinctions, conflicting bindings, comments, unusual imports and external/unchanged files intact; the resulting source still undergoes build/security and exact human review.

### Fixed: rejection tests with preparatory tools

- Allow successful setup tools before the final primary rejection action, such as adding an item while remaining logged out before checkout. Match the declared guard against the final tool consistently in metadata validation, task instructions and recorded browser evidence.
- Require setup success in order and exactly one recorded error; missing/failed setup, wrong guards and successful retries cannot count as expected passes. Cover direct metadata acceptance, correction handoffs and recorded execution without changing source or test criteria.
- Recover a unique one-character copied candidate-ID typo only for a proposed entry grounded in its exact named handler and tool source file; reject arbitrary IDs, duplicates and ambiguous handlers rather than regenerating source to correct report metadata.

### Fixed: valid capability reports without headings

- Accept an unambiguous coverage JSON object or JSON fence without the presentation heading; keep candidate/tool/source validation and reject ambiguous reports. Cover initial generation and report-only correction without extra model retries or changing application source.
- Clarify that failed generation cannot create a review draft, rather than implying generation was trying to apply source changes.

### Fixed: workflow handoffs

- Check final-evaluation Temporal dependencies/settings before launching Chrome or generating a proposal, and save its initial reviewed checkpoint before the baseline starts. Keep browser setup/cleanup in the comparison entry point instead of duplicating it in the CLI.
- Print a project-specific report command after normal runs and document the manual stage sequence, including the distinction between saved `eval` results and the optional three-level `final-eval` comparison.

### Fixed: coverage report handling during generation

- Read labelled coverage JSON with or without Markdown fences, exclude known unresolved inspection hints from required accounting and classify retained draft tools as proposed after checking their source mapping.
- Correct invalid coverage metadata once with generated source, tools and tasks retained. Show the normalized report in the reviewed draft; preserve candidate IDs, source/Git identity, task validation, build/security checks and human approval.

### Fixed: expected-rejection metadata and correction recovery

- Match concrete product errors against explicitly declared single-placeholder error templates without evaluating expressions or weakening runtime rejection evidence.
- Retain already-valid tool contracts when correcting tasks, accept tasks-only correction responses and reconstruct the complete review draft. Require actual JSON output, preserve source/Git identity checks and reject contract drift, commentary-only responses and insufficient task coverage/counts.

### Fixed: browser binding, workspace isolation and provider failures

- Parse both structured page inventories and text listings with `Title (URL)`, selection markers, and isolated-context labels. Preserve origin filtering and the exact task marker; another tab cannot substitute for the approved task context.
- Validate inventory entries and route identity probes with `pageId` only when the upstream schema supports it. Save failed selection/identity details privately rather than hiding them behind an undifferentiated binding error.
- Do not claim provider trajectories were saved when an infrastructure failure happened before the provider ran; direct users to the saved evaluation and actual diagnostics instead.
- Cover titled/untitled pages, parentheses, Unicode, misleading URL titles, malformed inventory entries, wrong-tab refusal, and routed/default schemas; give the real Chrome/WebMCP regression a page title so it exercises the failing format.
- Wait for the review server's readiness callback in regression fixtures instead of assuming it starts within 100 ms, preventing false connection failures on slower or busy machines.
- Give fixed-text guidance for Codex model-access, usage/capacity, authentication and connection failures from terminal error events. Never print raw messages, model identifiers, prompts, code or echoed command arguments, and never change the user's provider configuration automatically.
- Exclude root/nested `.pnpm-store` caches and dependency directories from workspace copying and captured source patches, including force-staged artifacts; reject manually supplied patches targeting those paths. Preserve application source, lockfiles and relevant saved/untracked files.
- Confine copied internal relative/absolute file and directory symlinks to the disposable snapshot instead of resolving them back into the owner checkout. Support canonical symlinked target roots and safe dangling links; reject external source links with guidance to select a common root. This is snapshot isolation, not a universal provider sandbox.
- Show the failed durable stage and safe nested provider guidance instead of only `Workflow execution failed`, including reattachment to a failed execution. Do not print raw Temporal causes or retry side-effecting stages automatically.
- Treat explicit terminal Codex/Claude failure envelopes as failed executions even when their CLI exits zero. Preserve raw transcripts privately and do not count failed agents as successful; ordinary warnings and recovered turns remain supported.
- Preserve fixed-text timeout guidance through generation/coverage wrappers instead of hiding a provider timeout behind a generic incomplete-draft error.
- Disable pnpm's before-run dependency installation during approved apply/typecheck/build, matching generation preflight. Validation must not silently purge installed dependencies or rewrite a lockfile outside the source rollback scope; cover the subprocess setting and real pnpm execution.
- Pin durable repair to the initiating CLI's canonical provider, including `WEBMCPIFY_PROVIDER` when `--provider` is omitted; verify a live worker with a deliberately different default cannot substitute its provider.
- Resolve durable repair before browser setup: explicit and environment-selected Temporal repairs no longer require or start client-side Chrome. Plain repair retains its browser path, and missing optional SDKs surface the installation message first.
- Let a narrowly source-backed local store demo checkout reach human scope review instead of requiring an invented payment backend. Inspect actual generation/revision workspaces and reconstruct supported pending text changes in memory; network calls, unknown helpers, unsafe persistence, shadowed bindings, external paths and pending backend changes retain consequential checks. Static source evidence does not attest runtime subscribers or deployed behavior.

### Added: optional Temporal execution from discovery to verification

- Add `run --durable` with checkpoints for discovery, generation/preflight, balanced/strict/ignored security, initial review, optional pre-apply UI baseline, exact-source apply/build, every approved browser task, and independent evaluation. Normal CLI/MCP startup remains Temporal-free; the optional peer/development dependency structure is unchanged.
- Add bounded activity/review deadlines, live phases and actual review URLs, duplicate-active-run protection, client-disconnect reattachment and explicit execution IDs. Label completed-run reattachment as saved history, not a fresh audit. Initial durable review supports revised selected tools/tasks; repair reviews still freeze approved criteria.
- Keep generated code, task expressions and raw provider diagnostics in local artifacts rather than new activity results. Serialize worker activities, share connection configuration and close browser sessions. Use heartbeat/cancellation propagation and local deadlines; disable automatic side-effect retries and replay old repair histories with their original options.
- Add isolated live Temporal heartbeat/cancellation/restart/replay checks and an actual Core CLI/worker/Chrome pipeline on a disposable JavaScript app with a credential-free provider. These do not certify arbitrary in-flight crash recovery, every operating system or authenticated model behavior.

### Fixed: end-to-end cancellation, identity and evaluation safeguards

- Apply the exact validated patch bytes through Git stdin for both check and application, preventing a changed pending file from bypassing approval/hash validation during rollback preparation. Add a deterministic tampering-race regression.
- Run the explicit build even when a typecheck command contains `build`; reject unreadable/malformed manifest or script/dependency maps as environment failures instead of silently skipping checks or asking a provider to repair source. Add dependency-free JS, misleading-typecheck and malformed-manifest regressions.
- Bind orchestration apply to the exact reviewed run/hash and freeze durable repair task identity. Reject source/task/policy drift between full-pipeline stages; allow all approved tasks without a six-test ceiling.
- Derive default durable provider timeouts from remaining activity time instead of stopping a valid long run at normal five/fifteen-minute defaults; explicit overrides retain precedence. Stop owned validation subprocess trees before rollback and prevent late child writes after cancellation.
- Run declared checks for dependency-free JavaScript targets even without `node_modules`, reject malformed package manifests, and propagate cancellation through discovery/copy/reachability checks.
- Reject baseline source/task drift and failed provider sessions. Failed durable repairs/final evaluations exit nonzero; source-changing Temporal repair forces a full final-source retest instead of keeping stale earlier passes. An unusable UI baseline cannot complete the comparison, while legitimate low UI scores remain allowed and the approved apply/test evidence is preserved.

### Fixed: mandatory Chrome DevTools WebMCP execution and honest scoring

- Connect Chrome DevTools MCP in Core before capability tests and bind each agent to its exact isolated task tab. Expose only `list_webmcp_tools` and `call_webmcp_tool`, delegating calls to upstream `execute_webmcp_tool`; reject unapproved tools, page routing and script/UI substitutes.
- Require independently recorded discovery, ordered successful calls, and real business-error responses. Reports containing tool names cannot pass an initially-true postcondition. Expected rejections need one matching primary failure and a passing unchanged-state check, while successful same-tool setup with different inputs remains supported.
- Respect upstream page-routing schemas and `Completed`/`Error` statuses, avoid stale closed-tab selection between tasks, and distinguish structured business errors from successful protocol completion. Read-only, invocation-correlated observation preserves thrown guard messages omitted by the pinned MCP server; actions still execute only through its WebMCP method.
- Require null-safe storage checks in newly generated/revised tasks without silently changing existing approvals. Allow a bounded wait for asynchronous postconditions, revoke agent access before scoring, and keep raw diagnostics private.
- Classify connection/evidence failures separately, stop unexecutable audits, and prevent source repair of healthy apps for infrastructure failures. Durable Temporal task attempts share the same boundary; normal commands still do not require Temporal.
- Add MCP startup/transport, restricted gateway, false-pass, null-storage, and real Chrome/pinned-MCP regressions using credential-free providers. Document advantages near the README's top and the audit/recovery boundary.
- Fix delayed guard-event delivery across separate CDP connections with a bounded invocation-correlated wait, and close timed-out MCP connections before retries. Verify unresolved browser promises, operation cancellation, normal false postconditions, and delayed forbidden mutations after guard rejection.
- Make failed standalone CLI audits exit nonzero, prevent failed baseline providers from passing initially-true checks, and clean up partially prepared sessions. Invalid/timed-out verification expressions cannot trigger source repair of a healthy app.
- Record applied repairs as `awaiting-test` rather than claiming improvement from a fresh page without executing actions. Final-eval/durable repair still replay approved tasks; plain repair requests an explicit `test` retest.
- Stamp current execution-policy evaluations and local Git source identity, reject mid-test source/task drift, and constrain final-eval reuse to the exact URL/provider/mode and complete result set. Do not substitute a mixed standalone baseline for the UI-only comparison or reuse legacy report-only results.

### Fixed: review link contrast and confirmation controls

- Keep WebMCP reference links readable and underlined on the blue review banner, including visited links and visible keyboard focus.
- Style Cancel as a secondary control aligned with Confirm Approval, with touch-sized targets, hover/focus feedback, and mobile-safe confirmation layout. Cancel returns to review without approving or rejecting the draft.
- Verify rendered controls, keyboard focus, mobile layout, and Cancel navigation in the real-browser review regression.

### Improved: copy-on-write disposable workspaces

- Request optional filesystem reflinks when copying source workspaces, with Node's ordinary-copy fallback rather than forced-clone failures or source hard links.
- Preserve the existing file-selection policy, saved working-tree/staged/untracked contents, required ignored files, binary assets, and the human approval boundary. No additional caches or build assets are silently excluded.
- Add focused regression coverage for both optional-reflink and ordinary-copy paths, independent source edits/deletions, nested exclusions, unchanged target Git state, and cleanup after copy errors.

### Fixed: complete capability accounting and live revision activity

- Expand JS/TS discovery into deterministic handler/store-action candidates, including both conditional login/logout branches and multiline event callbacks. Remove silent 200/300-signal truncation; disclose parser fallbacks.
- Explicitly forbid fixed/top-six tool sampling. Account for every resolved action through actual proposed tools, existing registration evidence, or a source-grounded omission reason. Request one bounded source-capable completion for gaps while preserving existing valid contracts and enforcing scaled test coverage, build/wiring/security checks, and human approval.
- Preserve explicit omission reasons across metadata-only corrections. Treat unresolved/dynamic/cross-file discovery as inspection hints, not invented capabilities or proof of exhaustive coverage.
- Add a live spinner, elapsed-time and connection feedback to revision pages and other-tab locking overlays, preserving fresh-review controls, private diagnostics, and reduced-motion accessibility.
- Add seven-action/login-logout completion and ten-test regressions, uncapped discovery lists, guarded completion failures, and real-browser activity checks.

### Fixed: tool-scaled verification and supplemental task validation

- Remove the fixed six-test ceiling. Initial and revised drafts require at least `ceil(tool count × 1.3)` valid tests, with no upper count limit; 10 tools need at least 13 tests.
- Preserve every unaffected test and supplement both missing tool coverage and the retained-tool count's margin. Validate task-only supplements against the combined set instead of requiring a provider to repeat retained tests.
- Prefer explicit `TASKS_JSON` blocks over unrelated fenced examples; preserve approved legacy task sets and repair/Temporal task-set identity.

### Fixed: direct tool removal, retained tasks, and pnpm preflight

- Remove independent inline JS/TS WebMCP registrations with a lazily loaded parser instead of always invoking a coding agent. Preserve ordinary application handlers; defer dynamic/shared registrations to a focused provider pass.
- Drop rejected-only and mixed/dependent tasks, preserve unaffected task IDs and criteria, and supplement retained-tool coverage/count gaps without duplicate padding.
- Keep task-only supplementation source-frozen, regenerate retained-only documentation, and preserve build/security/identity checks plus fresh exact-patch approval. Grounded TypeScript unused-integration cleanup gets one source-assisted fallback.
- Disable pnpm automatic dependency installation only for disposable preflight subprocesses, preserving the linked target dependency tree. Distinguish interactive installation/environment failures from code validation and show the failing preflight check safely.
- Add direct JS/TS parsing, immutable/expected-rejection task retention, mixed-task removal, coverage-gap, repeated reduction, real-pnpm, and browser review regressions.

### Fixed: selection consent and failed-revision recovery

- Clear and disable exact-source consent when tools are deselected; only enable it for the currently displayed complete draft, with fresh unchecked consent after revision.
- Preserve rejected-tool choices after revision failure so retry cannot silently restore rejected registrations. Keep source/application approval blocked until a validated revised draft is ready.
- Identify provider-stage failures with safe recovery guidance and link private revision diagnostics to the provider trajectory. Ground revision prompts in the actual discovery-file path.
- Add HTTP and real-browser checks for consent locking, restored selections, provider failure, and fresh-review retry.

### Fixed: independent review cards, shutdown, and rollback safety

- Stop CSS grid stretching the closed summary card when its neighbor opens; verify each card's actual open state and independent height in Chrome.
- Reproduce and fix post-approval hangs caused by unfinished HTTP connections. Show closing activity, flush the final response, then force remaining connections closed after a one-second grace period. Refuse further mutation requests during shutdown.
- Record only pre-existing files in rollback manifests and retain original/new-file classification in memory against manifest alteration. Restore all recoverable patch paths, refuse to delete an original with a missing backup, and keep failure evidence. Backup cleanup failures after successful apply no longer trigger rollback from partly deleted backups.
- Expand rollback coverage to added/deleted/renamed files, typecheck failure, cancellation, and damaged backups; document scope and recovery limits in the README.

### Improved: review transparency and workflow activity

- List every patch path with added/modified/deleted/renamed/copied status and a file-role or declared tool-placement reason. Do not cap the list at ten or invent a precise purpose for unexplained changes.
- Make review cards, tools, security findings, tasks, file inventory, source diff, and raw draft collapsible. Keep a larger source-consent checkbox visible; disable approval until checked and reset consent for every revised draft. Partial draft preparation remains distinct from approval.
- Show safe stderr phase activity and elapsed-time feedback while saving approval, preparing rollback, running target build/typecheck, preparing browser tasks, and independently scoring results. Preserve raw prompt/code/error privacy and MCP stdout.
- Explain multi-minute generation/build/browser verification and standalone-review versus full-run behavior in the README. Add file-inventory, consent, collapse, mobile, and progress regressions.

### Fixed: locked, tool-only review and strict audits

- Make generated contracts and all verification tasks read-only in review; owners select tools only. Reject task/contract edits sent directly to the server.
- Lock controls immediately during partial revision, reject concurrent submissions, and show progress across open tabs and refreshes. Keep one review server running; reopen the revised draft automatically and support repeated removals and recovery after provider failure.
- Focus revisions on integration files and corresponding tasks, reuse retained-only tasks, and let Core supply frozen tool contracts and regenerate documentation. Compare contracts independent of JSON object-key order while still rejecting real drift.
- Preserve fresh exact-patch confirmation, selected-tool coverage, private diagnostics, original app handlers, and repair/durable fixed-task boundaries.
- Make standalone `security --strict` select the strict audit policy as well as failing on blocking findings. Add HTTP and real-Chrome review regressions.

### Added: project identity and grounded GEO/AEO discovery

- Show the target project name and repository folder on the human review page; escape owner-provided identity safely.
- Include plain HTML capability guidance, truthful WebPage metadata, a merged target README summary, and a deployment/discovery checklist in the exact reviewed patch. Preserve owner pages, use an alternate HTML filename when needed, and regenerate retained-only documentation after partial selection.
- Document search versus training crawler controls, internal linking, real deployment/canonical/sitemap checks, and llms.txt's optional status. Preserve owner restrictions; do not invent domains or promise indexing, citations, or rankings.
- Add a complete end-to-end testing guide and source-backed research notes.

### Fixed: validation and intermittent terminal failures

- Anchor relative/PATH package-manager executables before disposable-workspace checks. Skip dangling optional dependency links; real missing imports still fail the build.
- Report missing or non-executable preflight commands as environment failures instead of invoking LLM source repair. Cancellation also stops without that repair retry.
- Bound occupied review-port retries to 20 attempts with an actionable alternative-port message.
- Inspect current runtime files, not documentation or deleted diff lines, when checking WebMCP wiring; readiness guidance alone cannot satisfy that check.
- Add regressions for HTML/JSON-LD escaping, owner preservation, idempotence, private metadata omission, project fallback identity, relative executable paths, missing managers, and busy-port fallback.

### Fixed: balanced defaults and selected-tool review

- Align generation, review fallback, and audit defaults with `run`'s balanced policy. Add `generate --security balance|ignore|strict`; preserve explicitly recorded draft policies.
- Ignore local `npm pack` tarballs instead of treating test archives as source. Leave existing archives available for local installation.
- Add 24px separation above confirmation actions and spacing between buttons.
- Unchecking tools drafts a revised source patch through the original provider in a disposable workspace. Rejected registrations are removed; retained contracts remain fixed; tests and capability docs are regenerated for retained tools only.
- Require fresh exact-patch review and payload-bound confirmation for the revised draft. Fail closed on retained-contract drift, rejected registrations, changed target identity, or provider failure; preserve repair/durable task-set boundaries.

### Fixed: exclude agent-local Serena state

- Exclude root and nested `.serena` files from disposable workspace copies and source patch capture, including force-staged files. Reject patches targeting this agent-local state while leaving existing owner configuration untouched.
- Add regression coverage for workspace isolation, patch filtering, and blocked Serena paths.

### Fixed: rejection preparation and generation metadata recovery

- Allow negative-test setup that preserves an unmet prerequisite, including choosing an absent cart item. Expected errors and independently verified unchanged state remain mandatory; unrelated failures do not pass.
- Retry malformed tool/task metadata once without changing generated source or already-valid tool contracts. Revalidate the correction, use it as the canonical review draft, and stop safely if correction fails.
- Resolve relative provider paths before workspace changes, add standalone Codex executable discovery, and distinguish missing CLIs from missing working directories or broken interpreters. Keep raw subprocess diagnostics private.
- Add credential-free generation recovery fixtures and regression checks for rejection preparation, executable lookup, terminal redaction, source/contract identity, and browser rejection scoring.

### Fixed: runtime isolation, providers, and durable execution

- Browser tasks and baselines now verify the exact acted-on tab in a fresh task context, preserving transient state, cookies, and navigation without clearing the existing browser profile. Browser-only agents receive empty workspaces; browser MCP and scoring share the configured CDP endpoint.
- Exclude complete Git metadata/runtime/dependency entries when copying worktrees; share generation/repair workspace capture, isolate Git hooks/signing/line-ending settings, and allow larger source diffs. Parse spaced and Git C-quoted filenames, include untracked source content in identity checks, and bind approvals to exact patch bytes and changed-file metadata.
- Correct OpenCode CLI/MCP configuration without overwriting owner settings, forward MCP configuration to Gemini, and serialize Codex environment overrides as TOML assignments. All providers receive deadlines, cancellation, and platform-aware process cleanup.
- Temporal worker/client address, namespace, TLS, and API-key settings now align. Operation-specific activity deadlines, heartbeats, cancellation propagation, and single-attempt side-effect activities prevent automatic overlapping retries. Optional peer/dev dependency structure is unchanged.
- Add Windows executable/browser discovery, dependency junctions, Windows TypeScript entry points, native-platform CI, runtime regressions, and an explicit real-Chrome state check. Fix Chrome-profile cleanup races, Vite asset-root resolution, unsafe readiness paths, and malformed documentation markers.
- Consolidate repository-maintenance and browser-capability guidance into one target-root `AGENTS.md`, outside private `.webmcpify` state. Preserve existing owner files and reject reversed or duplicate documentation markers without overwriting them.

### Added: agent-readiness files and framework-aware feedback

- Generation includes merged `AGENTS.md`, `llms.txt`, capability documentation, and narrowly scoped metadata crawl permissions in the same human-reviewed patch. Existing owner documentation and crawler restrictions are preserved; unknown deployment layouts receive explicit setup guidance instead of claimed public support.
- The combined target-root `AGENTS.md` documents each proposed capability's inputs, prerequisites, effects, successful outcome, expected rejection, and safe WebMCP usage, with Improvisus/WebMCPify integration attribution. Owner notes are preserved; neither this guide nor public discovery documents belong in private `.webmcpify` run state. No second `.agent.md` is generated.
- Generation guidance preserves JavaScript/TypeScript and framework conventions, requires loaded WebMCP form CSS plus accessible agent-status feedback, and covers React/Angular lifecycle cleanup. Discovery recognizes Angular events/state, declarative registrations, styles, and existing readiness files.
- JavaScript preflight no longer runs an implicit TypeScript build just because a transitive `tsc` binary is installed.

### Fixed: strict security follows actual action effects

- Strict auditing distinguishes local reversible UI state from backend mutations. Clicks, selections, filters, and local cart changes no longer require invented backend authorization, user/agent binding, quotas, or replay protection; high-impact actions remain gated even when mislabeled as UI state.
- Added JS/TS generation, reviewed readiness artifacts, crawler preservation, framework layout, loaded form-feedback, and strict UI/backend regression coverage.

### Fixed: private failures and complete tool verification

- Provider stderr and raw subprocess errors are no longer streamed or rethrown to the terminal, preventing prompts and embedded source code from appearing when an agent command fails; raw diagnostics remain in the local trajectory.
- Structured proposals now require source-grounded success, precondition, and expected-failure behavior contracts, and approval rejects any proposed tool without task coverage.
- Verification tasks distinguish successful actions from expected business-rule rejections. A rejection passes only when the tool name and declared error are observed in provider evidence and an independent browser postcondition confirms no forbidden state change.

### Added: optional product context

- Interactive `run` and `generate` now offer an optional post-discovery product-context input. `--product-context <text>` supplies it non-interactively and `--no-product-context-prompt` skips it; discovery remains authoritative and the note is verified against source before use.

### Fixed: provider editing mode and task/tool alignment

- Normalize provider output before tool/task parsing: JSON envelopes, JSONL streams, nested assistant content, and generic future response shapes now share one extraction path.
- Antigravity generation now explicitly uses its `accept-edits` mode and receives one edit-only retry when it returns a textual diff without modifying the disposable workspace.
- Tool-availability-only checks may be task metadata with no action tool; every action task remains bound to generated WebMCP tools and any multi-tool setup.
- Require every newly generated evaluation task to name available WebMCP tools and declare setup for multi-tool tasks, preventing unsupported or state-dependent actions from being scored as false failures.

### Changed: require an explicit target URL

- Removed the implicit `http://localhost:3000` fallback from `run`, `final-eval`,
  and the MCP browser test tool. Pass the actual app URL or set `WEBMCPIFY_URL`;
  commands now explain this requirement instead of testing an assumed port.

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
