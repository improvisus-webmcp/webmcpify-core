# WebMCPify Core Agent

A Strands-powered professional agent that prepares existing web applications for safe WebMCP use.

## What it does

The agent connects to WebMCPify Core's local MCP server and coordinates:

```text
Analyze → Draft → Audit → Human review → Apply → Browser test → Evidence
```

The review is not a chat confirmation. Core serves the exact tools, tests, security findings, and source patch on a local page. Only that page can persist approval; the agent can only read the resulting decision.

## Run

Requirements:

- Node.js 22+
- AWS credentials with access to an Amazon Bedrock model supported by Strands
- A supported Core coding provider such as Codex
- A target web application with dependencies installed and an initial Git commit
- A running target URL for browser verification

From the repository root:

```bash
pnpm install
pnpm agent -- --path /path/to/web-app --url http://localhost:3000 --provider codex
```

The terminal stays interactive across the approval boundary. Open the review URL printed by the agent, make the decision in the local UI, then type `continue`.

## Test without cloud credentials

```bash
pnpm --dir hackathon/strands-core-agent typecheck
pnpm --dir hackathon/strands-core-agent test
```

These checks validate argument handling, MCP tool exposure, workspace confinement, workflow ordering, and approval safeguards without invoking a hosted model.

## Current limitation

This agent protects work routed through Core. It does not claim to govern unrelated agents, browser sessions, or direct repository access outside the Core MCP boundary.

