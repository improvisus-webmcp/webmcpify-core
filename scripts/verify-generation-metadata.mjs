import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeAgentWorkspace } from "../dist/lib/agent-workspace.js";
import { discoverProject } from "../dist/lib/discovery.js";
import { validateGenerationMetadata } from "../dist/lib/generation-metadata.js";
import { extractAndValidateProposedTools } from "../dist/lib/tool-proposals.js";
import { extractTasksFromText, validateToolScaledTasks } from "../dist/lib/tasks.js";
import { fixtureProvider } from "./fixture-provider.mjs";

// Exercise metadata directly: no generation pipeline, package builds, browser,
// Temporal service, real provider credentials or owner target repository.
const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-metadata-only-"));
const originalEnv = { ...process.env };
const logs = [], originals = [console.log, console.warn, console.error];
const source = "export function selectItem() { return true; }\ndocument.querySelector('button')?.addEventListener('click', selectItem);\n";
const block = (label, value) => `${label}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
try {
  const provider = await fixtureProvider(root, "metadata-provider", `
import {readFileSync, writeFileSync, writeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const mode = process.env.FIXTURE_METADATA_MODE;
const counter = process.env.FIXTURE_METADATA_COUNTER;
writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1));
const prompt = process.argv.join(' ');
if (!prompt.includes('Return only a complete TASKS_JSON block')) process.exit(8);
const details = JSON.parse(readFileSync('.webmcpify/metadata-correction.json', 'utf8'));
const tasks = JSON.parse(readFileSync('.webmcpify/corrected-tasks.json', 'utf8'));
if (mode === 'shortfall') tasks.length = 12;
if (mode === 'source-drift') writeFileSync('src/app.js', 'export const unauthorized = true;');
if (mode === 'git-drift') execFileSync('git', ['commit','--allow-empty','-qm','unauthorized identity']);
if (mode === 'commentary') { writeSync(1, 'Please correct TASKS_JSON in metadata-correction.json.'); process.exit(0); }
const fence = String.fromCharCode(96).repeat(3);
if (mode === 'tool-drift') {
  details.validatedTools[0].description = 'Changed frozen contract';
  writeSync(1, ['TOOL_PROPOSALS_JSON', fence+'json', JSON.stringify({tools:details.validatedTools}), fence].join('\\n')+'\\n');
}
writeSync(1, ['TASKS_JSON', fence+'json', JSON.stringify(tasks), fence, 'Metadata corrected; source unchanged.'].join('\\n'));
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  console.log = console.warn = console.error = (...args) => logs.push(args.map(String).join(" "));
  for (const mode of ["template-valid", "prepared-rejection", "prepared-rejection-fix", "tasks-only", "count-fix", "shortfall", "commentary", "tool-drift", "source-drift", "git-drift"]) {
    const workspace = path.join(root, mode);
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "metadata-fixture", type: "module" }));
    await writeFile(path.join(workspace, "src/app.js"), source);
    await initializeAgentWorkspace(workspace);
    const discovery = await discoverProject(workspace);
    await mkdir(path.join(workspace, ".webmcpify"), { recursive: true });
    await writeFile(path.join(workspace, ".webmcpify/discovery.json"), JSON.stringify(discovery));
    const tools = Array.from({ length: 10 }, (_, index) => ({
      id: `tool_${index}`, name: `tool_${index}`, title: `Select ${index}`, description: `Select fixture item ${index}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false, consequentialHint: false },
      implementation: { handler: "src/app.js#selectItem", action: "select fixture item" },
      behavior: { success: "Selected", preconditions: [], expectedFailures: index === 0 ? [{ condition: "Product absent", error: "The product-specific error is `${productById[productId].name} is not in the cart.`" }] : [] },
      placement: { strategy: "imperative", file: "src/app.js", rationale: "Fixture handler" }, sourceFiles: ["src/app.js"],
    }));
    const tasks = Array.from({ length: 13 }, (_, index) => ({ id: `task_${index}`, description: `Verify fixture scenario ${index}`, requiredTools: [`tool_${index % 10}`], verify: `document.body.dataset.scenario === '${index}'` }));
    tasks[0] = { ...tasks[0], expectedOutcome: "rejection", expectedError: "Gachatha AA is not in the cart." };
    if (mode.startsWith("prepared-rejection")) tasks[0] = { ...tasks[0], requiredTools: ["tool_1", "tool_0"], setup: "Prepare an unrelated item using tool_1 without adding the absent product, then attempt tool_0 once." };
    const proposed = structuredClone(tasks);
    if (["count-fix", "prepared-rejection-fix"].includes(mode)) proposed.length = 12;
    else if (!["template-valid", "prepared-rejection"].includes(mode)) proposed[1].requiredTools = ["PRIVATE_INVALID_TOOL"];
    const draftPath = path.join(workspace, ".webmcpify/original-draft.json");
    await writeFile(draftPath, `${block("TOOL_PROPOSALS_JSON", { tools })}\n${block("TASKS_JSON", proposed)}`);
    await writeFile(path.join(workspace, ".webmcpify/corrected-tasks.json"), JSON.stringify(tasks));
    process.env.FIXTURE_METADATA_MODE = mode;
    process.env.FIXTURE_METADATA_COUNTER = path.join(workspace, ".webmcpify/counter");
    await writeFile(process.env.FIXTURE_METADATA_COUNTER, "0");
    const expectedTools = extractAndValidateProposedTools(await readFile(draftPath, "utf8"), discovery);
    const validate = () => validateGenerationMetadata({ provider: "opencode", sitePath: workspace, workspace, draftPath, discovery });
    if (["template-valid", "prepared-rejection", "prepared-rejection-fix", "tasks-only", "count-fix"].includes(mode)) {
      const result = await validate();
      assert.deepEqual(result.tools, expectedTools, "Already-valid contracts must be retained exactly");
      const canonical = await readFile(result.draftPath, "utf8");
      assert.deepEqual(extractAndValidateProposedTools(canonical, discovery), expectedTools);
      assert.equal(validateToolScaledTasks(extractTasksFromText(canonical), result.tools).length, 13);
      if (!["template-valid", "prepared-rejection"].includes(mode)) assert.match(canonical, /Metadata corrected; source unchanged/);
      assert.equal(await readFile(path.join(workspace, "src/app.js"), "utf8"), source);
    } else {
      await assert.rejects(validate(), /could not be safely corrected after one attempt/);
      const trajectories = path.join(workspace, ".webmcpify/trajectories");
      assert.equal((await readdir(trajectories)).filter(file => /^generate-metadata-fix-validated-.*\.json$/.test(file)).length, 0, "Failed correction must not produce a validated draft");
    }
    assert.equal(Number(await readFile(process.env.FIXTURE_METADATA_COUNTER, "utf8")), ["template-valid", "prepared-rejection"].includes(mode) ? 0 : 1, "Valid preparation must not trigger a correction; only one focused correction is allowed");
    await assert.rejects(readFile(path.join(workspace, ".webmcpify/pending-diff.meta.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(workspace, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
  }
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_INVALID_TOOL|Gachatha|productById/);
} finally {
  [console.log, console.warn, console.error] = originals;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Metadata-only regression passed: templates, tasks-only recovery, 10 tools/13 tests, frozen contracts/source/Git identity, incomplete-output refusal");
