import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProject } from "../dist/lib/discovery.js";
import {
  extractAndValidateProposedTools,
  validateProposedTools,
  writeProposedTools,
} from "../dist/lib/tool-proposals.js";
import { extractTasksFromText, validateTaskToolBindings, validateToolScaledTasks } from "../dist/lib/tasks.js";
import { expectedRejectionObserved, requiredToolsObserved } from "../dist/lib/scoring.js";

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
    behavior: {
      success: "The discovered action completes.",
      preconditions: [],
      expectedFailures: [],
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
  const [legacyTool] = extractAndValidateProposedTools(
    JSON.stringify({ tools: [tool] }),
    discovery,
  );
  assert.equal(legacyTool.behavior.success, tool.behavior.success);
  assert.deepEqual(
    validateProposedTools(
      { tools: [{ ...tool, behavior: undefined }] },
      discovery,
    )[0].behavior,
    {
      success: tool.description,
      preconditions: [],
      expectedFailures: [],
    },
  );
  assert.throws(
    () => extractAndValidateProposedTools(
      JSON.stringify({ tools: [{ ...tool, behavior: undefined }] }),
      discovery,
    ),
    /behavior contract/,
  );
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

  assert.throws(
    () => validateTaskToolBindings(
      [{ id: "covered", description: "Covers one tool.", requiredTools: ["covered_tool"], verify: "document.body !== null" }],
      ["covered_tool", "untested_tool"],
    ),
    /missing task coverage for: untested_tool/,
  );

  const guardedTool = {
    name: "checkout_now",
    behavior: {
      expectedFailures: [
        { condition: "The user is logged out.", error: "Sign in before checkout" },
      ],
    },
  };
  const rejectionTask = {
    id: "checkout-rejected",
    description: "Checkout is rejected while logged out and no order is created.",
    expectedOutcome: "rejection",
    expectedError: "Sign in before checkout",
    requiredTools: ["checkout_now"],
    verify: "document.querySelector('[data-order-confirmation]') === null",
  };
  assert.deepEqual(validateTaskToolBindings([rejectionTask], [guardedTool]), [rejectionTask]);
  const preparedRejection = { ...rejectionTask, setup: "Use the normal UI to empty the cart while staying logged out. Do not attempt checkout during setup." };
  assert.deepEqual(validateTaskToolBindings([preparedRejection], [guardedTool]), [preparedRejection]);
  const absentCoffee = { ...preparedRejection, id: "remove-absent-coffee-rejected", requiredTools: ["remove_item"], setup: "Use the normal UI to empty the cart, then choose an absent coffee. Do not invoke remove_item during setup.", expectedError: "Item not found" };
  assert.deepEqual(validateTaskToolBindings([absentCoffee], [{ name: "remove_item", expectedFailures: [{ condition: "Requested coffee is absent", error: "Item not found" }] }]), [absentCoffee]);
  const concreteCoffee = { ...absentCoffee, expectedError: "Gachatha AA is not in the cart." };
  const templateContract = { name: "remove_item", expectedFailures: [{ condition: "Requested coffee is absent", error: "The product-specific error is `${productById[productId].name} is not in the cart.`" }] };
  assert.deepEqual(validateTaskToolBindings([concreteCoffee], [templateContract]), [concreteCoffee], "Concrete product errors must match their declared template");
  assert.deepEqual(validateTaskToolBindings([concreteCoffee], [{ ...templateContract, expectedFailures: [{ condition: "Absent", error: "${productName} is not in the cart." }] }]), [concreteCoffee]);
  for (const expectedError of ["Gachatha AA was removed from the cart.", "Sign in before checkout"]) {
    assert.throws(() => validateTaskToolBindings([{ ...concreteCoffee, expectedError }], [templateContract]), /not declared by tool/, "Templates must preserve the concrete guard");
  }
  assert.throws(() => validateTaskToolBindings([concreteCoffee], [{ ...templateContract, expectedFailures: [{ condition: "Unknown", error: "${arbitraryError}" }] }]), /not declared by tool/, "An all-variable template cannot authorize arbitrary errors");
  const metacharacterTask = { ...concreteCoffee, expectedError: "Coffee [AA] is not in the cart (demo)." };
  const literalMetacharacters = { ...templateContract, expectedFailures: [{ condition: "Absent", error: "${productName} is not in the cart (demo)." }] };
  assert.deepEqual(validateTaskToolBindings([metacharacterTask], [literalMetacharacters]), [metacharacterTask]);
  assert.throws(() => validateTaskToolBindings([{ ...metacharacterTask, expectedError: "Coffee [AA] is not in the cart demoX" }], [literalMetacharacters]), /not declared by tool/, "Regex metacharacters in declarations are literals");
  assert.equal(expectedRejectionObserved(concreteCoffee, { source: "chrome-devtools-mcp", pageId: 1, discovered: true, policyViolations: [], calls: [{ toolName: "remove_item", status: "error", error: concreteCoffee.expectedError }] }), true);
  assert.equal(expectedRejectionObserved(concreteCoffee, { source: "chrome-devtools-mcp", pageId: 1, discovered: true, policyViolations: [], calls: [{ toolName: "remove_item", status: "error", error: "Another coffee is not in the cart." }] }), false, "Runtime scoring still requires the concrete approved error");
  const tenTools = Array.from({ length: 10 }, (_, index) => `tool_${index}`);
  const thirteenTasks = Array.from({ length: 13 }, (_, index) => ({ id: `scaled_${index}`, description: "Verify a declared tool scenario", requiredTools: [tenTools[index % 10]], verify: "document.body !== null" }));
  assert.throws(() => validateToolScaledTasks(thirteenTasks.slice(0, 12), tenTools), /at least 13/, "The coffee draft's 10 tools and 12 tasks still require supplementation");
  assert.equal(validateToolScaledTasks(thirteenTasks, tenTools).length, 13);
  assert.throws(
    () => validateTaskToolBindings([{ ...preparedRejection, requiredTools: ["checkout_now", "login"] }], [guardedTool, { name: "login" }]),
    /exactly one WebMCP tool/,
  );
  assert.throws(
    () => validateTaskToolBindings([preparedRejection], [{ name: "checkout_now", behavior: { expectedFailures: [] } }]),
    /not backed by a declared expected failure/,
  );
  assert.throws(
    () => validateTaskToolBindings([{ ...rejectionTask, expectedError: "Invented error" }], [guardedTool]),
    /not declared by tool/,
  );
  assert.equal(
    expectedRejectionObserved(rejectionTask, {
      source: "chrome-devtools-mcp", pageId: 1, discovered: true, policyViolations: [],
      calls: [{ toolName: "checkout_now", status: "error", error: "Sign in before checkout" }],
    }),
    true,
  );
  assert.equal(
    expectedRejectionObserved(rejectionTask, {
      prompt: "Call checkout_now and expect Sign in before checkout",
      response: "I did not call the tool.",
    }),
    false,
    "prompt text alone must not prove an expected rejection",
  );
  assert.equal(
    requiredToolsObserved(
      { id: "cart", description: "Add then remove", requiredTools: ["add_to_cart", "remove_item"], verify: "true" },
      { source: "chrome-devtools-mcp", pageId: 1, discovered: true, policyViolations: [], calls: [{ toolName: "add_to_cart", status: "success" }, { toolName: "remove_item", status: "success" }] },
    ),
    true,
  );
  assert.equal(
    requiredToolsObserved(
      { id: "cart", description: "Add then remove", requiredTools: ["add_to_cart", "remove_item"], verify: "true" },
      { response: "Called add_to_cart only." },
    ),
    false,
  );

  console.log("Structured proposal, complete tool coverage, and expected-rejection verification passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
