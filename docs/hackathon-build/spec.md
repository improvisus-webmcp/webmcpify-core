# Technical specification

## Packaging

Add an isolated Node 22 package under `hackathon/strands-core-agent`. It depends on `@strands-agents/sdk`, `@modelcontextprotocol/sdk`, and the local Core workspace package, keeping the published Core runtime lightweight and Node 20 compatible.

## Agent

Create a one-shot CLI that accepts `--path`, `--url`, optional `--provider`, and an optional natural-language request. It starts Core's stdio MCP server in the target repository, gives its tools to a Strands `Agent`, and invokes a narrow system prompt.

## Core MCP additions

Add `review_webmcp`, which opens the existing trusted local review UI and resolves only after the person approves or rejects. Return the patch identifier and approval evidence. Existing `apply_webmcp` continues to reject stale or unapproved patches.

## Verification

- Core MCP contract test covers the new tool.
- Agent package tests cover argument parsing, prompt construction, workflow guardrails, and a mocked Strands/MCP invocation without cloud credentials.
- Root typecheck and complete Core test suite remain green.

