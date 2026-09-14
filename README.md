# WebMCPify

WebMCPify is a domain-agnostic CLI and local MCP workflow where a human and a coding agent discover, draft, review, apply, test, and evaluate [WebMCP](https://webmachinelearning.github.io/webmcp/) integrations. It supports newly created apps, existing apps without WebMCP, and apps that already expose WebMCP tools.

The core idea is simple:
WebMCPify is a domain-agnostic CLI and local MCP workflow where humans and coding agents work together to make web apps WebMCP-ready. It supports new apps, existing apps without WebMCP, and apps that already expose WebMCP tools.

```text
new or existing web application
        ↓
     discover
        ↓
      generate
        ↓
 human review / approval
        ↓
       apply
        ↓
 isolated browser-agent test
        ↓
 independent verification
        ↓
      evaluation
        ↓
 repair / repeat
```

WebMCPify does not assume that an application is a particular type of product or that it is starting from zero. Instead, it inspects the target application's actual interactive surface: its forms, buttons, handlers, state stores, authentication signals, APIs, existing WebMCP integrations, and application structure. A human remains in control: the agent works in a disposable workspace, and source changes require explicit human review and approval before they can be applied.

Generated tools are therefore grounded in real application behaviour rather than being invented from a high-level description.

Generation, testing, repair, and apply use the official [WebMCP specification](https://webmachinelearning.github.io/webmcp/) and [Chrome WebMCP implementation guide](https://developer.chrome.com/docs/ai/webmcp) as references. WebMCPify follows the draft API's `ModelContext` registration model, structured schemas, executable callbacks, declarative form integration, cancellation, permissions, and security guidance; browser support is still checked rather than assumed.

The complete local implementation and security checklist is kept in [src/lib/webmcp-spec-guidance.ts](src/lib/webmcp-spec-guidance.ts). It is included in the generation and repair prompts and covers tool lifecycle, declarative and imperative tools, permissions, accessibility, prompt injection/tool poisoning, output injection, intent misrepresentation, privacy leakage, origin boundaries, and consequential actions.

For reproducible browser testing, start headless Google Chrome in a separate terminal with `pnpm chrome:headless http://localhost:5173`. The launcher enables WebMCP, remote CDP, and an isolated temporary profile; baseline, WebMCP tests, repair retests, and Temporal activities connect through `WEBMCPIFY_CDP_URL`.

## Quick start

The headless launcher enables the WebMCP and DevTools WebMCP features, remote CDP, and an isolated profile. It does not enable every experimental Chrome feature. WebMCP is experimental: in supported Chrome builds, enable chrome://flags/#enable-webmcp-testing and relaunch Chrome if WebMCP is unavailable. The generated Chrome DevTools MCP configuration enables --category-experimental-webmcp for WebMCP discovery and execution.

The URL examples below use http://localhost:5173 only as a local default. Set TARGET_URL to any reachable http:// or https:// URL, such as another local port, a LAN host, staging, or a public deployment, and use that same URL for Chrome, baseline, test, repair, and final-eval. For a remote target, skip the local app server terminal.

Install WebMCPify and prepare the target project:

```bash
git clone <WEBMCPIFY_REPOSITORY>
cd WebMCPify
pnpm install
pnpm build

cd /path/to/target-project
git init
git add -A
git commit -m "Initial target snapshot"
pnpm install
pnpm dev
```

For the complete browser and durable-evaluation workflow, use separate terminals:

```bash
cd /path/to/WebMCPify
pnpm chrome:headless http://localhost:5173
temporal server start-dev
pnpm temporal:worker
```

Then run the human-approved workflow:

```bash
cd /path/to/WebMCPify
pnpm webmcpify final-eval \
  --path /path/to/target-project \
  --url http://localhost:5173 \
  --provider codex
```

`final-eval` performs discovery, generation, human review, baseline testing, approved application, WebMCP testing, repair when approved, and durable Temporal evaluation.

Run the target app, headless Chrome, Temporal server, and Temporal worker in four separate terminals. The final-eval command runs from a fifth terminal in the WebMCPify checkout. Chrome only opens the app; it does not start the target app server.

### CLI commands

```bash
pnpm webmcpify --help
pnpm webmcpify --version

pnpm webmcpify init --path /path/to/target-project
pnpm webmcpify init --path /path/to/target-project --with-temporal
pnpm webmcpify discover --path /path/to/target-project
pnpm webmcpify generate --path /path/to/target-project --provider codex --method auto
pnpm webmcpify review --path /path/to/target-project --port 4173
pnpm webmcpify apply --path /path/to/target-project
pnpm webmcpify baseline --path /path/to/target-project --url http://localhost:5173 --provider codex
pnpm webmcpify test --path /path/to/target-project --url http://localhost:5173 --provider codex
pnpm webmcpify eval --path /path/to/target-project
pnpm webmcpify repair --path /path/to/target-project --provider codex
pnpm webmcpify repair --path /path/to/target-project \
  --url http://localhost:5173 --task task-1 --provider codex \
  --durable --max-repairs 3
pnpm webmcpify final-eval --path /path/to/target-project \
  --url http://localhost:5173 --provider codex --review-port 4173
```

Use `--durable` for Temporal-backed repair; it requires `--url` and `--task`. `final-eval` includes the Temporal evaluation stage.

Run the CLI commands below from the WebMCPify checkout. The next organization-scoped release will be published as `@improvisus/webmcpify-core`; that package is not available on npm yet.

## Hackathon demo homepage

The `demo/` folder is a separate Next.js project for the public WebMCP
Challenge URL. It explains WebMCPify and registers eight native WebMCP tools
with `document.modelContext`:

- `explain_webmcpify` — explain the product and human + coding-agent workflow;
- `show_workflow_step` — highlight Discover, Baseline, Generate, Review, Apply,
  WebMCP test, Repair, or Evaluate;
- `get_webmcpify_setup` — return project requirements and the end-to-end setup;
- `get_webmcpify_safety_model` — explain approvals, patches, isolation, rollback,
  and independent evidence;
- `get_webmcpify_cli_commands` — return the complete CLI command set;
- `get_webmcpify_terminal_setup` — explain the target, Chrome, Temporal, worker,
  and evaluation terminals;
- `get_webmcpify_mcp_setup` — return MCP installation, tools, workspace boundary,
  and approval flow; and
- `get_webmcpify_npm_setup` — explain installation and use of the published npm
  package.

The homepage provides `open_webmcpify_playground` and
`open_webmcpify_privacy`; the playground provides
`return_to_webmcpify_home` and `open_webmcpify_privacy`; and the privacy page
provides `open_webmcpify_playground`. Tools are page-scoped: after navigation,
the agent should discover the new document's tools again; it does not receive
both pages' tools as one combined list. On the playground, a consequential
tool returns `approvalRequired` and displays a human approval request. The
human must approve in the page before the agent can retry the action.

It also includes a `/playground` route for trying page-scoped WebMCP tools with
React state and the same-origin `/api/playground` backend. The playground
exposes `get_playground_state`, `call_playground_api`,
`request_playground_change`, `get_webmcp_security_notes`, and
`inspect_registered_tools`. The last tool uses the native `getTools()` API;
the page also listens for `toolchange` events and refreshes its inventory.
The playground also exposes `create_demo_payment` and
`confirm_demo_payment`: a validated, local-only payment simulation that never
accepts card data or moves money. Confirmation is blocked until a human
approves it in the page.
API operations
are allowlisted and validated; state changes stop at an explicit human
approval checkpoint, and instruction-like input is treated as untrusted data.

The `/privacy` route is a third page-scoped example. Its tools are
`get_privacy_status`, `export_demo_privacy_data`, `request_analytics_consent`,
and `open_privacy_playground`. They demonstrate data minimization, redacted
export, session-only consent, and human approval without collecting personal
data or contacting an analytics or payment provider. Navigation between Home,
Playground, and Privacy replaces the available tool set; agents should call
`getTools()` again after each navigation.

Run it locally:

```bash
cd demo
pnpm install
pnpm dev
```

Build for deployment:

```bash
cd demo
pnpm build
```

The demo uses a standard Next.js server because the playground API needs a
backend route. Deploy the `demo/` project to Vercel or another Next.js host;
the public homepage and `/playground` route will be available together.

Temporal is required for `final-eval` and durable repair. The plain discovery, generation, review, apply, and browser-test commands can run without Temporal.

## MCP adapter for coding agents

WebMCPify includes a thin local MCP server. It uses the same discovery, generation, approval, apply, and browser-test functions as the CLI; it does not upload the repository or require GitHub OAuth. Start it from the target repository so the server's workspace boundary is that repository:

The npm command below applies after the first `@improvisus/webmcpify-core` release. Until then, use the local checkout command in the following paragraph.

```bash
cd /path/to/target-site
npx --package @improvisus/webmcpify-core webmcpify-mcp
new or existing app → discover → generate → human review → apply → test → independently evaluate
```

For a local checkout, use `node /path/to/WebMCPify/dist/mcp/server.js` after `pnpm build`. Configure the coding agent's MCP settings with a stdio server, for example:
The agent discovers real application behaviour and drafts an integration in a disposable workspace. The human reviews and explicitly approves the tools, tasks, and source patch before anything changes the target checkout.

```json
{
  "mcpServers": {
    "webmcpify": {
      "command": "npx",
      "args": ["--package", "@improvisus/webmcpify-core", "webmcpify-mcp"],
      "cwd": "/path/to/target-site"
    }
  }
}
```

The server exposes `analyze_repository`, `generate_webmcp`, `apply_webmcp`, and `test_webmcp`. Generation returns a `patchIdentifier` and leaves the existing pending patch awaiting the normal human review checkpoint. `apply_webmcp` requires that identifier and the existing approval manifest. `test_webmcp` accepts an optional running-site `url`, otherwise it uses `WEBMCPIFY_URL` or `http://localhost:3000`. Paths outside the server's starting workspace are rejected.

After publishing, install the npm package with `npm install --global @improvisus/webmcpify-core`; it provides the `webmcpify` CLI and `webmcpify-mcp` MCP command. For a new release, run `npm run release` (build, bump the patch version, and publish). For local development, use the built `dist/mcp/server.js` path shown above.
## What WebMCPify does

---

## 1. What WebMCPify Does

WebMCPify separates the WebMCP integration workflow into explicit stages.

### Discovery

The discovery phase identifies:

* language and framework
* framework versions
* package manager
* routes and site structure
* sitemap and robots information when available
* forms and inputs
* buttons and event handlers
* API/server handlers
* authentication signals
* state-management sources
* existing WebMCP integrations
* relevant source files

Discovery is intentionally focused. It does not require the coding agent to read the entire repository file-by-file.
Discovery performs a focused source scan and records the language, framework, package manager, routes, sitemap, robots signals, forms, buttons, handlers, APIs, authentication, state, existing WebMCP registrations, relevant files, and inferred capabilities.

The result is saved as:
Output:

```text
target-site/.webmcpify/discovery.json
<target>/.webmcpify/discovery.json
```

---

### Generation

The generation agent uses the discovery result as its source of truth.

It proposes:
Generation uses the discovery result and an AI provider to draft WebMCP integrations grounded in real application capabilities. It supports declarative form integrations and imperative `document.modelContext` registrations, with current titles, annotations, strict schemas, handlers, placement guidance, and 5–6 browser-verifiable tasks. Results are plain serializable values, not MCP content envelopes.

* WebMCP tool definitions
* parameters and validation
* implementation handlers
* state sources
* declarative or imperative placement
* source changes
* 5–6 realistic verification tasks

The generated tools must correspond to discovered application capabilities.

Generation is draft-only.

It does not automatically modify the target application's source.
Generation is draft-only. The provider works in a disposable workspace and does not edit the target checkout. It produces:

Generated artifacts include:

```text
target-site/.webmcpify/proposed-tools.json
target-site/.webmcpify/pending-diff.patch
target-site/.webmcpify/trajectories/generate-*.json
target-site/.webmcpify/trajectories/generate-*.meta.json
<target>/.webmcpify/proposed-tools.json
<target>/.webmcpify/pending-diff.patch
<target>/.webmcpify/trajectories/generate-*.json
```

### Git prerequisite for the full workflow

The target application must be a Git repository with at least one commit for
the complete WebMCPify workflow. WebMCPify uses Git to capture and validate
generated patches, record the target source state, apply only an approved
patch, detect changes made after review, and roll back a failed application.

Discovery, baseline inspection, and browser checks can run without Git, but
the patch-based `generate`, `review`, `apply`, repair, and `final-eval` flow
cannot complete without it. The agent never edits the target repository
directly: it works in a separate disposable workspace, and the target is
modified only by the explicit approved `apply` stage.

To prepare a non-Git target project:

```bash
cd /path/to/target-site
git init
git add -A
git commit -m "Initial target snapshot"
```

---

### Human Review

The review stage provides a local browser interface where the human reviewer can inspect:
For an app that already has WebMCP, discovery exposes `existingWebMCP` signals so generation can extend the existing integration rather than assume a blank project.

* proposed tools
* tool parameters
* implementation locations
* verification tasks
* verification expressions
* generated source patch
### Human review and approval

The reviewer must explicitly approve the draft.
The local review UI shows the proposed tools, parameters, implementation locations, verification tasks, verification expressions, and exact source diff. The human must explicitly approve or reject the draft.

Approval creates:

```text
target-site/.webmcpify/approved-tools.json
target-site/tasks.json
```

The source patch is still separate from approval.

Approval does **not** mean that generated source changes have already been deployed.

The reviewer should only approve a patch and verification task after inspecting it.

---

### Apply

The `apply` stage applies the exact source patch that was approved.

Before applying, WebMCPify validates:

* approval state
* source fingerprint
* patch identity
* Git state

It then applies the approved patch and runs available project verification such as:

* TypeScript/type checking
* build
* other project-defined verification scripts

If application or build verification fails, WebMCPify can restore the affected source files.

---

### Test

Testing uses an isolated browser agent.

The testing agent is intentionally source-blind.

It should interact with the live application through:

* browser interaction
* Chrome DevTools MCP
* WebMCP tools exposed by the application

It should not inspect the target application's source files.

The agent receives the approved task list and attempts every task.

The agent's own statement that a task succeeded is **not** considered evidence.

---

### Independent Evaluation

After the agent finishes, WebMCPify evaluates every task's `verify` expression against the live application.

For example:

```javascript
(() => {
  try {
    const data = JSON.parse(
      localStorage.getItem('webmcp-coffee-store') || '{}'
    );

    return data?.state?.cart?.['ethiopia-guji'] === 2;
  } catch {
    return false;
  }
})()
<target>/.webmcpify/approved-tools.json
<target>/tasks.json
```

The evaluator therefore asks:

> Did the application actually reach the expected state?

rather than:

> Did the agent say it succeeded?

---

# 2. Reference Application

The primary reference application used during development and testing is:

* [jillesme/webmcp-coffee-store](https://github.com/jillesme/webmcp-coffee-store)

The application is a small React/Vite coffee store with:

* product catalog
* Zustand state
* shopping cart
* authentication state
* checkout
* roast filtering
* existing WebMCP integration signals

It is intentionally small enough to make the resulting WebMCP behaviour observable while still containing meaningful application state and conditional behaviour.

---

# 3. Dependencies

## Required

* Node.js
* pnpm
* Git (required for generation, review, apply, and patch-based workflows)
* Chrome/Chromium
* a supported coding-agent CLI
* Chrome DevTools MCP for browser-agent testing

Supported coding-agent providers:

* Gemini
* Claude Code
* Codex
* Antigravity (`agy`)
* OpenCode (`opencode`)

The tested coding agents for this implementation were **Antigravity (AGY)** and
**Codex**, both run on Linux.

---

## Optional

Temporal is required for the durable repair path and for the final Temporal evaluation performed by `final-eval`.

The Temporal implementation uses:

* Temporal CLI
* `@temporalio/client`
* `@temporalio/worker`
* `@temporalio/workflow`

Temporal is not required for:

* discovery
* generation
* human review
* apply
* baseline
* normal test
* normal evaluation
* plain repair

The `final-eval` command is the exception: it always attempts the final
Temporal evaluation and reports failure if the Temporal service or worker is
unavailable.

---

# 4. External Tools and Projects

WebMCPify uses or integrates with the following external projects.

## WebMCP

WebMCP is the browser API that allows web applications to expose tools to AI agents.

Repository/spec:

* [WebMCP](https://github.com/webmachinelearning/webmcp)

Specification:

* [WebMCP specification](https://webmachinelearning.github.io/webmcp/)

---

## Chrome DevTools MCP

Chrome DevTools MCP provides browser and Chrome DevTools capabilities to coding agents through MCP.

Repository:

* [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)

The official project provides an MCP server that can be configured with `npx` and supports connection to an existing Chrome instance through `--browser-url` or `--autoConnect`.

---
Approval does not apply source changes. It records permission for one exact patch and task set.

## use-webmcp-tool
### Apply and build verification

The reference application uses the React WebMCP helper:
Apply validates the approval manifest, patch identifier, Git source fingerprint, patch paths, and current working tree before applying. It runs available `typecheck` and `build` scripts. If applying or building fails, the affected files are restored.

* [GoogleChromeLabs/use-webmcp-tool](https://github.com/GoogleChromeLabs/use-webmcp-tool)
### Browser testing

This provides a React hook for lifecycle-managed WebMCP tool registration.
Testing uses an isolated, source-blind browser agent. The agent interacts with the running app through Chrome DevTools MCP and the human-approved WebMCP tools. It receives the approved task list and must execute each task; an agent’s claim of success is not evidence.

---
### Independent evaluation

## Temporal
After each task, WebMCPify evaluates its `verify` expression against the live application state. This independently checks whether the expected effect actually occurred instead of trusting the agent’s report. Evaluation results and raw trajectories are saved as project-scoped artifacts.

Temporal is used for the optional durable repair workflow.

Repositories:

* [Temporal](https://github.com/temporalio/temporal)
* [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)
* [Temporal TypeScript samples](https://github.com/temporalio/samples-typescript)

The TypeScript SDK provides the client, workflow, worker, and activity APIs used by the durable repair implementation.
## Human + agent workflow

---

## Reference Coffee Store
1. The agent analyzes the local project.
2. The agent drafts WebMCP changes in a disposable workspace.
3. The human reviews the tools, tasks, and exact diff.
4. The human explicitly approves or rejects the proposal.
5. WebMCPify applies only the approved, unchanged patch.
6. The agent runs the browser test and the independent evaluator records evidence.

* [jillesme/webmcp-coffee-store](https://github.com/jillesme/webmcp-coffee-store)
This is an evidence-driven approval pipeline, not a black-box “AI modifies website” system.

This is the main reference/test application used by the project.
## Installation

---
Requirements for the normal workflow:

# 5. Installation
- Node.js 18+
- pnpm (npm can run the published package)
- Git for generation, review, and apply
- Chrome/Chromium with WebMCP enabled for browser testing
- A configured provider for generation/testing
- Chrome DevTools MCP for browser-agent testing

Clone WebMCPify and install its dependencies:
Install from source:

```bash
git clone <WEBMCPIFY_REPOSITORY>
cd WebMCPify

pnpm install
pnpm build
```

The CLI is then available through:
The full patch workflow requires the target project to have at least one Git commit:

```bash
node dist/cli.js
cd /path/to/target-site
git init
git add -A
git commit -m "Initial target snapshot"
```

During local development, the equivalent `pnpm webmcpify ...` commands can be used.

---

# 6. Antigravity Setup
Discovery can run without Git. The complete patch workflow requires Git, and
Temporal must be running for `final-eval` and durable repair.

The primary end-to-end testing environment for this submission is Antigravity.

The provider is never given the target checkout as its working directory.
Generation, baseline, and browser-agent evaluation run from a disposable copy
or an empty disposable workspace. Repair may edit only its disposable copy to
produce a candidate diff. The target project is modified exclusively by
WebMCPify's explicit human-review and `apply` stages.
## CLI usage

Before running the browser-agent tests, Chrome DevTools MCP must be available to Antigravity.

Browser-only baseline and test sessions use a 5-minute provider timeout by
default because independent live-page scoring continues if the agent stalls.
AGY reasoning effort is not forced because support depends on the selected
model. Generation and repair retain the 15-minute timeout. Override these
defaults when needed:

```bash
WEBMCPIFY_ANTIGRAVITY_BASELINE_TIMEOUT=10m \
WEBMCPIFY_ANTIGRAVITY_TEST_TIMEOUT=10m \
WEBMCPIFY_ANTIGRAVITY_EFFORT=medium \
pnpm webmcpify final-eval --path ./target-site --url http://localhost:5173 --provider antigravity
```

## 6.1 Install Chrome DevTools MCP

Chrome DevTools MCP can be run through `npx`:

```bash
npx -y chrome-devtools-mcp@latest
pnpm webmcpify discover --path /path/to/target-site
pnpm webmcpify generate --path /path/to/target-site --provider gemini
pnpm webmcpify review --path /path/to/target-site
pnpm webmcpify apply --path /path/to/target-site
pnpm webmcpify test --path /path/to/target-site --url http://localhost:3000
pnpm webmcpify eval --path /path/to/target-site
```

The official project documents this as the standard MCP server installation command.

You do not normally need to globally install the package.

---

## 6.2 Start Chrome for the evaluation

For WebMCP testing, start a dedicated Chrome instance with remote debugging enabled.

Example:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --enable-features=WebMCP \
  --user-data-dir=/tmp/webmcpify-chrome \
  http://localhost:5173
```
The review command starts the local approval page. The target app must be running before `test`.

Using a separate user-data directory is recommended so that the evaluation browser is isolated from the normal Chrome profile.
## MCP adapter for coding agents

Verify that Chrome is listening:
WebMCPify includes a thin local MCP server. It uses the same discovery, generation, approval, apply, and browser-test functions as the CLI; it does not upload the repository or require GitHub OAuth. Start it from the target repository so the server's workspace boundary is that repository:

```bash
curl http://127.0.0.1:9222/json/version
cd /path/to/target-site
npx --package @improvisus/webmcpify-core webmcpify-mcp
```

A successful response should contain Chrome/DevTools information.

---

# 7. Add Chrome DevTools MCP to Antigravity

Open the Antigravity MCP configuration.

Add:
For a local checkout, use `node /path/to/WebMCPify/dist/mcp/server.js` after `pnpm build`. Configure the coding agent's MCP settings with a stdio server:

```json
{
  "mcpServers": {
    "chrome-devtools": {
    "webmcpify": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browser-url=http://127.0.0.1:9222"
      ]
      "args": ["--package", "@improvisus/webmcpify-core", "webmcpify-mcp"],
      "cwd": "/path/to/target-site"
    }
  }
}
```

The Chrome DevTools MCP project documents this `--browser-url` pattern for connecting Antigravity to a Chrome instance running on port 9222.

Save the configuration and restart/reload Antigravity if required.

---

# 8. Verify MCP in Antigravity

Inside Antigravity run:

```text
/mcp
```

The Chrome DevTools MCP server should appear as connected.

The important expected result is that Antigravity can see the `chrome-devtools` MCP server and its browser tools.

If it does not appear:

1. verify Chrome is running;
2. verify port 9222 is reachable;
3. verify the MCP configuration is valid;
4. verify `npx -y chrome-devtools-mcp@latest` runs successfully;
5. reload/restart Antigravity;
6. run `/mcp` again.

Chrome DevTools MCP also recommends running the server directly with:

```bash
npx chrome-devtools-mcp@latest --help
```

when troubleshooting installation or startup issues.

---

# 9. Test Projects

All WebMCPify evaluation projects should live together under one test directory.

Recommended layout:

```text
~/Desktop/WebMCPify-tests/
├── project-1/
├── project-2/
└── project-3/
```

Each project should be independently runnable.

For the reference submission, the projects used for testing should remain together so that the evaluator can reproduce the experiments without searching across unrelated directories.

Each project should contain its own:

```text
.webmcpify/
tasks.json
package.json
```

when applicable.

Do not merge the applications into WebMCPify itself.

WebMCPify is the evaluation/orchestration project; the applications are separate target projects.

---

# 10. Packaging the Test Projects

After preparing the three test projects, package them together:

```bash
cd ~/Desktop

zip -r WebMCPify-test-projects.zip WebMCPify-tests/
```

The resulting archive should contain:

```text
WebMCPify-tests/
├── project-1/
├── project-2/
└── project-3/
```

The archive is intended to make the target applications reproducible without modifying the WebMCPify source repository.

---

# 11. Project-Local Tasks

Tasks belong to the target application.

They are not hard-coded globally into WebMCPify.

Generation proposes 5–6 realistic tasks based on the application's discovered capabilities.

Every task must contain:

```json
{
  "id": "stable-task-id",
  "description": "What the agent should do",
  "verify": "JavaScript expression returning true or false"
}
```

The verifier must be based on observable application state.

Acceptable evidence includes:

* persisted localStorage state
* DOM state
* application state exposed to the page
* WebMCP tool availability
* other observable effects

Do not use an agent's textual response as the verification source.

---

# 12. The `tasks.json` Contract

The final evaluation requires the approved task set.

The target project must contain:

```text
tasks.json
```

with **5–6 approved tasks**.

A task list containing zero tasks is invalid.

The approval flow must therefore guarantee that the approved task definitions are persisted before the final evaluation begins.

Expected example:

```text
[final-eval] fixed approved task set: <run-id> (6 tasks)
```

If the approval page shows the tasks but `tasks.json` is empty or missing, do not continue to evaluation.

Fix the approval persistence problem first.

---

# 13. Human Approval

The approval interface is intentionally a hard gate.

The workflow is:

```text
generate
   ↓
approval page
   ↓
inspect tools
   ↓
inspect tasks
   ↓
inspect verify expressions
   ↓
inspect source patch
   ↓
approve
   ↓
persist manifest + tasks.json
```

The reviewer should not need to repeatedly approve the same draft.

The intended interaction is:

1. Open the review page.
2. Inspect the draft.
3. Click the approval control.
4. The first click enters/activates the approval action if the UI requires confirmation.
5. The second click confirms approval.
6. After approval succeeds, the review becomes closed/read-only.
7. Further clicks must not re-apply or re-approve the same draft.

The approval endpoint must be idempotent.

Closing the browser after approval must not cause the CLI to remain indefinitely waiting for another approval.

The CLI should continue once the approved manifest and `tasks.json` have been written.

---

# 14. Generate

Run:

```bash
node dist/cli.js discover \
  --path ./target-site
```

Then:

```bash
node dist/cli.js generate \
  --path ./target-site \
  --method auto \
  --provider antigravity
```

Generation should produce:

```text
target-site/.webmcpify/discovery.json
target-site/.webmcpify/proposed-tools.json
target-site/.webmcpify/pending-diff.patch
```

and a generation trajectory.

Generation should not directly edit the target source.

---

# 15. Review

Run:

```bash
node dist/cli.js review \
  --path ./target-site
```

Open the URL printed by the CLI.

The reviewer should inspect:

* all proposed tools
* tool parameters
* handler/state mappings
* source placement
* verification tasks
* verify expressions
* exact source patch

Then approve the draft.

After approval verify:

```bash
test -f ./target-site/tasks.json
test -f ./target-site/.webmcpify/approved-tools.json
```

Then inspect the task count:

```bash
node -e "
const tasks = require('./target-site/tasks.json');
console.log('tasks:', Array.isArray(tasks) ? tasks.length : 0);
"
```

The expected result is:

```text
tasks: 5
```

or:

```text
tasks: 6
```

---

# 16. Apply

Only after approval:

```bash
node dist/cli.js apply \
  --path ./target-site
```

The apply stage validates the approval and applies the approved patch.

After applying, rebuild the target:

```bash
pnpm build
```

or use the target project's appropriate build command.

---

# 17. Run the Target Application

Start the target application.

For the coffee store:

```bash
pnpm dev
```

Then open:

```text
http://localhost:5173
```

The actual URL may differ for another target project.

---

# 18. Test with Antigravity

Start the target application first.

Start Chrome with WebMCP and remote debugging enabled.

Ensure Chrome DevTools MCP appears in:

```text
/mcp
```

Then run:

```bash
node dist/cli.js test \
  --path ./target-site \
  --url http://localhost:5173 \
  --provider antigravity
```

The test agent receives only the approved task set and browser/MCP access.

It should not read or modify the target application's source.

The raw trajectory is stored as:

```text
trajectories/test-*.json
```

The independent task evaluation is stored separately.

---

# 19. Evaluation

After the test session:

```bash
node dist/cli.js eval
```

The evaluator checks the saved task definitions against the live application.

A successful task requires its `verify` expression to return:

```text
true
```

The agent's textual claim is not enough.

---

# 20. Example Coffee Store Tasks

The reference coffee-store evaluation contains tasks such as:

### Add coffee

```text
Add 2 bags of Guji Shakiso to the shopping cart.
```
The server exposes:

Verification:
- `analyze_repository` — return stack, routes, UI actions, APIs, state, capabilities, files, and existing WebMCP signals.
- `generate_webmcp` — draft or extend registrations through the existing provider pipeline and return a `patchIdentifier`.
- `apply_webmcp` — apply that identifier’s explicitly approved patch and run the existing build check.
- `test_webmcp` — run the existing isolated browser test and independent evaluation.

```javascript
(() => {
  try {
    const data = JSON.parse(
      localStorage.getItem('webmcp-coffee-store') || '{}'
    );

    return data?.state?.cart?.['ethiopia-guji'] === 2;
  } catch {
    return false;
  }
})()
```

### Update quantity

```text
Update the quantity of Guji Shakiso to 4 bags.
```
Generation remains draft-only. The human must still approve the exact patch through:

### Remove coffee

```text
Remove Guji Shakiso from the cart.
```

### Login

```text
Log into the store demo account.
```

### Checkout

```text
Checkout the order while logged in.
```

### Conditional tool availability

```text
Verify that checkout is only registered when the user is logged in.
```

The conditional task checks the live WebMCP tool registry rather than relying only on source inspection.

---

# 21. Baseline

The baseline is the comparison condition.

Run:

```bash
node dist/cli.js baseline \
  --path ./target-site \
  --url http://localhost:5173 \
  --provider antigravity
webmcpify review --path /path/to/target-site
```

The baseline agent has source-editing access.

This is intentionally different from the isolated test agent.

The baseline measures what an agent can accomplish when it is allowed to inspect and modify the application.

The isolated test measures what the agent can accomplish through the browser and approved WebMCP tools.
`test_webmcp` accepts an optional URL; otherwise it uses `WEBMCPIFY_URL` or `http://localhost:3000`. Paths outside the server’s starting workspace are rejected.

---
## npm package

# 22. Repair

Plain repair:
After publishing:

```bash
node dist/cli.js repair \
  --path ./target-site \
  --provider antigravity
```

Repair uses independent test failures to identify the failed tasks and generate a focused repair.

Repair has source-editing access because its purpose is to correct the implementation.

After repair:

```bash
node dist/cli.js test \
  --path ./target-site \
  --url http://localhost:5173 \
  --provider antigravity

node dist/cli.js eval
```

The important evidence is the independent score after the repair, not the repair agent's statement that it fixed the problem.

---

# 23. Optional Temporal Repair

Temporal is used only for durable repair orchestration.

Initialize:

```bash
node dist/cli.js init \
  --path ./target-site
```

Or enable Temporal:

```bash
node dist/cli.js init \
  --path ./target-site \
  --with-temporal
```

Start Temporal:

```bash
temporal server start-dev
```

Start the WebMCPify Temporal worker:

```bash
node dist/temporal/worker.js
```

Then:

```bash
node dist/cli.js repair \
  --path ./target-site \
  --url http://localhost:5173 \
  --task "task-1" \
  --provider antigravity \
  --durable \
  --max-repairs 3
```

The durable workflow preserves retry state and human-gate state.

The current durable implementation intentionally keeps source-diff application as a separate boundary.

---

# 24. Trajectories

Every important agent execution should leave evidence.

Examples:

```text
trajectories/
├── generate-*.json
├── generate-*.meta.json
├── baseline-*.json
├── baseline-*.meta.json
├── test-*.json
├── test-*.meta.json
├── test-eval-*.json
├── repair-*.json
└── ...
```

The trajectory should preserve the raw provider output rather than replacing it with a summary.

Metadata should identify:

* provider
* model/agent
* prompt
* target project
* URL
* MCP configuration
* timing
* status
* relevant feedback

This allows the evaluation to be audited after the run.

---

# 25. Changelog

All meaningful milestones should be recorded in:

```text
CHANGELOG.md
```

Examples include:

* discovery implementation
* structured proposal validation
* human approval workflow
* task persistence
* patch generation
* patch application
* isolated testing
* independent evaluation
* repair
* Temporal integration
* approval UI fixes
* reproducibility fixes
* actual provider test results

Do not claim a provider was tested unless the run was actually completed.

For this submission, the README and changelog should explicitly distinguish:

```text
Antigravity — end-to-end tested
Claude Code — not completed end-to-end
Codex — end-to-end tested on Linux
npm install --global @improvisus/webmcpify-core
webmcpify discover --path /path/to/target-site
```

---
The package exposes the existing CLI as `webmcpify` and the MCP server as `webmcpify-mcp`. The MCP configuration above can use `npx --package @improvisus/webmcpify-core webmcpify-mcp`; local development uses the built server path.

# 26. Three-Project Test Matrix
## Browser-agent setup

The final reproducibility package should contain three target applications:

```text
WebMCPify-tests/
├── project-1/
├── project-2/
└── project-3/
```

For every project, record:

| Project   | Discovery | Generate | Review | Apply | Test | Eval | Provider    |
| --------- | --------: | -------: | -----: | ----: | ---: | ---: | ----------- |
| Project 1 |         ✓ |        ✓ |      ✓ |     ✓ |    ✓ |    ✓ | Antigravity |
| Project 2 |         ✓ |        ✓ |      ✓ |     ✓ |    ✓ |    ✓ | Antigravity |
| Project 3 |         ✓ |        ✓ |      ✓ |     ✓ |    ✓ |    ✓ | Antigravity |

Only mark a cell `✓` after the corresponding stage has actually been completed.

If a stage was not completed, record:

```text
Not run
```

rather than inferring a result.
Chrome DevTools MCP is used for isolated browser sessions:

---

# 27. Full Reproduction Sequence

A clean reproduction should follow this order.

## Step 1 — Install WebMCPify

```bash
pnpm install
pnpm build
```

## Step 2 — Install/verify Chrome DevTools MCP

```bash
npx -y chrome-devtools-mcp@latest
```

## Step 3 — Configure Antigravity MCP

Add:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--browser-url=http://127.0.0.1:9222"
      ]
    }
  }
}
```

## Step 4 — Verify Antigravity

Run:

```text
/mcp
```

Confirm `chrome-devtools` is connected.

## Step 5 — Start Chrome

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --enable-features=WebMCP \
  --user-data-dir=/tmp/webmcpify-chrome
```

## Step 6 — Start the target application

```bash
pnpm dev
```

## Step 7 — Discover

```bash
node dist/cli.js discover \
  --path ./target-site
```

## Step 8 — Generate

```bash
node dist/cli.js generate \
  --path ./target-site \
  --method auto \
  --provider antigravity
```

## Step 9 — Review

```bash
node dist/cli.js review \
  --path ./target-site
```

Open the approval URL.

Inspect:

* tools
* tasks
* verification expressions
* source patch

Approve once the complete draft is correct.

## Step 10 — Confirm tasks

```bash
cat ./target-site/tasks.json
```

Confirm that there are 5–6 tasks.

## Step 11 — Apply

```bash
node dist/cli.js apply \
  --path ./target-site
```

## Step 12 — Restart/rebuild target

```bash
pnpm build
pnpm dev
```

## Step 13 — Test

```bash
node dist/cli.js test \
  --path ./target-site \
  --url http://localhost:5173 \
  --provider antigravity
```

## Step 14 — Evaluate

```bash
node dist/cli.js eval
```

## Step 15 — Preserve evidence

Keep:

```text
trajectories/
tasks.json
.webmcpify/
CHANGELOG.md
```

Do not delete successful or failed trajectories before final submission.

---

# 28. Final Verification Checklist

Before considering an evaluation complete, verify all of the following.

### WebMCPify
Start a dedicated Chrome profile with remote debugging and WebMCP enabled:

```bash
pnpm build
```

passes.

### Target application

The target application starts successfully.

### Discovery

```text
.webmcpify/discovery.json
```

exists.

### Generation

```text
.webmcpify/proposed-tools.json
.webmcpify/pending-diff.patch
```

exist.

### Approval

```text
.webmcpify/approved-tools.json
tasks.json
```

exist.

### Tasks

```text
tasks.json
```

contains 5–6 tasks.

Every task has:

* stable ID
* description
* observable verification expression

### Source

The approved patch matches the reviewed source changes.

### WebMCP

The expected tools appear in the running browser.

### MCP

Antigravity reports Chrome DevTools MCP through:

```text
/mcp
```

### Testing

The agent can interact with the application through the browser.

### Evaluation

The independent verifier evaluates the task effects.

### Evidence

Trajectories are preserved.

### Changelog

Actual implementation and testing milestones are recorded.

### Provider attribution

Only actually completed provider runs are reported as tested.

---

# 29. Known Evaluation Boundary

WebMCPify is intentionally divided into several trust boundaries.

```text
AI discovery
     ↓
AI proposal
     ↓
human approval
     ↓
source application
     ↓
browser agent
     ↓
independent verifier
```

The system does not treat the AI agent as the final authority on whether an application works.

The agent can propose a tool.

The human approves the proposal.

The browser executes it.

The verifier independently checks the result.

This separation is the central design principle of the project.

---

# 30. Current Testing Attribution

The reference end-to-end testing for this submission was performed on Linux
with:

```text
Antigravity (AGY)
Codex
Chrome
Chrome DevTools MCP
```

The workflow was exercised through both AGY and Codex with the required
browser-agent and MCP workflow.

Equivalent complete end-to-end runs with:

```text
Claude Code
```

was not completed for this submission.

Therefore this README does not claim cross-provider performance results.

The architecture remains provider-aware and supports:

```text
gemini
claude
codex
antigravity
opencode
```

but provider support and provider testing are separate claims.

---

# 31. Submission Package

The final submission should contain the WebMCPify source plus the reproducibility material.

Recommended structure:

```text
submission/
├── WebMCPify/
│   ├── src/
│   ├── scripts/
│   ├── trajectories/
│   ├── CHANGELOG.md
│   ├── README.md
│   ├── package.json
│   └── ...
│
├── WebMCPify-tests.zip
│
└── README.md
google-chrome \\
  --remote-debugging-port=9222 \\
  --enable-features=WebMCP \\
  --user-data-dir=/tmp/webmcpify-chrome \\
  http://localhost:3000
```

The test archive contains:

```text
WebMCPify-tests/
├── project-1/
├── project-2/
└── project-3/
```

The projects should be runnable independently.

---

# 32. Final Test Run Used for the Submission

The final test sequence should be executed only after all implementation and approval fixes are complete.

From the WebMCPify directory:

```bash
pnpm install
pnpm build
```

Start Chrome:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --enable-features=WebMCP \
  --user-data-dir=/tmp/webmcpify-chrome
```
Verify Chrome is reachable:

Verify CDP:

```bash
curl http://127.0.0.1:9222/json/version
```

Verify Chrome DevTools MCP:

```bash
npx -y chrome-devtools-mcp@latest --help
```

Verify Antigravity:
Configure Chrome DevTools MCP for an agent with `--browser-url=http://127.0.0.1:9222` or the project’s supported auto-connect option.

```text
/mcp
```
## Providers and optional Temporal workflow

Confirm:
Generation and browser-agent tasks can use the configured Gemini, Claude, Codex, Antigravity, or OpenCode provider. Provider availability and testing depend on the local environment.

```text
chrome-devtools
```
Temporal provides the optional durable repair workflow. The normal discovery, generation, review, apply, test, evaluation, and plain repair paths do not require a Temporal service.

is connected.
## Artifacts and evidence

Start the target project:
Project-scoped state is stored under `.webmcpify/`, including:

```bash
cd ~/Desktop/WebMCPify-tests/project-1
pnpm install
pnpm dev
```
- discovery output
- proposed tools
- pending patch and patch metadata
- approval manifest
- generation, browser-test, review, apply, repair, and evaluation trajectories

Then run the WebMCPify pipeline:
Keep target applications separate from this orchestration repository when reproducing multiple projects. Each target should be independently runnable and contain its own `.webmcpify/` state and `tasks.json` where applicable.

```bash
cd ~/Desktop/WebMCPify
## Verification

node dist/cli.js discover \
  --path ~/Desktop/WebMCPify-tests/project-1
Run the MCP adapter test:

node dist/cli.js generate \
  --path ~/Desktop/WebMCPify-tests/project-1 \
  --method auto \
  --provider antigravity

node dist/cli.js review \
  --path ~/Desktop/WebMCPify-tests/project-1
```

Inspect and approve the draft.

Immediately verify:

```bash
cat ~/Desktop/WebMCPify-tests/project-1/tasks.json
```

Confirm that the file contains exactly 5–6 approved tasks.

Then:

```bash
node dist/cli.js apply \
  --path ~/Desktop/WebMCPify-tests/project-1
```

Run the independent browser test:

```bash
node dist/cli.js test \
  --path ~/Desktop/WebMCPify-tests/project-1 \
  --url http://localhost:5173 \
  --provider antigravity
```

Finally:

```bash
node dist/cli.js eval
```

Repeat the same validated sequence for:

```text
project-2
project-3
```

Preserve every trajectory and evaluation artifact.

Finally package the projects:

```bash
cd ~/Desktop

zip -r WebMCPify-test-projects.zip WebMCPify-tests/
```

Then update:

```text
CHANGELOG.md
pnpm build
pnpm test
```

with the actual final results.

Do not add a result to the changelog until the corresponding test has actually been executed and independently scored.

---

# 33. Project Philosophy

WebMCPify is not intended to be a black-box "AI modifies website" system.

It is an evidence-driven integration pipeline.

The important properties are:

1. **Discover before proposing.**
2. **Ground tools in real application handlers and state.**
3. **Keep generation separate from source application.**
4. **Require human approval.**
5. **Persist the exact approved task set.**
6. **Give the browser agent only the capabilities it needs.**
7. **Verify application effects independently.**
8. **Preserve trajectories and evidence.**
9. **Record actual testing rather than assumed testing.**
10. **Make repairs repeatable and auditable.**

That separation is what allows WebMCPify to evaluate whether WebMCP integration actually works instead of merely evaluating whether an AI agent produced plausible code.

---

# 34. Hardened approval and final-evaluation lifecycle

The review page is an approval boundary, not a form that writes arbitrary
agent output. The first approval click validates the edited tools and tasks
and shows a confirmation summary. The second click persists the complete
manifest and task file, verifies their shared task fingerprint, and only then
marks the draft approved. Refreshing `/approve` for the same patch displays a
locked state. A new generation run moves the previous approval and task file
to `.webmcpify/stale/`, so artifacts from different runs cannot be reused.

The authoritative approved task set is the `tasks` array in
`.webmcpify/approved-tools.json`, cross-checked against `tasks.json` and its
`taskSetId`. Baseline, WebMCP test, repair retest, and Temporal evaluation all
load it through the same validation function. Generated tasks are never
invented from an old `tasks.json` during review.

The focused verification commands are:
Run the broader project verification scripts:

```bash
pnpm tsc --noEmit
pnpm build
pnpm run verify:discovery
pnpm run verify:tools
pnpm run verify:review
pnpm run verify:patch
pnpm run verify:evaluation
pnpm run verify:repair
pnpm run verify:final-eval
git diff --check
```

These fixtures cover malformed and duplicate proposals, the two-step approval
flow, task/tool persistence, missing approval, invalid patches, build failure
rollback, project-scoped evaluation selection, repair retesting, and final
evaluation task-set identity. Live provider/browser output is reported only
when a real target checkout and browser session are available.
## WebMCP Challenge submission

WebMCPify is the build and verification tool behind a demo; it is not the live submission by itself. The submission must include a deployed WebMCP-enabled app that judges can access in ChatGPT’s in-app browser or Chrome with WebMCP testing enabled.

Prepare:

- a working live URL;
- a public GitHub, GitLab, or Bitbucket repository;
- all source, assets, and setup instructions;
- an open-source `LICENSE` file;
- a public YouTube demo under three minutes with audio; and
- a description explaining WebMCP fit, user benefit, human/agent collaboration, and implementation.

# 35. End-to-End Testing
The challenge judges WebMCP leverage, execution, potential impact, and creativity. See the [official WebMCP Challenge page](https://webmcp.devpost.com/) for current rules and schedule.

For a real run, prepare a non-empty target checkout and start its application
first. Then use the single orchestration command:
## Reference projects

```bash
pnpm build
pnpm webmcpify final-eval --path ~/Desktop/webmcp-coffee-store
```
- [WebMCP specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [use-webmcp-tool](https://github.com/GoogleChromeLabs/use-webmcp-tool)
- [Reference coffee store](https://github.com/jillesme/webmcp-coffee-store)

The command runs the plain baseline, waits for human review of discovery,
structured tools, tasks, and the exact source patch, applies only an approved
patch, runs the WebMCP test, performs an approved repair/retest when failures
require it, and runs the same approved task set through the durable Temporal
workflow. It prints Level 1, Level 2, and Level 3 task scores and writes a
project-scoped `final-eval-*` trajectory.
## License

Before the command, verify Chrome DevTools MCP and the target browser are
available to Antigravity. The browser-agent path must remain source-blind;
the independent evaluator performs the actual verification. If the target,
provider, MCP server, Temporal service, or approval is unavailable, the run
must be reported as failed or incomplete; do not add placeholder scores.
MIT. See [LICENSE](LICENSE).
