# Four-minute demo script

## 0:00–0:25 — Problem

**Voiceover:** “Web developers can spend hours finding the right application actions, turning them into agent tools, reviewing generated code, and checking whether the result actually works. A coding agent can draft changes quickly—but it should not approve its own work.”

Show the target application and its repository without WebMCP tools.

## 0:25–0:45 — Product

**Voiceover:** “WebMCPify Core Agent is built with Strands Agents SDK. It coordinates a constrained Core MCP server and carries the workflow from developer intent to browser-verified evidence.”

Show:

```bash
pnpm agent -- --path ../target-app --url http://localhost:3000 --provider codex
```

## 0:45–1:30 — Discover and draft

Ask: “Prepare this application for safe agent use.”

Show the Strands agent calling:

- `core_analyze_repository`
- `core_generate_webmcp`

Briefly show the discovered routes/actions and proposed capability names.

## 1:30–2:05 — Security

Show `core_audit_webmcp_security` and highlight concrete checks: backend authorization, user/agent binding, origin scope, quotas, sensitive parameters, and replay protection.

**Voiceover:** “The model’s description is not treated as proof. Blocking access-control gaps stop the workflow before approval.”

## 2:05–2:45 — Human decision

Show `core_review_webmcp` returning the local review URL. Open it and show the tools, verification tasks, security report, and exact source patch.

Approve the exact patch manually.

**Voiceover:** “The agent can request review, but it cannot click this button or create an approval manifest.”

Return to the terminal and type `continue`.

## 2:45–3:30 — Apply and prove

Show:

- `core_get_webmcp_review_status`
- `core_apply_webmcp`
- the successful target build
- `core_test_webmcp`
- the real browser performing an approved action
- the independent verification result

## 3:30–4:00 — Close

Show the architecture diagram.

**Voiceover:** “Strands plans and coordinates. Core confines generation, preserves the human decision, and verifies the outcome. WebMCPify Core Agent removes repetitive integration work without asking developers to trust an agent’s claim.”

End card:

```text
WebMCPify Core Agent
Strands orchestrates · Humans approve · Browsers prove
github.com/improvisus-webmcp/webmcpify-core
```

