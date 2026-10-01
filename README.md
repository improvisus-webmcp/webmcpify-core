# WebMCPify Core

[![npm version](https://img.shields.io/npm/v/@improvisus/webmcpify-core.svg)](https://www.npmjs.com/package/@improvisus/webmcpify-core)
[![npm downloads](https://img.shields.io/npm/dm/@improvisus/webmcpify-core.svg)](https://www.npmjs.com/package/@improvisus/webmcpify-core)
[![GitHub release](https://img.shields.io/github/v/release/improvisus-webmcp/webmcpify-core)](https://github.com/improvisus-webmcp/webmcpify-core/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Create, review, test, and verify [WebMCP](https://webmachinelearning.github.io/webmcp/) capabilities for new and existing web applications.

Core inspects what a site already does, asks a coding agent to draft grounded WebMCP tools, form feedback, and agent guidance in an isolated copy, and shows the exact proposal for human approval. Only an approved patch can reach the target repository. The result is tested in a real browser and checked independently of the agent's claim. JavaScript and TypeScript targets retain their existing language, module system, and framework conventions.

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
- **Generate/apply:** Git with at least one target-project commit and installed target dependencies for available build checks.
- **Agent-assisted commands:** one authenticated Codex, Claude Code, Gemini CLI, OpenCode, or Antigravity CLI.
- **Browser test/baseline:** a running development or staging URL plus Chrome 150+ or a compatible Chromium build with WebMCP support.
- **Durable repair/final-eval only:** the optional Temporal packages, a Temporal service, and `webmcpify-worker`.

Core detects an installed provider when `--provider` is omitted. Set `WEBMCPIFY_PROVIDER` when you want a fixed default. Core normalizes raw text, JSON envelopes, JSONL events, and nested assistant-content fields into one provider-neutral response before parsing tools and tasks. Antigravity generation runs in its edit-acceptance mode inside Core's disposable workspace. If it responds with a text-only diff, Core gives it one focused edit-only retry; no patch is created unless actual workspace source files were changed.

Cursor Agent is not currently a Core provider. Installed-provider support and
passing fixtures do not certify every OS or a live durable workflow. See the
[runtime compatibility audit](docs/audits/2026-10-01-runtime-compatibility.md)
for the original findings, implemented fixes, and remaining native-OS/live-workflow verification limits.

Browser-agent testing uses Chrome DevTools MCP. Core writes or safely merges a project-local configuration and starts its pinned package with `npx`; a separate global installation is not required. The first use needs registry access unless that package is already cached.

## Fastest path

Start the target application, then run Core from that project's directory:

```bash
webmcpify run --url http://localhost:5173
```

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

`run` uses the balanced security policy by default. You can select the policy
explicitly:

```bash
webmcpify run --url http://localhost:5173 --provider agy --security balance
webmcpify run --url http://localhost:5173 --provider agy --security ignore
webmcpify run --url http://localhost:5173 --provider agy --security strict
```

- `balance` blocks missing controls for high-impact operations such as checkout,
  payment, order submission, financial transfers, destructive account changes,
  and external publication. Reversible UI state such as filters and cart edits
  does not require invented backend authorization, user/agent binding, quotas,
  idempotency, or string limits.
- `ignore` skips automated security findings and gating. The exact generated
  patch still requires human review and approval before it can be applied.
- `strict` checks the full declared contract, input bounds, privacy, and origin
  scope. Backend mutations require server authorization; consequential effects
  also require user/agent binding, quotas, and replay protection. Browser-only
  clicks, navigation, form filling, filters, local cart edits, and other reversible
  UI state do not require invented backend controls. Declare
  `executionScope: "ui-state"` with source evidence for these actions; `backend`
  for server mutations. High-impact effects cannot bypass checks using a UI label.

`run` performs the normal workflow:

1. Discover the target's routes, forms, handlers, APIs, state, authentication signals, and existing WebMCP tools.
2. Draft tools, accessible agent feedback, and browser-verifiable tasks in a disposable workspace. Every proposed tool must be covered by at least one task. Normal tasks declare their prerequisite setup; negative tasks may instead declare a source-grounded expected rejection (for example, checkout while logged out) and pass only when the tool call, expected error, and unchanged browser state are all observed. Add capability documentation and repository guidance to the same draft.
3. Audit each tool's declared scope and controls applicable to its actual effect: user/agent binding, server authorization, origin scope, quota, replay protection, and input bounds.
4. Open a local review URL and wait for the owner to approve or reject the exact tools, tasks, security findings, source changes, CSS, documentation, and crawler-policy changes.
5. Apply an approved patch and run the target's available typecheck and build scripts.
6. Reuse an available CDP browser or start an isolated headless Chrome session.
7. Exercise approved WebMCP tools and independently verify the resulting page state.

Use `--path /path/to/project` when running outside the target directory. Supply the running app URL with `--url`, or set `WEBMCPIFY_URL`; Core does not assume an application port.

## Agent-ready websites and repositories

Generation includes these files in the pending patch when Core can identify
a directory served at the website root:

| File | Purpose |
| --- | --- |
| `llms.txt` | A concise Markdown entry point linking to capability guidance and crawler policy. The filename is plural. |
| `webmcp.md` | Public tool names, inputs, authentication requirements, preconditions, and interaction boundaries. Documentation, not an HTTP MCP endpoint. |
| `robots.txt` | Narrow `Allow` entries for `/llms.txt$` and `/webmcp.md$` in the wildcard crawler group. Existing groups, restrictions, and sitemap entries are retained. |
| `AGENTS.md` | One target-root guide combining repository-maintenance instructions and detailed site capabilities: inputs, prerequisites, effects, outcomes, expected rejections, safe WebMCP usage, and Improvisus/WebMCPify integration attribution. Existing owner instructions are retained. |

Core merges its marked documentation sections on subsequent generations.
`AGENTS.md` contains both coding-agent and browser-agent guidance; Core does not
generate a second `.agent.md`. It remains separate from `.webmcpify` and leaves
room for future owner-authored capabilities. Existing owner `.agent.md` files are
left untouched, not silently deleted or overwritten. Public `llms.txt` and
`webmcp.md` stay in the site's served assets, never under `.webmcpify`.
Core does not configure a public route for `AGENTS.md`. If deployment serves the
whole repository root, review document exposure and dotfile-serving policy:
private `.webmcpify` state must not be served.
Public documentation excludes internal security notes, source paths, and schema
default values. It describes the proposed integration and does not certify
that it has passed browser tests.

Common React/Next/Vue/Astro projects use `public/`; literal Vite `root`/`publicDir`
settings are honored. Svelte uses `static/` or its literal configured assets
directory. Angular uses a root-output asset mapping in `angular.json`; legacy
`src/assets` alone does not serve `/llms.txt`. Static HTML projects can use their
document root. Custom servers and dynamic asset configurations may need
deployment-specific wiring. If Core cannot establish a root-served directory,
it includes `docs/webmcp-readiness.md` with deployment steps and reports the
limitation. A Next.js `app/robots.ts`/`app/robots.js` metadata route retains
ownership of `/robots.txt`; Core does not add a conflicting public file.

Crawler permission is separate from tool invocation. Core does not add blanket
`Allow: /` rules, enable training bots, or open private API/account/admin routes.
Explicit metadata-file prohibitions and crawler-specific restrictions remain
in place. Review the patch to decide whether existing policies should change.
`robots.txt` does not enforce authorization; authentication and application
business rules still govern actions. See [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html).

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
- Target typecheck/build failures trigger rollback.
- Browser tests expose only approved WebMCP tools to the test agent.
- Security gating follows the selected `run --security` policy; human approval of the exact patch is always required.
- Verification reads the resulting application state instead of trusting the agent's report.
- Run evidence stays in the target project's ignored `.webmcpify/` directory.
- Provider failures withhold prompts and source output from the terminal; raw diagnostics remain in local trajectory files.

Core reduces risk; it does not guarantee that generated code or WebMCP tools are safe. Review every proposal before approval.

## Commands

| Command | Purpose |
| --- | --- |
| `webmcpify run [--security balance\|ignore\|strict] [--product-context <text>]` | Normal end-to-end workflow; balanced by default. Interactive terminals may add optional product context after discovery. |
| `webmcpify discover` | Inspect the target and write `.webmcpify/discovery.json`. |
| `webmcpify generate` | Draft tools, tasks, form feedback, agent-readiness files, and a pending patch. |
| `webmcpify security [--strict]` | Audit proposed/approved tools and write a security report. |
| `webmcpify review` | Review and approve or reject the exact draft locally. |
| `webmcpify apply` | Apply the approved patch and verify the target build. |
| `webmcpify test --url <url>` | Test approved tools in an isolated browser session. |
| `webmcpify eval` | Print the latest project-scoped verification result. |
| `webmcpify repair` | Draft a repair for failed approved tasks. |
| `webmcpify baseline` | Run a comparison against the existing interface. |
| `webmcpify final-eval` | Advanced baseline, WebMCP, repair, and Temporal comparison. |

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

Core asks generated tools to describe an internal security contract. This is review evidence, not a WebMCP field. It covers execution scope, user authentication, verified-agent requirements, server authorization, exact origin scope, per-tool quotas, and idempotency. The normal `run` workflow defaults to `balance`; `strict` also examines input bounds, privacy, and all applicable contract findings, while `ignore` disables automated security gating. Both active policies distinguish browser UI state from backend effects. An invalid cross-origin allowlist still blocks under either active policy.

```bash
webmcpify security --path /path/to/project
webmcpify security --path /path/to/project --strict
```

The report is written to `.webmcpify/security-report.json` and shown during review. Static analysis cannot prove that a backend enforces a claim, so the exact patch must still be reviewed. Core does not yet issue or verify a universal provider-attestation token, and production policy storage remains the target backend's responsibility.

## Advanced durable workflows

The normal `run` command and one-shot `repair` command do not use Temporal. Use Temporal when repair progress and retries must survive process interruption. The current three-level `final-eval` command includes that durable Temporal level, so it also requires Temporal. Install its optional packages alongside Core:

```bash
npm install --global \
  @temporalio/client \
  @temporalio/worker \
  @temporalio/workflow
```

Install the [Temporal CLI](https://docs.temporal.io/cli) separately to run the local development service.

Run the Temporal service, Core worker, and workflow command in separate terminals:

```bash
temporal server start-dev
webmcpify-worker
webmcpify final-eval --url http://localhost:5173 --provider codex
```

The CLI starts a workflow, the Temporal service keeps its state, and `webmcpify-worker` executes Core's test, repair, review, and apply activities. Durable tests use the same approved task definition, tool allowlist, prerequisite setup, and independent scorer as ordinary tests. Human approval remains mandatory. Set `WEBMCPIFY_DURABLE=true` only if ordinary `webmcpify repair` calls should use Temporal by default.

Worker and clients share `WEBMCPIFY_TEMPORAL_ADDRESS`, `WEBMCPIFY_TEMPORAL_NAMESPACE`, and `WEBMCPIFY_TEMPORAL_TASK_QUEUE`. Set `WEBMCPIFY_TEMPORAL_TLS=true` for TLS and optionally `WEBMCPIFY_TEMPORAL_API_KEY` in the launching process (an API key enables TLS by default). Keep keys out of source and public documentation. Test/repair/apply activities have a 30-minute deadline; owner review has 24 hours. Activities heartbeat and propagate cancellation to providers, build checks, and the review server. Automatic activity retries are disabled for side-effecting operations; the workflow's explicit repair budget remains. Native SDK limitations still apply.

## Configuration

No `.env` file or executable path is required when the provider CLI and Chrome are already on `PATH`. Run inside the target project, or use `--path`; there is no target-path environment variable. Core does not load the target application's `.env`. Set optional overrides in the shell that starts Core:

```bash
WEBMCPIFY_PROVIDER=codex
WEBMCPIFY_URL=http://localhost:5173
WEBMCPIFY_CHROME_BIN=/path/to/chrome
WEBMCPIFY_CDP_URL=http://127.0.0.1:9222
```

Provider executable overrides are available as `WEBMCPIFY_CODEX_BIN`, `WEBMCPIFY_CLAUDE_BIN`, `WEBMCPIFY_GEMINI_BIN`, `WEBMCPIFY_OPENCODE_BIN`, and `WEBMCPIFY_ANTIGRAVITY_BIN`.

Browser agents run in empty disposable workspaces, with a fresh browser context per task. Core verifies the same task tab after execution, preserving DOM/component state, session storage, cookies, and navigation. Baselines also run and score each task separately. The browser MCP bridge and scorer use the same `WEBMCPIFY_CDP_URL`; owner MCP configuration is not overwritten. Non-Claude tool allowlists remain instruction-level constraints, not a universal OS sandbox.

OpenCode uses `run --auto --format json` and an inline MCP overlay without replacing `opencode.json`. Gemini receives merged workspace MCP settings; workspace trust remains the owner's choice. All providers have Core-level deadlines (5 minutes for browser tasks, 15 for generation/repair); override with `WEBMCPIFY_<PROVIDER>_TIMEOUT`, for example `WEBMCPIFY_CODEX_TIMEOUT=20m`. Antigravity's separate print-timeout setting remains available.

## Project artifacts

Core writes local state under `<target>/.webmcpify/`, including discovery, proposed tools, `security-report.json`, the pending patch, approvals, evaluations, rollback data, and timestamped evidence. Keep this directory out of source control. The proposed combined `AGENTS.md`, public capability documentation, crawler policy, and UI styles are ordinary target files included in the reviewed patch; they are separate from private run evidence. Core does not require GitHub access and does not upload the target repository.

Keep `.webmcpify` local and project-specific: approvals, resume checkpoints, and
rollback depend on it. The leading dot hides it by convention on macOS/Linux;
Windows and IDE explorers may still show it. Hiding is cosmetic, not security.
Core currently does not automatically change the target's ignore policy. Add
`/.webmcpify/` to `.gitignore` (or Git's local exclude), and exclude it from
deployment/build contexts. In VS Code/Cursor you may optionally use
`files.exclude` and `search.exclude` for `**/.webmcpify`. Do not hide or ignore
the site-facing guidance files, and do not delete run state until approval,
verification, and any required rollback/resume are complete.

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
cd /home/olumide/Desktop/Webmcpify/webmcpify-packages/public/webmcpify-core
pnpm install
pnpm build
npm link
hash -r
command -v webmcpify
webmcpify --version
```

`npm link` points the global command at this repository. After editing `src/`,
run `pnpm build` again; relinking is not normally required. Test it from the
Coffee Store project with:

```bash
cd /home/olumide/Desktop/Webmcpify/webmcpify-testing-projects/webmcpify-coffe-store
webmcpify run --url http://localhost:5173 --provider agy
```

To stop using the local checkout and restore the published package:

```bash
npm unlink --global @improvisus/webmcpify-core
npm install --global @improvisus/webmcpify-core
hash -r
```

`npm test` runs discovery, proposal, provider-output, product-context, optional Temporal, runtime safety, agent-readiness, security, review, patch, repair, evaluation, final-evaluation, and MCP checks. Runtime regressions cover real Git worktrees, spaced/quoted paths, patch tampering, untracked source changes, provider MCP adapters, cancellation, and shared Temporal settings. Agent-readiness fixtures exercise JS/TS generation, reviewed guidance, owner/crawler preservation, asset locations, and form-feedback checks. Run `npm run verify:browser-state` separately for a real-Chrome same-tab/cookie/navigation regression. The CI matrix runs Node 20/22 on Linux, macOS, and Windows; configuration is not evidence that those jobs have passed. Publishing runs the complete suite before packing.

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
