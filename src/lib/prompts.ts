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
  TypeScript or Cloudflare worker types in a TypeScript project. An \`in\` check alone does not narrow
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
Based on the actions and tools you identified during discovery, propose at least
ceil(number of proposed tools * 1.3) realistic, distinct verification tasks.
There is no six-task maximum. For 10 tools, provide at least 13 tasks; 14 or more
are allowed when grounded in additional scenarios. Apply the same rule to revised
drafts using only the retained tool count. Include meaningful success, declared
expected-rejection, boundary/input, and availability checks where applicable;
never invent failure guards or duplicate a test merely to reach the count.

For each task, write a "verify" expression: a single JavaScript snippet that,
when evaluated in the live page after the task is attempted, returns true only
if the task's real-world effect actually happened. Base this on real,
observable state — persisted storage, DOM content, or the site's own state
management — not on trusting the agent's own claim of success.

Core executes all setup and actions ONLY through Chrome DevTools MCP
list_webmcp_tools and call_webmcp_tool (which delegates to the upstream
execute_webmcp_tool method). Never require clicks, direct JavaScript calls to
handlers/modelContext, or ordinary UI interactions to prepare a test. Setup
must be achievable through the task's approved requiredTools. For a rejection
test, successful setup calls to the same tool with other inputs are permitted
(for example selecting three items before the guarded fourth-item attempt).

Storage keys can legitimately be absent in a fresh context, especially when a
rejected action makes no mutation. Handle missing storage without throwing:
for example use JSON.parse(localStorage.getItem('actual-key') ?? '{}')?.state?.cart
and a source-grounded empty-cart default for a negative test. For a positive
test, absent state must return false. Use the real persisted key/shape; never
set or synthesize storage during verification. Verification must be read-only.

Include at least one task that checks tool availability itself, such as
discovering the live catalog through list_webmcp_tools and independently
checking Boolean(document.modelContext). Do not assume draft getTools APIs
are implemented by the target browser or treat an async getTools result as
an array. If a source-grounded availability check genuinely uses a supported
async page API, feature-detect it and await it in an async IIFE. Discovery and
all capability actions still use Core's Chrome DevTools MCP gateway, never
direct executeTool calls. Do not include tasks whose effect cannot be
verified this way.

Verification tasks are tests, not WebMCP tools. Never place a task (including
the tool-availability check) inside the TOOL_PROPOSALS_JSON tools array.

Every task must be executable with the exact WebMCP tools in your
TOOL_PROPOSALS_JSON. Every proposed tool name must appear in requiredTools for
at least one task: generated tools without test coverage invalidate the entire
proposal. Combine compatible tools into a self-contained task when necessary
to exercise realistic multi-tool flows, but still meet the tool-scaled task minimum.
Do not create a task for an
ordinary UI control unless you also propose its matching WebMCP tool. Never
call an unsupported action an expected pass.

Each task must declare expectedOutcome as either "success" or "rejection".
Success tasks are self-contained because Core resets browser state before every
task. A successful checkout task must explicitly set up login and cart contents
through approved tools before checkout. Record required tool names in execution
order and describe that setup.

Use a rejection task for a real, discovered business-rule guard: for example,
checkout without authentication or cart contents, or remove_item with an empty
cart. A rejection task must test exactly one proposed tool. It may declare
setup to prepare the negative case, such as emptying the cart or choosing an
absent item, but that preparation must keep the declared failure condition
true and must never satisfy the missing prerequisite or perform the primary
rejected operation early. Setup may successfully call the same tool with other
inputs when that establishes the negative case. Omit setup when the initial
state already meets the negative case.
Set expectedError to stable text from that tool's
behavior.expectedFailures contract, and verify independently that no forbidden
state change occurred. Do not use rejection tasks for crashes, missing tools,
invalid schemas, browser failures, or invented behavior. The one
tool-availability check may use an empty requiredTools list because it only
reads document.modelContext. Do not assume a prior task left state behind.

Output the task proposal in a fenced json block labelled TASKS_JSON:
TASKS_JSON
\`\`\`json
[{
  "id": "...",
  "description": "The complete expected outcome.",
  "expectedOutcome": "success",
  "requiredTools": ["first_setup_tool", "primary_tool"],
  "setup": "Use first_setup_tool to establish the required state before the primary action.",
  "verify": "..."
}, {
  "id": "...-rejected",
  "description": "Attempt a guarded action while its real precondition is unmet.",
  "expectedOutcome": "rejection",
  "expectedError": "Stable error text declared in behavior.expectedFailures",
  "requiredTools": ["guarded_tool"],
  "verify": "..."
}]
\`\`\`

The verify field is plain browser JavaScript, not TypeScript: do not use type
assertions such as \`as HTMLSelectElement\`, type annotations, interfaces, or
other TypeScript-only syntax. Validate each expression as JavaScript before
you output it.
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
      "executionScope": "ui-state or backend; match the real handler effect",
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
    "behavior": {
      "success": "The exact observable result of a successful call",
      "preconditions": ["Real state required before the call can succeed"],
      "expectedFailures": [{
        "condition": "A discovered precondition is unmet",
        "error": "Stable rejection text returned by the implementation"
      }]
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
capabilities absent from discovery. Trace each behavior precondition and
expected failure to actual source logic; use an empty expectedFailures array
when the action has no discovered business-rule rejection. Never invent an
error message. These contracts drive positive and negative browser tests, so
they must agree with the generated handler exactly. Keep this JSON separate
from the later TASKS_JSON and unified diff sections.

The security object is Core review metadata, not a WebMCP API field. Make every
claim match the code in the exact proposed patch. Never claim backend
authorization, agent identity, quotas, or idempotency merely because the UI or
tool description mentions them. Follow the security posture supplied later in
the run prompt. If that posture requires a control the target lacks, do not
fabricate it: either implement the smallest real control or skip the high-risk
tool and explain why.
Set executionScope to ui-state only for browser-local reversible actions;
backend for persisted server mutations. Mark consequentialHint false for
ordinary UI changes. A click or local cart update must not gain a backend just
to pass strict review. High-impact effects remain consequential regardless of
the label or scope. Public documentation must contain no secret values.
`.trim();
