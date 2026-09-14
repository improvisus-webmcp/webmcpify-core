# WebMCPify Core Agent

## One-line Summary

A Strands agent that turns existing web applications into reviewed, secure, and browser-verified WebMCP capabilities.

## Problem

Web developers preparing applications for AI agents must identify real user actions, design grounded tool schemas, wire them into the correct pages, assess security boundaries, and prove the tools work. Doing that manually is repetitive and error-prone. Asking a coding agent to edit the repository directly creates another problem: its output can be plausible without being safe, approved, or functional.

## Solution

WebMCPify Core Agent handles that workflow end to end. A developer supplies a repository and running URL. A Strands agent coordinates WebMCPify Core through MCP to:

1. discover routes, forms, handlers, APIs, authentication signals, state, and existing WebMCP tools;
2. draft the smallest grounded capability set in a disposable workspace;
3. audit access-control, origin, quota, privacy, and replay-protection declarations;
4. surface the exact tools, tests, findings, and source patch for human review;
5. apply only the approved patch and run the target's build checks; and
6. exercise the approved tools in a real browser and verify observable outcomes.

The agent works in the background until a real decision is needed. It cannot approve its own proposal: approval is created in a separate local interface and is cryptographically bound to the exact patch and task set.

## Why This Matters

The web is moving from pages that agents interpret to capabilities they can call. Developers need a practical way to join that transition without granting a model unchecked access to source code, authenticated actions, or deployment paths. Core Agent reduces repetitive integration work while preserving explicit human control and independently checked evidence.

## How We Used AI

Strands Agents SDK owns the planning and tool-use loop. It connects to Core's confined stdio MCP server, chooses the next allowed workflow tool, maintains the conversation across the human-review boundary, and explains the resulting evidence.

Core separately invokes the developer's selected coding provider inside a disposable repository copy to draft grounded source changes. The draft is compile-checked before review. The Strands agent receives only normalized Core MCP tools and never receives unrestricted shell or repository-editing tools.

## How We Used Codex

Codex helped inspect the existing architecture, implement the Strands integration, strengthen the MCP review boundary, write focused tests, update documentation, generate the architecture asset, and run the full verification suite. Core can also use an authenticated Codex CLI as one supported coding provider when generating a WebMCP patch in its isolated workspace.

## Key Features

- Strands-powered interactive agent using native MCP integration.
- Repository and page-action discovery grounded in source code.
- Disposable generation workspace that keeps the target checkout unchanged.
- Static security checkpoint for identity, authorization, origin, quota, sensitive input, and replay controls.
- Trusted local review outside model control.
- Exact patch identifiers and approval manifests prevent stale or substituted application.
- Target build validation with rollback on failure.
- Chrome DevTools MCP and Playwright-based browser execution.
- Independent verification against observable application state.
- Focused repair and optional durable Temporal workflows.

## Architecture

```text
Developer intent
    → Strands Core Agent
    → confined Core MCP server
    → discover + disposable draft + security audit
    → trusted human review
    → exact approved patch + build
    → isolated browser test
    → independent evidence
```

Required upload: `docs/hackathon/webmcpify-core-agent-architecture.png`

## Testing Instructions

Automated verification does not require cloud credentials:

```bash
git clone https://github.com/improvisus-webmcp/webmcpify-core.git
cd webmcpify-core
pnpm install
pnpm typecheck
pnpm test
npm pack --dry-run
```

To run the real agent, use Node.js 22+, configure credentials for a Strands-supported model, authenticate one supported Core coding provider, start a target web application, and run:

```bash
pnpm agent -- --path /path/to/web-app --url http://localhost:3000 --provider codex
```

When the agent returns a local review URL, inspect and approve or reject the proposal there. Type `continue` in the agent terminal after making the decision.

## Public Demo Link

Product page: https://improvisus.tech/core

The agent itself is local-first and operates on a developer's repository and browser session.

## Public Repository Link

https://github.com/improvisus-webmcp/webmcpify-core

## Demo Video

TODO: Add the public YouTube URL. Maximum length: five minutes.

The recording plan is in `docs/hackathon/video-script.md`.

## Screenshot Shot List

1. Terminal showing the Strands agent and the Core MCP tool sequence.
2. Discovery and generated capability summary.
3. Security findings and trusted local review page.
4. Exact patch approval and successful build.
5. Real-browser verification with saved evidence.
6. Architecture diagram.

Suggested project cover: `docs/hackathon/webmcpify-core-agent-cover.png`.

## Submission Readiness Notes

- Track: **Professional Agents**.
- Submitter and Devpost author: Ridwan Abeeb.
- AWS Builder ID supplied by participant: `olumide@improvisus.tech`; alias `@olumide234234`.
- Repository history begins August 31, 2026, within the submission period.
- Strands agent source is under `hackathon/strands-core-agent`.
- Full Core and agent test suite passes locally.

## Known Limitations

- A real agent run requires credentials for an available Strands model and an authenticated Core coding provider.
- Browser verification requires a compatible Chrome/Chromium runtime and a running target application.
- Core reduces integration risk but cannot prove that every target backend enforces a declared security control.
- The local boundary protects actions routed through Core; it cannot govern unrelated agents or direct repository access.
- WebMCP and browser support remain experimental.

## Originality and Third-Party Disclosure

The submitted Core repository was started during the hackathon submission period. The Strands orchestration package was added specifically for this agent entry. The broader WebMCPify product concept and public website predate this agent integration. Third-party components include Strands Agents SDK, the Model Context Protocol SDK, Chrome DevTools MCP, Playwright, Express, Commander, and optional Temporal libraries under their respective licences.

## TODO Official Form Fields

- Submitter Type (`27729`): TODO — likely `Individual`; participant must confirm.
- Country of Residence (`27730`): TODO — participant must confirm.
- Track (`27732`): `Professional Agents`.
- Public repository (`27733`): `https://github.com/improvisus-webmcp/webmcpify-core`.
- Architecture upload (`27734`): `docs/hackathon/webmcpify-core-agent-architecture.png`.
- AWS Builder ID (`27735`): TODO — confirm whether Devpost expects `olumide@improvisus.tech` or `@olumide234234`.
- Live demo (`27736`, optional): `https://improvisus.tech/core` only if accepted as the product page; it is not the local agent runtime.
- Testing instructions (`28191`, optional): use the Testing Instructions section above.
- Bonus blog (`27737`, optional): TODO if published on builder.aws.com.
- Public demo video: TODO.
