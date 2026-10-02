import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { fixtureProvider } from "./fixture-provider.mjs";
import { runGenerate } from "../dist/commands/generate.js";
import { runReviewPrompt } from "../dist/commands/review.js";
import { runApply } from "../dist/commands/apply.js";
import { readPatchMetadata, readPendingPatch } from "../dist/lib/patches.js";
import { loadApprovedTasks, extractTasksFromText } from "../dist/lib/tasks.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-partial-review-"));
const previousEnv = { ...process.env };
const source = "export function selectItem(){document.body.dataset.selected='true';}\nexport function dismissItem(){delete document.body.dataset.selected;}\ndocument.querySelector('button')?.addEventListener('click', selectItem);\n";
const reviews = [];
try {
  const provider = await fixtureProvider(root, "provider", `
import {existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
const selection = existsSync('.webmcpify/tool-selection.json') ? JSON.parse(readFileSync('.webmcpify/tool-selection.json','utf8')) : null;
if(selection&&process.env.PARTIAL_REVIEW_MODE==='success')await new Promise(resolve=>setTimeout(resolve,300));
const makeTool = (name,handler)=>({id:name,name,title:name,description:'Changes local selection state',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Browser local state only'},implementation:{handler:'src/app.js#'+handler,action:'change selection',state:'document.body.dataset.selected'},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Loaded entry integration'},sourceFiles:['src/app.js'],behavior:{success:'Selection changes',preconditions:[],expectedFailures:[]}});
let tools=selection?selection.selected:[makeTool('select_item','selectItem'),makeTool('dismiss_item','dismissItem')];
if(selection&&process.env.PARTIAL_REVIEW_MODE==='contract-drift')tools=tools.map(tool=>({...tool,description:'Changed contract'}));
if(selection&&process.env.PARTIAL_REVIEW_MODE==='provider-failure'){process.stderr.write('PRIVATE_REVIEW_PROVIDER_OUTPUT');process.exit(5);}
if(!selection)writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+"\\nimport './webmcp.js';\\n");
const registrations=tools.map(tool=>"context.registerTool({name:"+JSON.stringify(tool.name)+",title:'Change selection',description:'Change selection',inputSchema:{type:'object',properties:{}},execute:()=>{ "+(tool.name==='select_item'?'selectItem':'dismissItem')+"();return {};}});").join('\\n');
const rejected=selection&&process.env.PARTIAL_REVIEW_MODE==='source-drift'?"context.registerTool({name:'dismiss_item',execute:dismissItem});":'';
writeFileSync('src/webmcp.js',"import {selectItem,dismissItem} from './app.js';\\nconst context=document.modelContext;if(context){\\n"+registrations+rejected+"\\n}\\n");
const tasks=Array.from({length:5},(_,i)=>({id:'task_'+i,description:'Verify local selection',requiredTools:[selection?'select_item':i<3?'select_item':'dismiss_item'],verify:'document.body.dataset.selected === "true"'}));
const fence=String.fromCharCode(96).repeat(3);writeSync(1,['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools}),fence,'TASKS_JSON',fence+'json',JSON.stringify(tasks),fence].join('\\n'));
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  for (const mode of ["success", "source-drift", "contract-drift", "provider-failure"]) {
    process.env.PARTIAL_REVIEW_MODE = mode;
    const site = path.join(root, mode);
    await mkdir(path.join(site, "src"), { recursive: true });
    await writeFile(path.join(site, "src/app.js"), source);
    await writeFile(path.join(site, "index.html"), '<button onclick="selectItem()">Select</button><button onclick="dismissItem()">Dismiss</button>');
    await writeFile(path.join(site, ".gitignore"), ".webmcpify/\nnode_modules/\n");
    await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "partial-fixture", type: "module", scripts: { build: "node --check src/app.js && node --check src/webmcp.js" } }));
    for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: site });
    try { await runGenerate({ path: site, provider: "opencode", productContextPrompt: false }); }
    catch (error) {
      const diagnostics = await readdir(path.join(site, ".webmcpify/trajectories"));
      const validation = diagnostics.find(name => /^generate-metadata-validation-.*\.json$/.test(name) && !name.endsWith(".meta.json"));
      if (validation) {
        const details = JSON.parse(await readFile(path.join(site, ".webmcpify/trajectories", validation), "utf8"));
        throw new Error(`Fixture generation failed validation: ${details.error}`, { cause: error });
      }
      throw error;
    }
    const original = await readPatchMetadata(site);
    assert.equal(original.securityPolicy, "balance");
    assert.equal(original.provider, "opencode");
    const originalPatch = await readPendingPatch(site, original);
    const tools = JSON.parse(await readFile(path.join(site, ".webmcpify/proposed-tools.json"), "utf8")).tools;
    const originalTasks = extractTasksFromText(await readFile(original.generationTrajectory, "utf8"));
    const controller = new AbortController();
    const review = withOperationSignal(controller.signal, () => runReviewPrompt(site, "4390"));
    review.catch(() => {});
    reviews.push({ controller, review });
    const getPage = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const response = await fetch("http://127.0.0.1:4390"); if (response.ok) return await response.text(); } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Review server did not start");
    };
    assert.match(await getPage(), /Prepare selected-tool draft/);
    let currentMetadata = original;
    let confirmationToken = "";
    const form = (stage, selectedTools, tasks) => {
      const body = new URLSearchParams({ stage, reviewRunId: currentMetadata.runId, reviewPatchHash: currentMetadata.patchHash, confirmationToken, toolsJson: JSON.stringify({ tools: selectedTools }), tasksJson: JSON.stringify(tasks), approveSourceDiff: "yes" });
      body.append("toolIds", "select_item");
      for (const task of tasks) body.append("taskIds", task.id);
      return body;
    };
    const post = body => fetch("http://127.0.0.1:4390/approve", { method: "POST", body });
    const request = post(form("prepare", tools, originalTasks));
    if (mode === "success") {
      await new Promise(resolve => setTimeout(resolve, 50));
      const duplicate = await post(form("prepare", tools, originalTasks));
      assert.equal(duplicate.status, 409, "Double submits must not launch overlapping revisions");
    }
    const selectedResponse = await request;
    const selectedText = await selectedResponse.text();
    assert.doesNotMatch(selectedText, /PRIVATE_REVIEW_PROVIDER_OUTPUT/);
    assert.equal(await readFile(path.join(site, "src/app.js"), "utf8"), source, "Review must never change target source");
    await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
    if (mode === "success") {
      assert.equal(selectedResponse.status, 200, selectedText);
      assert.match(selectedText, /No approval has been created/);
      const revised = await readPatchMetadata(site);
      assert.notEqual(revised.runId, original.runId);
      assert.equal(revised.patchStatus, "awaiting-review");
      const revisedPatch = await readPendingPatch(site, revised);
      assert.doesNotMatch(revisedPatch, /name:\s*['"]dismiss_item/);
      const retained = JSON.parse(await readFile(path.join(site, ".webmcpify/proposed-tools.json"), "utf8")).tools;
      assert.deepEqual(retained.map(tool => tool.name), ["select_item"]);
      const tasks = extractTasksFromText(await readFile(revised.generationTrajectory, "utf8"));
      assert.ok(tasks.every(task => task.requiredTools.length === 1 && task.requiredTools[0] === "select_item"));
      await getPage();
      const staleConfirm = await post(form("confirm", retained, tasks));
      assert.equal(staleConfirm.status, 400, "The old draft cannot confirm a new source patch");
      currentMetadata = revised;
      const prepare = await post(form("prepare", retained, tasks));
      const confirmationPage = await prepare.text();
      assert.match(confirmationPage, /Confirm Approval/);
      assert.match(confirmationPage, /margin-top:24px/);
      confirmationToken = confirmationPage.match(/name="confirmationToken" value="([^"]+)"/)[1];
      await assert.rejects(readFile(path.join(site, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
      const confirm = await post(form("confirm", retained, tasks));
      assert.equal(confirm.status, 200, await confirm.text());
      const result = await review;
      assert.deepEqual(result.tools, ["select_item"]);
      assert.deepEqual(await loadApprovedTasks(site), tasks);
      await runApply({ path: site });
      assert.match(await readFile(path.join(site, "src/webmcp.js"), "utf8"), /name:\s*["']select_item/);
      assert.doesNotMatch(await readFile(path.join(site, "src/webmcp.js"), "utf8"), /name:\s*["']dismiss_item/);
      assert.match(await readFile(path.join(site, "src/app.js"), "utf8"), /export function dismissItem/, "Rejecting a WebMCP tool must preserve its original app action");
      assert.doesNotMatch(await readFile(path.join(site, "AGENTS.md"), "utf8"), /dismiss_item/);
      for (const file of ["README.md", "webmcp.md", "webmcp.html"]) {
        const content = await readFile(path.join(site, file), "utf8");
        assert.match(content, /select_item/);
        assert.doesNotMatch(content, /dismiss_item/, `${file} must describe only retained tools`);
      }
    } else {
      assert.equal(selectedResponse.status, 400, selectedText);
      assert.match(selectedText, /Could not safely revise/);
      assert.equal(await readPendingPatch(site, original), originalPatch, "Failed revisions preserve the old pending patch");
      controller.abort();
      await assert.rejects(review, /Review was cancelled/);
    }
    assert.ok((await readdir(path.join(site, ".webmcpify/trajectories"))).some(name => name.startsWith("review-selection-")));
  }
} finally {
  for (const { controller, review } of reviews) { controller.abort(); await review.catch(() => {}); }
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Partial review passed: rejected registrations omitted, approved-only tools/tasks/docs, original app behavior preserved, fresh exact-patch confirmation, fail-closed revision");
