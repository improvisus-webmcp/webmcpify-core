import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { runGenerate } from "../dist/commands/generate.js";
import { readPatchMetadata } from "../dist/lib/patches.js";
import { extractTasksFromText, validateTaskToolBindings } from "../dist/lib/tasks.js";
import { fixtureProvider } from "./fixture-provider.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-generation-recovery-"));
const originalEnv = { ...process.env };
const terminal = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const source = "export function selectItem() { document.body.dataset.selected = 'true'; }\ndocument.querySelector('button')?.addEventListener('click', selectItem);\n";
try {
  const provider = await fixtureProvider(root, "provider", `
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
const counter = process.env.FIXTURE_GENERATION_COUNTER;
const count = Number(readFileSync(counter, 'utf8')) + 1;
writeFileSync(counter, String(count));
const mode = process.env.FIXTURE_GENERATION_MODE;
if (count === 1) {
  writeFileSync('src/app.js', readFileSync('src/app.js', 'utf8') + "\\nimport './webmcp.js';\\n");
  writeFileSync('src/webmcp.js', "import {selectItem} from './app.js';\\nconst context = document.modelContext;\\nif(context) { const controller = new AbortController(); context.registerTool({name:'select_item',title:'Select item',description:'Select an item',inputSchema:{type:'object',properties:{}},execute:()=>{selectItem();return {selected:true};}}, {signal:controller.signal}); }\\n");
}
const tool = {id:'select_item',name:'select_item',title:'Select item',description:'Selects an item in local UI state',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Only local document selection changes.'},implementation:{handler:'src/app.js#selectItem',action:'select item',state:'document.body.dataset.selected'},behavior:{success:'The item is selected',preconditions:[],expectedFailures:[]},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Registered from the actual entry'},sourceFiles:['src/app.js']};
const tasks = Array.from({length:5}, (_,i)=>({id:'select_'+i,description:'Select item and verify local state',requiredTools:['select_item'],verify:'document.body.dataset.selected === "true"'}));
if (count === 1 && mode !== 'valid') tasks[0].requiredTools = ['missing_tool_PRIVATE_VALIDATION'];
if (mode === 'invalid' || (mode === 'repair-provider-fails' && count === 1)) tasks[0].requiredTools = ['missing_tool_PRIVATE_VALIDATION'];
if (mode === 'proposal-fix' && count === 1) tool.parameters.type = 'string';
if (count === 2 && mode === 'source-drift') writeFileSync('src/app.js', readFileSync('src/app.js', 'utf8') + '\\n// UNAUTHORIZED_SOURCE_CHANGE\\n');
if (count === 2 && mode === 'git-drift') { const {execFileSync} = await import('node:child_process'); execFileSync('git', ['commit','--allow-empty','-qm','changed identity']); }
if (count === 2 && mode === 'tool-drift') tool.description = 'A changed contract';
if (count === 2 && mode === 'repair-provider-fails') { process.stderr.write('PRIVATE_PROVIDER_DIAGNOSTICS'); process.exit(7); }
const fence = String.fromCharCode(96).repeat(3);
writeSync(1, ['TOOL_PROPOSALS_JSON', fence+'json', JSON.stringify({tools:[tool]}), fence, 'TASKS_JSON', fence+'json', JSON.stringify(tasks), fence].join('\\n'));
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  console.log = (...args) => terminal.push(args.map(String).join(" "));
  console.warn = (...args) => terminal.push(args.map(String).join(" "));
  console.error = (...args) => terminal.push(args.map(String).join(" "));
  for (const mode of ["valid", "task-fix", "proposal-fix", "invalid", "source-drift", "git-drift", "tool-drift", "repair-provider-fails"]) {
    const site = path.join(root, mode);
    await mkdir(path.join(site, "src"), { recursive: true });
    await writeFile(path.join(site, "src/app.js"), source);
    await writeFile(path.join(site, "index.html"), '<button onclick="selectItem()">Select</button>');
    await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "recovery-fixture", type: "module", scripts: { build: "node --check src/app.js && node --check src/webmcp.js" } }));
    await writeFile(path.join(site, ".gitignore"), ".webmcpify/\nnode_modules/\n");
    for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: site });
    process.env.FIXTURE_GENERATION_MODE = mode;
    process.env.FIXTURE_GENERATION_COUNTER = path.join(root, `${mode}-counter`);
    await writeFile(process.env.FIXTURE_GENERATION_COUNTER, "0");
    const generate = () => runGenerate({ path: site, provider: "opencode", productContextPrompt: false });
    if (["valid", "task-fix", "proposal-fix"].includes(mode)) {
      await generate();
      const metadata = await readPatchMetadata(site);
      assert.equal(metadata.patchStatus, "awaiting-review");
      assert.match(path.basename(metadata.generationTrajectory), mode === "valid" ? /^generate-\d/ : /^generate-metadata-fix-/);
      const raw = await readFile(metadata.generationTrajectory, "utf8");
      const tools = JSON.parse(await readFile(path.join(site, ".webmcpify/proposed-tools.json"), "utf8")).tools;
      assert.equal(validateTaskToolBindings(extractTasksFromText(raw), tools).length, 5, "Review must use corrected complete tasks");
      if (mode !== "valid") {
        const files = await import("node:fs/promises");
        const originalDraft = (await files.readdir(path.join(site, ".webmcpify/trajectories"))).find((file) => /^generate-\d.*\.json$/.test(file));
        assert.match(await readFile(path.join(site, ".webmcpify/trajectories", originalDraft), "utf8"), /missing_tool_PRIVATE_VALIDATION/);
      }
    } else {
      await assert.rejects(generate(), (error) => {
        assert.match(error.message, /could not be safely corrected after one attempt/);
        assert.doesNotMatch(error.message, /PRIVATE_VALIDATION|PRIVATE_PROVIDER_DIAGNOSTICS|UNAUTHORIZED_SOURCE_CHANGE/);
        return true;
      });
      await assert.rejects(readFile(path.join(site, ".webmcpify/pending-diff.meta.json")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(site, ".webmcpify/proposed-tools.json")), { code: "ENOENT" });
    }
    assert.equal(Number(await readFile(process.env.FIXTURE_GENERATION_COUNTER, "utf8")), mode === "valid" ? 1 : 2, "At most one metadata retry");
    assert.equal(await readFile(path.join(site, "src/app.js"), "utf8"), source, "Never edit real target source before approval");
    await assert.rejects(readFile(path.join(site, "src/webmcp.js")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
  }
  assert.doesNotMatch(terminal.join("\n"), /PRIVATE_VALIDATION|PRIVATE_PROVIDER_DIAGNOSTICS|UNAUTHORIZED_SOURCE_CHANGE/);
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Generation recovery passed: bounded metadata correction, corrected review draft, frozen contracts/source/Git identity, no target edits, private diagnostics");
await import("./verify-generation-metadata.mjs");
