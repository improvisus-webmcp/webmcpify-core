export { WEBMCP_SPEC_GUIDANCE, WEBMCP_SPEC_URL } from "./webmcp-spec-guidance.js";

export const DISCOVERY_GUIDANCE = `
DISCOVERY PHASE — complete this before drafting or changing any WebMCP tools.
Do not read the entire codebase file by file. Use these signals to narrow down
where the real interactive surface is.

1. Identify the stack cheaply. Read package.json, requirements.txt, go.mod,
Cargo.toml, or pom.xml to determine the language, framework, and versions.
Read the README for the stated purpose, feature list, and getting-started
sections. Use this to choose the idiomatic registration pattern and likely
source directories.

2. Map the site structure. If present, read sitemap.xml for the real page list
and robots.txt for paths explicitly disallowed to automated agents. If there
is no sitemap, locate the framework's routing definition (such as React
Router, Next.js app or pages, Vue Router, or its equivalent).
Never propose a tool for a path that robots.txt explicitly disallows.

3. Find where actions actually happen. Search for interactive elements such as
forms, buttons, inputs, selects, textareas, and framework event handlers. Find
API or server-route directories, REST endpoints, tRPC routers, GraphQL
resolvers, or equivalent handlers. Identify the state source used by each
candidate action, including hooks, context, Redux, Zustand, Pinia, Vue refs,
or other stores. A tool must touch the same state as the UI, not a copy.

4. Cross-reference before drafting. For each candidate action, connect it to
a real route and a real handler/state source. Treat actions that cannot be
traced to both as lower priority or skip them rather than guessing. Record
preconditions such as authentication, a non-empty cart, or feature flags;
these should drive conditional or dynamic registration rather than a static
tool.

5. Only after this discovery, choose declarative versus imperative per action
   and start drafting.

If discovery reports existing WebMCP registrations, classify each candidate as
already satisfied, needing modification, or genuinely new. Do not duplicate an
existing tool. Prefer the discovered WebMCP integration files for imperative
changes; use the actual component containing a form for declarative changes.
Record this reasoning in the generation output.

Report the discovery findings before the diff: the detected stack, routes or
pages, candidate actions, the real handler and state location for each, and
which actions are proposed or deliberately skipped with the reason.
`.trim();

export const TOOL_PLACEMENT_GUIDANCE = `
When placing or drafting generated WebMCP code, follow the site's existing
file organization and runtime conventions.

- For imperative tools, use the codebase's existing WebMCP or integration
  directory when one exists or is implied by the project structure. If you
  create a new file, import it and invoke or register it from a location that
  actually runs on app load (or on the relevant route's load). A standalone
  file containing unregistered tools is a failure.
- For declarative tools, edit the existing component that renders the
  relevant form or input in place. Do not create a separate file for a
  declarative tool; its value is being co-located with the markup it annotates.
- For every tool, state explicitly which existing file was edited or which
  new file was created, why that location fits, and where the tool is wired in
  or registered at runtime.
- The WebMCP runtime object may be declared as \`unknown\` by a site's ambient
  TypeScript or Cloudflare worker types. An \`in\` check alone does not narrow
  that value. Use a local, explicit WebMCP context interface and assign a
  narrowed immutable value before calling \`registerTool\`. Unregister by
  aborting the registration signal; do not invent or call \`unregisterTool\`.
  If a nested subscriber or handler needs the context,
  capture the narrowed value, not the optional value, for example:
  \`const discoveredContext = (navigator as Navigator & { modelContext?: WebMCPContext }).modelContext; if (!discoveredContext) return; const modelContext: WebMCPContext = discoveredContext;\`.
  Use \`modelContext\` inside every nested callback; never capture
  \`discoveredContext\` after the guard.
  Run the site's typecheck/build in the disposable workspace and fix all
  compile errors before reporting the draft.
`.trim();

export const TASK_AUTHORING_PROMPT = `
Based on the actions and tools you identified during discovery, propose 5-6
realistic tasks a user might ask an AI agent to complete on this site using
the available tools.

For each task, write a "verify" expression: a single JavaScript snippet that,
when evaluated in the live page after the task is attempted, returns true only
if the task's real-world effect actually happened. Base this on real,
observable state — persisted storage, DOM content, or the site's own state
management — not on trusting the agent's own claim of success.

Include at least one task that checks tool availability itself, such as
confirming a conditionally registered tool is or is not present through
document.modelContext.getTools(). Do not include tasks whose effect cannot be
verified this way.

Output the task proposal as JSON:
[{ "id": "...", "description": "...", "verify": "..." }]
`.trim();

export const TOOL_PROPOSAL_PROMPT = `
Produce a structured tool proposal after inspecting the supplied discovery.json.
Do not output free-form tool definitions. Output this exact JSON shape in a
fenced json block labelled TOOL_PROPOSALS_JSON:
{
  "tools": [{
    "id": "stable-tool-id",
    "name": "tool_name",
    "title": "Human-readable tool title",
    "description": "What the tool does",
    "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false },
    "annotations": {
      "readOnlyHint": false,
      "untrustedContentHint": false,
      "consequentialHint": false
    },
    "security": {
      "userAuthentication": "required, optional, or none",
      "agentIdentity": "required, optional, or none",
      "authorization": "backend, server-action, client-only, or none",
      "originScope": "same-origin or restricted-cross-origin",
      "allowedOrigins": [],
      "rateLimit": { "enforced": false, "scope": "agent-user-tool", "limit": 60, "windowSeconds": 60 },
      "idempotency": { "enforced": false, "keyParameter": "idempotencyKey" },
      "notes": "Exact source evidence for enforced controls, or an honest description of the gap"
    },
    "implementation": {
      "handler": "path/to/file.ts#handler-or-function",
      "action": "the discovered action this invokes",
      "state": "the discovered state source, when applicable"
    },
    "placement": {
      "strategy": "imperative or declarative",
      "file": "path/to/registration-or-component.tsx",
      "rationale": "Why this location and strategy fit"
    },
    "sourceFiles": ["path/to/file.tsx"]
  }]
}
Every sourceFiles and placement.file path must occur in discovery.sourceFiles,
and each tool must correspond to a discovered form, button, action, API,
authentication, state, or existing-WebMCP signal. Do not propose tools for
capabilities absent from discovery. Keep this JSON separate from the later
TASKS_JSON and unified diff sections.

The security object is Core review metadata, not a WebMCP API field. Make every
claim match the code in the exact proposed patch. Never claim backend
authorization, agent identity, quotas, or idempotency merely because the UI or
tool description mentions them. A state-changing tool must reuse a real
backend/server action with authorization. A consequential action must also be
bound to an authenticated user and verified agent, rate limited, and protected
against replay. If the target lacks those controls, do not fabricate them:
either implement the smallest real backend control or skip that high-risk tool
and explain why.
`.trim();
