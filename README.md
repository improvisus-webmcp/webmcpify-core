# WebMCPify Core

[![npm version](https://img.shields.io/npm/v/@improvisus/webmcpify-core.svg)](https://www.npmjs.com/package/@improvisus/webmcpify-core)
[![npm downloads](https://img.shields.io/npm/dm/@improvisus/webmcpify-core.svg)](https://www.npmjs.com/package/@improvisus/webmcpify-core)
[![GitHub release](https://img.shields.io/github/v/release/improvisus-webmcp/webmcpify-core)](https://github.com/improvisus-webmcp/webmcpify-core/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Create, review, test, and verify [WebMCP](https://webmachinelearning.github.io/webmcp/) capabilities for new and existing web applications.

Make your app agent-ready without rebuilding it. Core discovers existing capabilities, drafts WebMCP integrations in an isolated workspace, and applies only the exact patch you approve. It then exercises the tools in a real browser and independently verifies their effects.

## Why use WebMCPify Core?

- **Make your app agent-ready and easier to discover.** Expose usable WebMCP capabilities and add `AGENTS.md`, public capability references, `llms.txt`, and scoped crawler guidance so agents and LLM-backed search can understand your site. These support discovery and indexing eligibility—not guaranteed indexing, citations, or recommendations.
- **Reuse what already works.** Integrate existing handlers, forms, authentication, and business rules; preserve the human interface and reuse existing WebMCP registrations instead of duplicating them.
- **Reduce integration work.** Draft tool schemas, registrations, documentation, and accessible agent-activity feedback while preserving your JavaScript/TypeScript and framework conventions.
- **Control exactly what ships.** Review every tool and changed file, remove unwanted capabilities, and approve the exact source patch. Rejected registrations and their dependent tests are excluded without removing ordinary app actions.
- **Test in real browsers with real WebMCP calls.** Chrome DevTools MCP exercises approved capabilities through `list_webmcp_tools` and `call_webmcp_tool`; independent checks verify page state, not just compilation or the agent's claims.
- **Cover realistic workflows and failure cases.** Generate tests for every proposed tool, with prerequisite setup, success checks, and applicable expected business-rule rejections; execute the approved set. Missing tools, provider failures, and browser errors cannot masquerade as passing negative tests.
- **Compare against the existing interface.** UI-only baselines and final evaluation help you assess whether the agent-facing integration actually works alongside the human workflow.
- **Find problems before production.** Build checks, security audits, and browser verification can expose wiring bugs, broken workflows, authorization gaps, unsafe inputs, and duplicate-action risks. Balanced security distinguishes UI-only state from consequential backend effects; static checks are not proof of production enforcement.
- **Protect your working tree.** Draft in disposable workspaces, bind approval to source identity, and attempt rollback after failed apply/build checks. Keep local evidence for diagnosis; failure messages withhold prompts and source output.
- **Fit your existing agent workflow.** Use the CLI or local MCP server with supported Codex, Claude Code, Gemini, OpenCode, or Antigravity installations; no GitHub access is required by Core.
- **Handle long runs when needed.** Optional Temporal execution checkpoints the full pipeline from discovery through verification, with progress, deadlines, cancellation, and reattachment. Ordinary commands need no Temporal installation.

```text
Discover → Draft → Security check → Review → Apply → Test → Verify
```

WebMCP and browser support are experimental. Core checks the available runtime instead of assuming support.

## Install

```bash
npm install --global @improvisus/webmcpify-core
```

Requirements are stage-specific:

- **Every command:** Node.js 20.19+ on Node 20, Node.js 22.12+, or Node.js 23+.
- **Generate/apply:** Git with at least one target-project commit and installed target dependencies for dependency-based build checks. Dependency-free Node/JavaScript checks run without `node_modules`.
- **Agent-assisted commands:** one authenticated Codex, Claude Code, Gemini CLI, OpenCode, or Antigravity CLI, with a model available to that CLI/account. Core keeps your provider settings; it does not silently switch models when access fails.
- **Browser test/baseline:** a running development or staging URL plus Chrome 150+ or a compatible Chromium build with WebMCP support.
- **Durable run/repair and final-eval:** the optional Temporal packages, a Temporal service, and `webmcpify-worker`.

Git provides the source identity and exact-patch checks for approval, apply and
rollback; a remote repository or a new commit before every run is not required.

Core detects an installed provider when `--provider` is omitted; set `WEBMCPIFY_PROVIDER` for a fixed default. Antigravity accepts edits only inside the disposable workspace. Text-only suggestions do not become a source patch.

Disposable source copies keep internal symlinks inside the snapshot. If a source link points outside the selected project, choose a common project root containing that source; Core refuses an unsafe copy rather than exposing the original file to edits.

Cursor Agent is not currently a Core provider. Passing fixtures do not certify every OS or authenticated provider; see the [runtime compatibility audit](docs/audits/2026-10-01-runtime-compatibility.md) for tested behavior and remaining limits.

Browser testing uses a pinned Chrome DevTools MCP package started through `npx`; no separate global installation is required. Core safely merges project-local MCP configuration. First use needs registry access unless the package is cached.

## Fastest path

Start the target application, then run Core from that project's directory:

```bash
webmcpify run --url http://localhost:5173
```

This handles discovery → generation/security → human review → apply/build →
browser test and independent verification. Read the saved result with
`webmcpify eval`; it does not run the browser again.

To pause between stages, use the same workflow manually:

```bash
webmcpify generate --provider codex --method auto --no-product-context-prompt
webmcpify review
webmcpify apply
# Start the target application before this step if it is not already running.
webmcpify test --url http://localhost:5173 --provider codex
webmcpify eval
```

Generation includes discovery and security auditing, so separate `discover` and
`security` commands are optional inspections. Stop at a failed stage and address
its diagnostics before continuing. Rejection leaves application source unchanged;
approval alone does not apply the patch.

For Temporal checkpoints throughout this workflow, choose `run --durable` from
the beginning. `final-eval` is an optional, separate WebMCP/Temporal evaluation—not
the required next command after `test`. The full UI baseline is **off by default**.
Add `--baseline` to `test` to run every approved task through the ordinary UI
before WebMCP testing. `eval` then shows both scores and per-task comparisons;
it does not run the browser again. Standalone `baseline` remains available.
For an original-interface comparison, start `final-eval --baseline` before
applying the proposal: it measures the UI before apply and WebMCP testing.

Or select a provider explicitly:

```bash
webmcpify run --url http://localhost:5173 --provider codex
```

After discovery, an interactive run offers one optional product-context input. Describe workflows, existing features, or intended outcomes to help generation find relevant integrations; press Enter to skip. Discovery remains the source of truth, and Core verifies the note against the code before using it.

```bash
# Useful in a terminal; omit the option or press Enter to skip it.
webmcpify run --url http://localhost:5173 --product-context "Customers order coffee for pickup and manage subscriptions"

# Useful for scripts that must never prompt.
webmcpify run --url http://localhost:5173 --no-product-context-prompt
```

Security defaults to `balance`. Select another policy explicitly; review keeps the policy recorded for its draft until you regenerate it:

```bash
webmcpify run --url http://localhost:5173 --provider agy --security balance
webmcpify run --url http://localhost:5173 --provider agy --security ignore
webmcpify run --url http://localhost:5173 --provider agy --security strict
webmcpify generate --provider codex --security balance
```

`run` performs the normal workflow:

1. Discover routes, forms, handlers, APIs, state, authentication signals, and existing WebMCP tools.
2. Draft tools, feedback, documentation, and browser-verifiable tasks in a disposable workspace.
3. Audit each tool's declared scope and applicable security controls.
4. Open the local review page for human approval of the tools, tests, and exact source diff.
5. Apply an approved patch and run the target's available typecheck and build scripts.
6. Reuse an available CDP browser or start isolated headless Chrome, exercise approved WebMCP tools, and independently verify page state.

Discovery records source-backed handlers, store actions, conditional bindings such as login/logout, and multiline callbacks. Every resolved candidate must map to a proposed tool, an existing registration, or a source-grounded omission reason. Dynamic handlers, aliases, and non-JS/TS templates still need source tracing; discovery cannot guarantee complete coverage. Review the patch and omission reasons before approval.

**Allow several minutes**, or longer for larger projects and slower providers. Generation, build checks, human review, and per-capability browser tests all take time; tool deselection may require another drafting/build cycle. CLI phase messages, elapsed-time indicators, and task counters show progress, not percentage estimates.

Use `--path /path/to/project` outside the target directory. Supply `--url` or set `WEBMCPIFY_URL`; Core does not assume a port. Discovery, generation, security, review, and apply do not require the app server to be running. Browser tests and baselines do, so keep it running for `run`.

### Review and tool selection

The review page identifies the project and repository, lists every changed file with its purpose, and groups security, verification, and source details into collapsible sections. Read the exact diff: inferred file purposes do not prove a change is necessary.

- To keep the draft, check **I approve this exact source patch**, click **Approve reviewed draft**, and confirm.
- To remove tools, uncheck them and choose **Prepare selected-tool draft**. Source consent is cleared and disabled until the revised draft is ready. Tool contracts and tests are read-only; select tools, not individual tests.
- During revision, all review tabs lock and show a spinner, elapsed time, and current phase. Core removes rejected registrations and dependent tests, preserves unaffected tests and ordinary app actions, and updates retained-tool documentation.
- Straightforward registrations are removed directly; entangled source or missing test coverage may require a focused provider pass. Build, wiring, feedback, security, and identity checks precede fresh review. A coverage-only pass cannot change source.
- Review and confirm the new patch identity. You can repeat tool removal before approval. Failed revisions preserve the selection for retry, apply no target source, and keep raw diagnostics private.

Initial and revised drafts target 30% extra tests and accept a minimum of `ceil(tool count × 1.2)`, covering every retained tool with meaningful scenarios rather than duplicate padding. For example, 10 tools need at least 12 tests; 13 or more are welcome, and unaffected tests are preserved.

After confirmation, CLI activity shows review connections closing. Standalone `review` then exits without applying or testing; run `apply` and `test`, or use `run` for the complete workflow. Repair reviews keep their previously approved tools/tests fixed; reject a repair and generate a new draft to change capabilities. Initial durable review permits tool selection.

Generation first edits source with a compact prompt, then authors tool contracts and browser tasks in separate read-only passes without a large combined response schema. Core accounts for capabilities from their source mappings and requests a coverage report only where needed. Metadata passes must leave source and Git state unchanged. Invalid metadata gets one bounded correction. Build and security checks still run before human review; nothing is applied during generation. Full review and failure scenarios are in the [step-by-step test guide](docs/testing/end-to-end.md).

For focused generation debugging, run `generate --diagnostic-source-only` once to save a private, unapproved `.webmcpify/generation-source.json` checkpoint, then retry with `generate --diagnostic-metadata-only`. Metadata-only retries restore that source in a disposable copy and skip the source provider. They stop before correction, coverage, build, security, review and apply, preserve existing approval state, and cannot create an approved patch. A Git checkout is required to detect stale checkpoint source; reviewed patches also require a target commit. Changing target source requires a new checkpoint. Normal generation also checkpoints source before metadata, so a future metadata failure can be investigated without generating source again.

Coverage reports accept labelled JSON with or without Markdown fences, or one unambiguous JSON report without a heading. Core can recover a unique one-character copied candidate-ID typo when the named handler and proposed tool's source file agree. It distinguishes current-draft tools from pre-existing registrations and can correct report metadata once while retaining source, tools and tests. Actions still need a valid mapping or a source-grounded omission reason before review.

After a successful metadata diagnostic, use `generate --continue-from-metadata <metadata-file>` with the complete metadata artifact printed by that run. Core verifies it belongs to the same source checkpoint, freezes its contents, skips initial source/tool/task generation, and continues through the existing metadata, coverage, build and security checks to a pending review draft. Invalid input may require the existing bounded corrections; continuation never approves or applies source automatically.

### Browser testing and verification

Core connects Chrome DevTools MCP before starting each task agent and binds the gateway to that task's isolated tab. The agent receives only `list_webmcp_tools` and `call_webmcp_tool` (delegating to the pinned server's `execute_webmcp_tool`). Clicks, injected JavaScript, `cua_repl`, other bridges, or claimed tool calls cannot substitute for recorded WebMCP execution. `baseline` separately exercises the human interface.

Success tasks declare prerequisite setup. Expected-rejection tasks preserve the specific unmet business prerequisite, such as logged-out checkout. They may use successful setup tools first; the last `requiredTools` entry is the primary rejected action. Core requires ordered successful setup, exactly one matching business error, and an independent unchanged-state check. Setup calls to the same tool with different inputs are also allowed. Missing tools, setup failures, undeclared input failures, cancellation, connection errors, or successful retries are not valid expected rejections.

Verification runs on the acted-on tab with deadlines and cancellation; negative checks include a 500 ms unchanged-state settle window, not a guarantee against later effects. Checks must tolerate missing storage keys without creating state. Approved criteria never change silently: invalid checks require regeneration/review, while infrastructure failures must be resolved before source repair.

`test` saves the evaluation and exits nonzero if any approved task fails. Provider failures cannot pass merely because a page already matches. Repair apply records `awaiting-test`; rerun `test` to measure improvement. Final-eval and durable repair already retest. Final-eval reuses only current-policy results matching the URL, provider, exact tasks, and local Git source identity for WebMCP. `eval` can display older reports, but they cannot replace fresh execution or attest that a remote deployment matches your checkout.

## Agent-ready websites and repositories

Generation proposes the following guidance in the reviewed patch. Public references use an identifiable root-served directory; repository guidance remains separate:

| File | Purpose |
| --- | --- |
| `llms.txt` | A concise Markdown entry point linking to capability guidance and crawler policy. The filename is plural. |
| `webmcp.md` | Public tool names, inputs, authentication requirements, preconditions, and interaction boundaries. Documentation, not an HTTP MCP endpoint. |
| `webmcp.html` | Plain, crawlable HTML with project identity, descriptions, input constraints, prerequisites, outcomes, expected rejections, access answers, and truthful WebPage metadata. Uses `webmcp-capabilities.html` if the first filename belongs to the owner; preserves both if both are owner-authored. |
| `robots.txt` | Narrow `Allow` entries for the generated public reference files in the wildcard crawler group. Existing groups, restrictions, and sitemap entries are retained. |
| `AGENTS.md` | One target-root guide combining repository-maintenance instructions and detailed site capabilities: inputs, prerequisites, effects, outcomes, expected rejections, safe WebMCP usage, and Improvisus/WebMCPify integration attribution. Existing owner instructions are retained. |
| `README.md` | A merged target-repository summary explaining its proposed agent-ready capabilities and linking to detailed guidance. |
| `docs/webmcp-readiness.md` | Deployment, crawlability, internal linking, canonical/sitemap, metadata, privacy, and GEO/AEO verification checklist. Always included, even if asset serving is unknown. |

Core merges its marked sections on later generations and preserves owner content. One root `AGENTS.md` combines coding-agent and site-capability guidance; no second `.agent.md` is generated, and existing owner `.agent.md` files remain untouched. Public reference files belong in served assets, never `.webmcpify`.

`AGENTS.md` has no public route configured by Core. If deployment serves the repository root, review document exposure and block private `.webmcpify` state. Public guidance excludes local paths, internal security notes, and schema default values; it describes proposed capabilities, not certified browser-test results.

GEO/AEO readiness means readable, source-grounded content and deliberate crawler access—not guaranteed discovery or citations by GPT, Claude, Improvisus, or another agent. Link the public reference, verify deployment, and maintain real canonical URLs/sitemaps. Core does not invent domains, submit indexing requests, register crawlers, or enable training bots. Search and training controls are separate; Google requires no special `llms.txt` or AI schema. See the [research and implementation notes](docs/audits/2026-10-02-agent-discovery.md).

Common React/Next/Vue/Astro projects use `public/`; literal Vite `root`/`publicDir`
settings are honored. Svelte uses `static/` or its literal configured assets
directory. Angular uses a root-output asset mapping in `angular.json`; legacy
`src/assets` alone does not serve `/llms.txt`. Static HTML projects can use their
document root. Custom servers and dynamic asset configurations may need
deployment-specific wiring. If Core cannot establish a root-served directory,
it includes `docs/webmcp-readiness.md` with deployment steps and reports the
limitation. A Next.js `app/robots.ts`/`app/robots.js` metadata route retains
ownership of `/robots.txt`; Core does not add a conflicting public file.

Crawler permission does not authorize tool use. Core preserves explicit restrictions and does not add blanket `Allow: /` or open private routes. Review crawler changes; authentication and business rules still govern actions. `robots.txt` is not access control ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html)).

Readiness also requires accessible names and labels, stable page layout, clear
schemas, truthful structured outcomes, state-aware tool availability, and
verification of real effects. These are emphasized by Chrome's
[agent-ready toolkit](https://developer.chrome.com/blog/agent-ready-toolkit).
`llms.txt` is an [emerging optional convention](https://llmstxt.org/), not a
guarantee that every agent discovers or consumes the site. Existing sitemaps
and semantic metadata should remain grounded in real public URLs.

## JavaScript, TypeScript, and framework feedback

Core discovers `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, HTML, and common
framework components. A JavaScript target does not need a TypeScript migration,
new `tsconfig.json`, or TypeScript-only assertions. Preflight uses explicit
build/typecheck scripts; the implicit `tsc` fallback requires both a
`tsconfig.json` and an installed compiler. A transitive TypeScript dependency
alone does not make a JavaScript target a TypeScript project.
Build checks use the target's lockfile-selected package manager (or
`WEBMCPIFY_PACKAGE_MANAGER`), with npm as the fallback when no lockfile exists.
When both scripts are declared, preflight runs both typecheck and build: a
typecheck mentioning `build` or a TypeScript build is not proof of a successful
framework bundle. Unreadable/malformed package manifests stop validation with a
clear environment error rather than silently skipping checks. Targets without a
package manifest retain their existing no-script behavior.

Disposable preflight builds reuse installed dependencies and disable pnpm's automatic before-run installation only for validation subprocesses, without changing the target dependency tree. Missing dependencies may prevent dependency-based validation; review warnings before approval.

Declarative integrations annotate the actual form with `toolname` and
`tooldescription`, preserving validation and normal submission. `toolautosubmit`
is appropriate only when existing consent and confirmation behavior permits it.
Generation requires loaded styles for `:tool-form-active` and
`:tool-submit-active`, plus an accessible status region for agent activity.
Use feature guards so unsupported browsers retain their normal styles:

```css
@supports selector(form:tool-form-active) {
  form:tool-form-active { outline: 2px solid currentColor; outline-offset: 4px; }
}
@supports selector(:tool-submit-active) {
  :tool-submit-active { outline: 2px dashed currentColor; outline-offset: 3px; }
}
```

The draft must also provide visible status text, such as “Agent is filling this
form,” through an existing feedback component or a `role="status"`,
`aria-live="polite"` region. Color or CSS-generated text alone is insufficient.
Generation instructions require matching `toolName`, handling activation and
cancellation, and clearing pending feedback on completion, failure, or reset.
Imperative handlers are instructed to report activity through the existing UI
too. See Chrome's [declarative API guide](https://developer.chrome.com/docs/ai/webmcp/declarative-api).

- React/Next uses browser effects/client components, stable state access,
  cleanup compatible with Strict Mode, and existing CSS modules/global styles.
  Native submit extensions are read through `event.nativeEvent`.
- Angular uses the installed version's browser lifecycle/destruction hooks,
  existing form/state logic, component styles, and `[attr.toolname]` and
  `[attr.tooldescription]` when attributes are dynamic.
- Vanilla JavaScript, Vue, and Svelte retain their existing mount, cleanup,
  and stylesheet conventions. Unsupported browsers keep the human interface.

Form-feedback checks inspect source wiring and accessibility markers. Test the
approved app in a supported browser to verify event behavior, visible styling,
and real outcomes; static checks cannot prove those properties.

## New, partial, and existing WebMCP

Core works from the target's real source rather than assuming a blank application:

- **Newly scaffolded app:** Core can add the first tools once the app has source code, installed dependencies, and an initial Git commit. It does not scaffold the web app itself.
- **App without WebMCP:** discovery maps existing user actions and generation proposes the smallest grounded integration.
- **Partial WebMCP:** existing registrations are detected. Generation is required to classify them, reuse their integration files, avoid duplicates, and propose only missing or justified repairs.
- **Complete WebMCP:** generation is instructed to preserve registrations that need no change. If no source change is justified, Core leaves the target unchanged and stops before review/apply instead of inventing a patch. A previously Core-approved app can be retested directly with `webmcpify test`.

## Safety boundary

- The coding agent edits a disposable copy, not the target checkout.
- Generation produces a pending patch; it does not apply source changes.
- Approval is tied to the exact tool set, task set, patch, and source state.
- Apply rejects missing, stale, altered, or unapproved patches.
- Git applies the exact validated patch bytes, not a mutable pending file.
- Target typecheck/build failures trigger rollback.
- Browser tests expose only approved WebMCP tools to the test agent.
- Actual discovery/call results are recorded by Core, separately from provider reports; an initially-true postcondition without required calls cannot pass.
- Security gating follows the selected `run --security` policy; human approval of the exact patch is always required.
- Verification reads the resulting application state instead of trusting the agent's report.
- Run evidence and approved tasks stay in the target's ignored `.webmcpify/` directory; see [Project artifacts](#project-artifacts).
- Provider failures withhold prompts and source output from the terminal. Private diagnostics are local files that can contain prompts and code—do not publish them unredacted.

Core reduces risk; it does not guarantee that generated code or WebMCP tools are safe. Review every proposal before approval.

Disposable workspaces copy current files on disk, including saved uncommitted edits and relevant untracked/ignored files—not just the last commit. **Save editor buffers first**; no new commit is required. Root and nested `.git`, `.webmcpify`, `.serena`, and `node_modules` are excluded, but Git-ignored build assets are not blindly omitted.

Where supported, copy-on-write shares unchanged disk blocks until a copy is edited; otherwise Core uses ordinary copying. Editable source is never hard-linked, and the included files and approval boundary stay the same. Savings depend on the filesystem. Temporary workspaces are removed after use; patches and evidence remain in `.webmcpify`.

Core reuses the target's installed dependencies for disposable build checks;
it does not copy `node_modules` or ask the coding agent to install packages.
Install missing dependencies in the target yourself before retrying a
dependency-based check. This is separate from installing Core.

## Commands

| Command | Purpose |
| --- | --- |
| `webmcpify run [--security balance\|ignore\|strict] [--product-context <text>] [--durable]` | End-to-end workflow; balanced by default. Optional Temporal checkpoints begin at discovery. Interactive terminals may add optional product context. |
| `webmcpify discover` | Inspect the target and write `.webmcpify/discovery.json`. |
| `webmcpify generate [--security balance\|ignore\|strict]` | Draft tools, tasks, form feedback, agent-readiness files, and a pending patch; balanced by default. |
| `webmcpify security [--strict]` | Audit proposed/approved tools and write a security report. |
| `webmcpify review` | Approve or reject the exact draft; approval saves `.webmcpify/tasks.json`. |
| `webmcpify apply` | Apply the approved patch and verify the target build. |
| `webmcpify test --url <url>` | Test approved tools in an isolated browser session. |
| `webmcpify eval` | Print the latest project-scoped verification result. |
| `webmcpify repair` | Draft a repair for failed approved tasks. |
| `webmcpify baseline` | Run all approved tasks through the ordinary UI, without WebMCP calls. |
| `webmcpify final-eval` | Advanced WebMCP, repair, and Temporal evaluation; add `--baseline` for the full UI comparison. |

Every command accepts `--path`; it defaults to the current directory where practical. Run `webmcpify <command> --help` for its options.

## MCP server

Core can run as a local stdio MCP server for coding agents:

```json
{
  "mcpServers": {
    "webmcpify-core": {
      "command": "npx",
      "args": ["--yes", "--package", "@improvisus/webmcpify-core", "webmcpify-mcp"],
      "cwd": "/path/to/target-project"
    }
  }
}
```

The server exposes:

- `analyze_repository`
- `generate_webmcp`
- `audit_webmcp_security`
- `apply_webmcp`
- `test_webmcp`

The server rejects paths outside its starting workspace. Generated changes remain pending until the normal human review creates an approval manifest; `apply_webmcp` also requires the matching patch identifier.

## Core access-control checkpoint

Generated tools declare a security contract covering execution scope, authentication, verified-agent requirements, server authorization, origin scope, quotas, and idempotency. This is internal review evidence, not a WebMCP field.

- `balance` (default) blocks missing controls for high-impact effects such as real checkout/payment, order submission, destructive account changes, financial transfers, or external publication.
- `strict` also checks applicable contract findings, input bounds, privacy, and origin scope. Backend mutations need server authorization; consequential effects also need user/agent binding, quotas, and replay protection.
- `ignore` skips automated security findings and gating, but never skips human approval.

Both active policies distinguish reversible browser UI state from backend effects and block invalid cross-origin allowlists. Navigation, form filling, filters, local cart edits, and simulated UI-only checkout do not need invented backend controls. Declare `executionScope: "ui-state"` with source evidence for UI actions, or `backend` for server mutations; a UI label cannot disguise a real high-impact effect.

A simple, source-backed local store checkout can reach review with a scope notice. Real network effects, unknown helpers or unsafe persistence retain the consequential checks; the notice is not proof of deployed behavior.

```bash
webmcpify security --path /path/to/project
webmcpify security --path /path/to/project --strict
```

Standalone `security --strict` selects the strict audit policy **and** exits with
a command failure on blocking findings. Without the flag, it uses the balanced
policy. It does not change the policy recorded in an existing generation draft.

The report is written to `.webmcpify/security-report.json` and shown during review. Static analysis cannot prove that a backend enforces a claim, so the exact patch must still be reviewed. Core does not yet issue or verify a universal provider-attestation token, and production policy storage remains the target backend's responsibility.

## Advanced durable workflows

Normal `run` and one-shot `repair` do not require Temporal. Use `run --durable` for checkpoints **from discovery onward**; `repair --durable` and `final-eval` also require Temporal. Install the optional peers alongside Core:

```bash
npm install --global \
  @temporalio/client \
  @temporalio/worker \
  @temporalio/workflow
```

Install the [Temporal CLI](https://docs.temporal.io/cli) separately to run the local development service.

Run the Temporal service, Core worker, and workflow command in separate terminals:

```bash
temporal server start-dev --db-filename ./temporal-dev.sqlite
webmcpify-worker
webmcpify run --durable --url http://localhost:5173 --provider codex --baseline
```

These are **three separate terminals**. Keep the target app server running too.
Store the development database outside the target's source/deployment files;
the dev server is not a production deployment. Without `--db-filename`, stopping
that service loses its history.

`run --durable` checkpoints discovery → generation/preflight → the recorded
security policy → human review → optional UI-only baseline → exact-source
apply/build → each approved WebMCP task → independent evaluation. `--baseline`
measures the original interface before apply; its low scores are valid comparison
data, but provider failures stop this pipeline before application. Without the
flag, the baseline stage is skipped. Initial durable review permits repeated tool
deselection and revised source/tasks just like normal review. Repair reviews
continue to freeze their already-approved criteria.

The client prints live phases, task counts and the actual review URL, including
port fallback. That localhost page is on the **worker machine**. Use a worker
with the same target path, provider/Chrome installations and target dependencies
as the CLI; all providers' executable overrides belong in the worker environment.
Durable repair records the initiating CLI's selected/configured provider, rather
than adopting a different worker default.
Its browser runs on the worker; the durable-repair client need not have Chrome.
Durable tests use the same two-method Chrome DevTools WebMCP gateway, approved
allowlist, setup and independent scorer as ordinary tests. They do not substitute
another browser or trust a model's completion claim.

For longer operations:

```bash
webmcpify run --durable --url http://localhost:5173 --provider codex \
  --activity-timeout 240 --review-timeout 336
```

Activity deadlines are minutes (default **120**, allowed 1–10080); review
deadlines are hours (default **168**, allowed 1–8760). Each WebMCP task has its
own activity; the optional baseline's total budget scales with task count.
Durable provider defaults use the remaining activity budget, reserving cleanup
time; explicit provider timeout overrides still take precedence. Heartbeats and
local deadlines keep long waits bounded, including during service disruption.
Build cancellation stops owned subprocess trees before rollback can complete.

The client prints a reattach command containing the workflow and execution IDs:

```bash
webmcpify run --durable --resume WORKFLOW_ID --execution-id RUN_ID --path /path/to/project
```

Copy the real IDs from the CLI; these are placeholders. Reattach never generates
a new draft. `--execution-id` pins the original execution if the stable target
workflow ID was later reused. A stale `WEBMCPIFY_URL` does not override a resumed
workflow; an explicitly supplied `--url` must match. Starting a second active
full pipeline for the same canonical target is refused. Ctrl+C disconnects this
client, **not** the worker workflow; use Temporal UI/API cancellation when you
intend to cancel the operation. Completed-run reattach reports saved results,
not a fresh browser audit.

For targeted repairs/comparisons, existing commands remain available:

```bash
webmcpify repair --durable --url http://localhost:5173 --task YOUR_APPROVED_TASK_ID --provider codex --max-repairs 3
webmcpify final-eval --url http://localhost:5173 --provider codex
# Optional full UI comparison, measured before apply/WebMCP testing:
webmcpify final-eval --url http://localhost:5173 --provider codex --baseline
```

Durable repair captures the approved task fingerprint at start, requires exact
review/apply identity, and exits nonzero if it does not pass. `final-eval` no
longer reports success just because a workflow finished: all final task results
must pass, and a source-changing Temporal repair triggers a full final-source
retest instead of retaining earlier passes. Already-passing independent WebMCP
results can still be reused when no repair/source change is needed.
Durable repair first retests the selected approved task, even if it passed
earlier. For a test-only Temporal smoke check, use the same command with
`--max-repairs 0`: it performs one fresh test and cannot generate or apply a
repair. Select a task ID from `.webmcpify/tasks.json`; a passing single task
checks that path, not the complete workflow or all capabilities.
When `--baseline` is requested, an unusable UI baseline leaves the comparison incomplete (nonzero exit),
even if final WebMCP tasks pass; low baseline scores alone are valid and do not
cause this failure. The approved patch/test flow and its evidence are preserved.
The comparison prints at the end of `final-eval` and is saved in its trajectory;
`eval` also displays it when it belongs to the exact latest test run. Unrelated
older baselines are not attached to a new test. Resume with the same `--baseline`
choice as the saved run. Baselines test the same tasks, but UI/WebMCP scores are
not equivalent for capabilities with no human-interface counterpart.
The evaluation checks the optional Temporal client and connection settings before
starting Chrome or generation, and saves reviewed progress checkpoints. Temporal
service/worker availability is still required for the durable
level; installed packages alone do not provide a running service.

Worker/clients share `WEBMCPIFY_TEMPORAL_ADDRESS`, `WEBMCPIFY_TEMPORAL_NAMESPACE`,
and `WEBMCPIFY_TEMPORAL_TASK_QUEUE`. Set `WEBMCPIFY_TEMPORAL_TLS=true` for TLS and
optionally `WEBMCPIFY_TEMPORAL_API_KEY` in their launching processes (a key enables
TLS by default). Keep keys out of source, workflow inputs and public documentation.
Product-context text is a workflow input: **do not put secrets in it**. Source
patches, verification expressions and raw provider diagnostics stay in local
artifacts, rather than being returned in the new pipeline's history.

`WEBMCPIFY_DURABLE=true` opts `run` and `repair` into Temporal by default;
`--no-durable` overrides it. The worker executes one activity at a time because
Core shares browser/draft state within that process. Prefer a dedicated queue
and worker per target, do not mix concurrent manual commands on one target, and
only accept trusted workflow submissions: build/provider commands are not a
public sandbox.

Completed checkpoints survive client disconnect and worker restart. Abrupt
worker loss **during** a side-effecting activity/review fails closed; it does not
automatically repeat a purchase, apply or generation. Keep the worker alive while
review is open. Inspect retained `.webmcpify` state/rollback backups before
recovery from an in-flight crash. Automatic activity retries remain disabled;
targeted repair uses its explicit budget. Older repair histories retain their
original activity options and are replay-tested. Local live tests prove heartbeat
survival, cancellation cleanup and completed-stage recovery—not arbitrary
crash safety, every OS, production deployment, or authenticated model behavior.

## Configuration

No `.env` file or executable path is required when the provider CLI and Chrome are already on `PATH`. Run inside the target project, or use `--path`; there is no target-path environment variable. Core does not load the target application's `.env`. Set optional overrides in the shell that starts Core:

```bash
WEBMCPIFY_PROVIDER=codex
WEBMCPIFY_URL=http://localhost:5173
WEBMCPIFY_CHROME_BIN=/path/to/chrome
WEBMCPIFY_CDP_URL=http://127.0.0.1:9222
```

Provider executable overrides are available as `WEBMCPIFY_CODEX_BIN`, `WEBMCPIFY_CLAUDE_BIN`, `WEBMCPIFY_GEMINI_BIN`, `WEBMCPIFY_OPENCODE_BIN`, and `WEBMCPIFY_ANTIGRAVITY_BIN`.

For troubleshooting, prefix a command with `WEBMCPIFY_TRACE=1` to show safe
generation stages, provider event types and stream byte counts. Trace output
does not include prompts, code, tool arguments or raw provider diagnostics.

Core checks executable files on `PATH`, not shell aliases or functions. Codex also falls back to an executable in `~/.local/bin` or a supported editor installation. Relative executable paths and relative `PATH` entries are resolved before changing to the disposable workspace. Launch errors distinguish missing CLIs from a missing working directory or a broken launcher/interpreter; use an absolute override when necessary.

Browser agents run in empty disposable workspaces with a fresh context per task. Verification reads the acted-on tab, preserving DOM/component state, storage, cookies, and navigation; baselines also score tasks separately. The gateway and scorer share `WEBMCPIFY_CDP_URL` without overwriting owner MCP configuration.

The gateway enforces its two-method, approved-tool, exact-tab boundary for every provider, including durable attempts. Provider allowlists are not a universal OS sandbox. Private `test-evidence-*` artifacts distinguish actual calls and business errors from connection/policy failures; resolve infrastructure failures before attempting source repair.

OpenCode uses `run --auto --format json` and an inline MCP overlay without replacing `opencode.json`. Gemini receives merged workspace MCP settings; workspace trust remains the owner's choice. All providers have Core-level deadlines (normal runs: 5 minutes for browser tasks, 15 for generation/repair; durable runs: remaining activity budget with cleanup time reserved); override with `WEBMCPIFY_<PROVIDER>_TIMEOUT`, for example `WEBMCPIFY_CODEX_TIMEOUT=20m`. Antigravity's separate print-timeout setting remains available.

## Project artifacts

Discovery adds `/.webmcpify/` to the target's `.gitignore` before saving its
inventory. Fresh generation does the same before recording source identity;
existing ignore rules are preserved. This housekeeping needs no Git commit or
human approval. Application integration changes still require review and apply.

| Stage | Private files under `<target>/.webmcpify/` |
| --- | --- |
| Discovery | `discovery.json` |
| Generation | `proposed-tools.json`, `security-report.json`, `pending-diff.patch` and its metadata |
| Approval | `approved-tools.json` and `tasks.json` with the exact approved task set |
| Execution/recovery | Browser configuration, `trajectories/`, rollback data and durable/resume checkpoints |

Core no longer writes `tasks.json` at the target root. Legacy root task files
remain readable when the private file is absent, with the same approval checks;
Core does not automatically delete existing owner files. `AGENTS.md` and served
capability/crawler guidance stay outside private state, in the reviewed patch.

Keep `.webmcpify/` locally for reports, repair, rollback and resume; it is not
automatically deleted after success. Ignoring it does not affect CLI or Temporal
access. Exclude it from deployment separately; Git ignore rules do not untrack
already-committed files or prevent uploads. On older projects missing the rule,
run discovery before generation/review, not between approval and apply.

The leading dot may hide the folder on macOS/Linux; IDE and Windows visibility
is cosmetic, not security. Use editor `files.exclude`/`search.exclude` if desired.
Core does not require GitHub access or upload the target repository.

Local `npm pack` archives (`*.tgz`) are ignored in the Core repository. They are
installation/test artifacts, not source files; packing does not commit them.

### Automatic rollback

Before applying an approved patch, Core saves the original contents of existing
patch files under `.webmcpify/rollback/<run-id>/`. If patch application, target
typecheck, or build fails—or the apply/build operation is cancelled—it attempts
to restore those originals and remove files newly created by the patch. This
also restores deleted files and reverses file renames. Recovery shows CLI
activity; a successful rollback reports **project restored** and marks the
patch failed. It does not declare the integration successful.

Regression fixtures verify modifications, additions, deletions, renames,
typecheck/build failure, cancellation, and damaged-backup handling. A missing
original backup must never cause deletion of the current source. Core restores
other recoverable files, reports **rollback failed**, and retains recovery
material for manual inspection. Original/new-file classification stays in memory,
so a manifest altered by a failed build cannot misclassify and delete originals.
Keep `.webmcpify` when recovering from a failure.
After successful apply/build, temporary source backups are removed; cleanup
failure produces a warning, not an unsafe rollback from partly removed backups.

Rollback is limited to patch paths. It is not a database/payment undo, a reset
of arbitrary build-script side effects, or an automatic undo after later browser
test failures. There is currently no standalone `webmcpify rollback` command;
use your normal Git/recovery workflow for manually reverting a successful apply.

Before applying, save or commit your current work if you want a lasting undo
point. A browser test does not create a recovery snapshot, and a failed browser
test leaves the applied code in place for diagnosis or reviewed repair.

To smoke-test automatic recovery from the Core checkout:

```bash
pnpm build
pnpm run verify:patch
```

This focused check creates and deletes disposable Git repositories, applies
fixture approvals, deliberately fails builds/typechecks, and checks cancellation,
file restoration and damaged-backup handling. It needs Git and a package manager,
not the coffee server, Chrome, a model provider, or Temporal. It never applies a
patch to your target app. The same `apply` recovery code is used by the worker;
this check does not certify Temporal service or worker-crash recovery.

Serena's `.serena` configuration/cache files are agent-local state, not generated application changes. Core excludes them from workspace copies and pending patches and rejects patches targeting them. Existing owner `.serena` files remain untouched.

## Development

```bash
git clone https://github.com/improvisus-webmcp/webmcpify-core.git
cd webmcpify-core
pnpm install
pnpm typecheck
pnpm test
npm pack --dry-run
```

### Test this repository as the global CLI

Remove the npm-installed copy, build this checkout, and create a global link:

```bash
npm uninstall --global @improvisus/webmcpify-core
cd /path/to/webmcpify-core
pnpm install
pnpm build
npm link
hash -r
command -v webmcpify
webmcpify --version
```

`npm link` points the global command at this repository. After editing `src/`,
run `pnpm build` again; relinking is not normally required. Run it from a target project with its app server running:

```bash
cd /path/to/target-project
webmcpify run --url http://localhost:5173 --provider agy
```

To stop using the local checkout and restore the published package:

```bash
npm unlink --global @improvisus/webmcpify-core
npm install --global @improvisus/webmcpify-core
hash -r
```

`npm test` runs discovery, proposal, provider-output, product-context, optional Temporal, runtime safety, agent-readiness, security, review, patch, repair, evaluation, final-evaluation, and MCP checks. Runtime regressions cover real Git worktrees, spaced/quoted paths, patch tampering, untracked source changes, provider MCP adapters, cancellation, and shared Temporal settings. Agent-readiness fixtures exercise JS/TS generation, reviewed guidance, owner/crawler preservation, asset locations, and form-feedback checks. Run `npm run verify:browser-state` separately for a real-Chrome same-tab/cookie/navigation regression. The CI matrix runs Node 20/22 on Linux, macOS, and Windows; configuration is not evidence that those jobs have passed. Publishing runs the complete suite before packing.

Use the [complete step-by-step test guide](docs/testing/end-to-end.md) for local
installation, every CLI stage, partial approval, discovery files, browser feedback,
security modes, failures, MCP, and optional live Temporal checks. Preflight anchors
package-manager executables before changing workspace, skips stale optional
dependency links, and reports missing/non-executable validation commands without
asking the LLM to repair source. Review tries at most 20 ports before asking you
to choose another `--port`. Prompts and raw provider/build diagnostics stay out
of terminal failure messages.

## Architecture and contributing

- [Architecture and file map](ARCHITECTURE.md)
- [Contribution and pull-request guide](CONTRIBUTING.md)

## Links

- Website: https://improvisus.tech/core
- Documentation: https://improvisus.tech/docs
- Source and issues: https://github.com/improvisus-webmcp/webmcpify-core
- Security: https://improvisus.tech/security
- Support: support@improvisus.tech

MIT © Improvisus
