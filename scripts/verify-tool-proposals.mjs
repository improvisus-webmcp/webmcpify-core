import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProject } from "../dist/lib/discovery.js";
import {
  extractAndValidateProposedTools,
  writeProposedTools,
} from "../dist/lib/tool-proposals.js";
import { extractTasksFromText, validateTaskToolBindings } from "../dist/lib/tasks.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "webmcpify-tools-"));

try {
  await mkdir(path.join(fixture, "src"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "tool-proposal-fixture" }),
  );
  await writeFile(
    path.join(fixture, "src", "search.tsx"),
    `export function Search() {
  return <form onSubmit={() => undefined}><input name="query" /><button type="submit">Search</button></form>;
}\n`,
  );

  const discovery = await discoverProject(fixture);
  const file = discovery.actions[0]?.file ?? discovery.forms[0]?.file;
  assert.ok(file, "fixture has no actionable discovery signal");
  const tool = {
    id: "discovered_action",
    name: "discovered_action",
    description: "Runs a discovered action.",
    title: "Discovered action",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: false,
      consequentialHint: true,
    },
    security: {
      userAuthentication: "required",
      agentIdentity: "required",
      authorization: "backend",
      originScope: "same-origin",
      rateLimit: { enforced: true, scope: "agent-user-tool", limit: 3, windowSeconds: 86400 },
      idempotency: { enforced: true, keyParameter: "idempotencyKey" },
      notes: "Backend enforcement is part of the reviewed proposal.",
    },
    implementation: {
      handler: `${file}#handler`,
      action: "discovered action",
    },
    placement: {
      strategy: "imperative",
      file,
      rationale: "Uses the discovered action location.",
    },
    sourceFiles: [file],
  };

  const validTools = extractAndValidateProposedTools(
    JSON.stringify({ tools: [tool] }),
    discovery,
  );
  assert.equal(validTools.length, 1);
  const mixedProviderOutput = `TOOL_PROPOSALS_JSON
\`\`\`json
${JSON.stringify({ tools: [tool, { id: "verify-tools-registered", description: "Checks that generated tools are registered.", verify: "document.modelContext.getTools().length > 0" }] })}
\`\`\`

TASKS_JSON
\`\`\`json
${JSON.stringify([{ id: "verify-tools-registered", description: "Checks that generated tools are registered.", verify: "document.modelContext.getTools().length > 0" }])}
\`\`\``;
  const recoveredTools = extractAndValidateProposedTools(JSON.stringify({ response: mixedProviderOutput }), discovery);
  assert.deepEqual(recoveredTools.map((entry) => entry.id), [tool.id]);
  const proposalPath = await writeProposedTools(
    fixture,
    validTools,
    "discovery.json",
    "generation.json",
  );
  assert.equal(JSON.parse(await readFile(proposalPath, "utf8")).tools.length, 1);
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({ tools: [tool, { ...tool, id: "other_action" }] }),
        discovery,
      ),
    /Duplicate tool name/,
  );
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({
          tools: [
            {
              ...tool,
              sourceFiles: ["missing.ts"],
              placement: { ...tool.placement, file: "missing.ts" },
            },
          ],
        }),
        discovery,
      ),
    /no source file/,
  );
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({
          tools: [
            { ...tool, id: "bad", name: "bad", parameters: undefined },
          ],
        }),
        discovery,
      ),
    /parameters/,
  );
  assert.throws(
    () =>
      extractAndValidateProposedTools(
        JSON.stringify({ tools: [{ id: "verify-only", description: "Only a task.", verify: "true" }] }),
        discovery,
      ),
    /title/,
  );
  const tasks = [
    { id: "verify-tools", description: "Generated WebMCP tools are available.", requiredTools: ["add_to_cart"], verify: "document.modelContext?.getTools().length > 0" },
    { id: "add-coffee", description: "Adding coffee updates the cart count.", requiredTools: ["add_to_cart"], verify: "document.querySelector('[data-cart-count]')?.textContent === '1'" },
    { id: "remove-coffee", description: "Removing coffee clears the cart.", requiredTools: ["remove_from_cart"], verify: "document.querySelector('[data-cart-count]')?.textContent === '0'" },
    { id: "filter-dark-roast", description: "The dark roast filter is selected.", requiredTools: ["filter_by_roast"], verify: "(document.querySelector('#roast-filter') as HTMLSelectElement)?.value === 'dark'" },
    { id: "open-cart", description: "The cart panel is visible.", requiredTools: ["open_cart"], verify: "document.querySelector('[data-cart-panel]')?.getAttribute('aria-hidden') === 'false'" },
    { id: "checkout-ready", description: "Checkout is available for the cart.", requiredTools: ["toggle_user_auth", "add_to_cart", "checkout_cart"], setup: "Log in and add a coffee before checkout.", verify: "document.querySelector('[data-checkout]')?.hasAttribute('disabled') === false" },
  ];
  const recoveredTasks = extractTasksFromText(`### Verification Task Proposals JSON

\`\`\`json
${JSON.stringify(tasks)}
\`\`\``);
  assert.ok(recoveredTasks, "five valid tasks should be recovered from a six-task provider proposal");
  assert.deepEqual(recoveredTasks.map((task) => task.id), ["verify-tools", "add-coffee", "remove-coffee", "open-cart", "checkout-ready"]);
  validateTaskToolBindings(recoveredTasks, ["add_to_cart", "remove_from_cart", "open_cart", "toggle_user_auth", "checkout_cart"]);
  assert.throws(
    () => validateTaskToolBindings([{ id: "missing-tool", description: "Uses an unsupported filter.", requiredTools: ["filter_by_roast"], verify: "document.body !== null" }], ["add_to_cart"]),
    /unavailable WebMCP tool/,
  );
  assert.throws(
    () => validateTaskToolBindings([{ id: "checkout", description: "Checkout after login.", requiredTools: ["toggle_user_auth", "checkout_cart"], verify: "document.body !== null" }], ["toggle_user_auth", "checkout_cart"]),
    /self-contained setup/,
  );
  assert.deepEqual(
    validateTaskToolBindings([{ id: "availability", description: "WebMCP tools are available.", requiredTools: [], verify: "document.modelContext?.getTools().length > 0" }], []),
    [{ id: "availability", description: "WebMCP tools are available.", requiredTools: [], verify: "document.modelContext?.getTools().length > 0" }],
  );

  console.log("Structured proposal and task recovery verification passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
