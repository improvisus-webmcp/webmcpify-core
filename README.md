# WebMCPify Core

Create, review, test, and verify [WebMCP](https://webmachinelearning.github.io/webmcp/) capabilities for new and existing web applications.

Core inspects what a site already does, asks a coding agent to draft grounded WebMCP tools in an isolated copy, and shows the exact proposal for human approval. Only an approved patch can reach the target repository. The result is tested in a real browser and checked independently of the agent's claim.

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

Core detects an installed provider when `--provider` is omitted. Set `WEBMCPIFY_PROVIDER` when you want a fixed default.

Browser-agent testing uses Chrome DevTools MCP. Core writes or safely merges a project-local configuration and starts its pinned package with `npx`; a separate global installation is not required. The first use needs registry access unless that package is already cached.

## Fastest path

Start the target application, then run Core from that project's directory:

```bash
webmcpify run --url http://localhost:3000
```

Or select a provider explicitly:

```bash
webmcpify run --url http://localhost:3000 --provider codex
```

`run` performs the normal workflow:

1. Discover the target's routes, forms, handlers, APIs, state, authentication signals, and existing WebMCP tools.
2. Draft tools and browser-verifiable tasks in a disposable workspace.
3. Audit each tool's declared user/agent binding, backend authorization, origin scope, quota, replay protection, and input bounds.
4. Open a local review URL and wait for the owner to approve or reject the exact tools, tasks, security findings, and patch.
5. Apply an approved patch and run the target's available typecheck and build scripts.
6. Reuse an available CDP browser or start an isolated headless Chrome session.
7. Exercise approved WebMCP tools and independently verify the resulting page state.

Use `--path /path/to/project` when running outside the target directory. The URL defaults to `http://localhost:3000`.

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
- State-changing proposals with blocking Core access-control gaps cannot reach approval.
- Verification reads the resulting application state instead of trusting the agent's report.
- Run evidence stays in the target project's ignored `.webmcpify/` directory.

Core reduces risk; it does not guarantee that generated code or WebMCP tools are safe. Review every proposal before approval.

## Commands

| Command | Purpose |
| --- | --- |
| `webmcpify run` | Normal end-to-end workflow; start here. |
| `webmcpify discover` | Inspect the target and write `.webmcpify/discovery.json`. |
| `webmcpify generate` | Draft tools, tasks, and a pending source patch. |
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

Core requires generated tools to describe an internal security contract. This is review evidence, not a WebMCP field. It covers user authentication, verified-agent requirements, backend authorization, exact origin scope, per-tool quotas, and idempotency. Core blocks state-changing proposals that rely on client-only authorization and blocks consequential proposals missing user/agent binding, quotas, or replay protection.

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
webmcpify final-eval --url http://localhost:3000 --provider codex
```

The CLI starts a workflow, the Temporal service keeps its state, and `webmcpify-worker` executes Core's test, repair, review, and apply activities. Human approval remains mandatory. Set `WEBMCPIFY_DURABLE=true` only if ordinary `webmcpify repair` calls should use Temporal by default.

## Configuration

No `.env` file or executable path is required when the provider CLI and Chrome are already on `PATH`. Run inside the target project, or use `--path`; there is no target-path environment variable. Core does not load the target application's `.env`. Set optional overrides in the shell that starts Core:

```bash
WEBMCPIFY_PROVIDER=codex
WEBMCPIFY_URL=http://localhost:3000
WEBMCPIFY_CHROME_BIN=/path/to/chrome
WEBMCPIFY_CDP_URL=http://127.0.0.1:9222
```

Provider executable overrides are available as `WEBMCPIFY_CODEX_BIN`, `WEBMCPIFY_CLAUDE_BIN`, `WEBMCPIFY_GEMINI_BIN`, `WEBMCPIFY_OPENCODE_BIN`, and `WEBMCPIFY_ANTIGRAVITY_BIN`.

## Project artifacts

Core writes local state under `<target>/.webmcpify/`, including discovery, proposed tools, `security-report.json`, the pending patch, approvals, evaluations, rollback data, and timestamped evidence. Keep this directory out of source control. Core does not require GitHub access and does not upload the target repository.

## Development

```bash
git clone https://github.com/improvisus-webmcp/webmcpify-core.git
cd webmcpify-core
pnpm install
pnpm typecheck
pnpm test
npm pack --dry-run
```

`npm test` runs the focused discovery, proposal, security, review, patch, repair, evaluation, final-evaluation, and MCP checks. Publishing runs type checking and the complete test suite before npm creates the package.

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
