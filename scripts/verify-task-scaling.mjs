import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { fixtureProvider } from "./fixture-provider.mjs";
import { runGenerate } from "../dist/commands/generate.js";
import { runReviewPrompt } from "../dist/commands/review.js";
import { runApply } from "../dist/commands/apply.js";
import { loadDiscovery } from "../dist/lib/tool-proposals.js";
import { readPatchMetadata, readPendingPatch } from "../dist/lib/patches.js";
import { completeSelectionTasks, reviseToolSelection } from "../dist/lib/review-selection.js";
import { extractTasksFromText, loadApprovedTasks, minimumTaskCount, validateTasks, validateToolScaledTasks } from "../dist/lib/tasks.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";

const contracts = Array.from({ length: 10 }, (_, i) => ({ name: `action_${i}` }));
const makeTasks = count => Array.from({ length: count }, (_, i) => ({ id: `scenario_${i}`, description: `Run distinct action scenario ${i}`, requiredTools: [contracts[i % 10].name], verify: `document.body.dataset.scenario${i} === 'done'` }));
assert.equal(minimumTaskCount(10), 12);
assert.equal(minimumTaskCount(5), 6);
assert.equal(minimumTaskCount(11), 14, "The live coffee draft's 27% margin must be accepted");
assert.equal(minimumTaskCount(1), 2);
assert.throws(() => minimumTaskCount(0), /at least one/);
assert.throws(() => validateTasks([], 0), /positive integer/);
for (const count of [12, 13, 14, 30]) assert.equal(validateToolScaledTasks(makeTasks(count), contracts).length, count, "Meaningful extra scenarios must not hit a fixed cap");
assert.throws(() => validateToolScaledTasks(makeTasks(11), contracts), /at least 12/);
assert.throws(() => validateToolScaledTasks(makeTasks(13).map(task => ({ ...task, requiredTools: ["action_0"] })), contracts), /missing task coverage/);
assert.throws(() => validateTasks([...makeTasks(13), makeTasks(1)[0]]), /duplicated/);
const label = tasks => `TASKS_JSON\n\`\`\`json\n${JSON.stringify(tasks)}\n\`\`\``;
const example = `Example\n\`\`\`json\n${JSON.stringify(makeTasks(1))}\n\`\`\`\n`;
assert.equal(extractTasksFromText(example + label(makeTasks(14))).length, 14, "Explicit TASKS_JSON must win over examples");
assert.equal(extractTasksFromText(example + label([])), undefined, "Invalid labelled tasks must not fall back to a stray example");
const malformed = [...makeTasks(13), { id: "malformed", description: "Bad expression", verify: "const broken: string = 'bad'" }];
assert.equal(validateToolScaledTasks(extractTasksFromText(label(malformed)), contracts).length, 13);
assert.equal(validateToolScaledTasks(extractTasksFromText(label(malformed.slice(1))), contracts).length, 12);
assert.throws(() => validateToolScaledTasks(extractTasksFromText(label(malformed.slice(2))), contracts), /missing task coverage|at least 12/);
const five = contracts.slice(0, 5);
const retained = makeTasks(5);
const supplements = [{ ...retained[0], id: "boundary", description: "Run boundary scenario", verify: "document.body.dataset.boundary === 'done'" }, { ...retained[1], id: "availability", description: "Verify another supported scenario", verify: "document.body.dataset.available === 'done'" }];
const combined = completeSelectionTasks(retained, supplements, five);
assert.equal(combined.length, 6, "Count shortfall must be filled without padding past the minimum");
assert.deepEqual(combined.slice(0, 5), retained);
assert.throws(() => completeSelectionTasks(retained, [], five), /at least 6/);

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-task-scaling-"));
const env = { ...process.env };
let controller;
let review;
try {
  const provider = await fixtureProvider(root, "provider", `
import {appendFileSync,existsSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
const selection=existsSync('.webmcpify/tool-selection.json')?JSON.parse(readFileSync('.webmcpify/tool-selection.json','utf8')):null;
if(selection){if(!selection.sourceAlreadyPruned)throw new Error('Expected a source-frozen supplementation pass');appendFileSync(${JSON.stringify(path.join(root, "calls"))},'supplement\\n');}
const tools=selection?selection.selected:Array.from({length:10},(_,i)=>({id:'action_'+i,name:'action_'+i,title:'Action '+i,description:'Updates local state for action '+i,parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Only local UI state.'},implementation:{handler:'src/app.js#act',action:'update local state',state:'document.body.dataset.action'},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Loaded entry integration'},sourceFiles:['src/app.js'],behavior:{success:'Local state updated',preconditions:[],expectedFailures:[]}}));
if(!selection){writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+"\\nimport './webmcp.js';\\n");writeFileSync('src/webmcp.js',"import {act} from './app.js';const context=document.modelContext;if(context){\\n"+tools.map((tool,i)=>"context.registerTool({name:"+JSON.stringify(tool.name)+",description:'Updates local state',inputSchema:{type:'object',properties:{}},execute:()=>{act("+i+");return {};}});").join('\\n')+'\\n}');}
const count=selection?selection.additionalTasksNeeded:13;
const tasks=Array.from({length:count},(_,i)=>{const tool=tools[i%tools.length];const repeat=Boolean(selection)||i>=tools.length;return {id:(selection?'supplement_':'scenario_')+i,description:(repeat?'Repeat ':'Run ')+tool.name+' and verify local action/count state',requiredTools:[tool.name],...(repeat?{setup:'Invoke '+tool.name+' once, then invoke it again to exercise repeated use'}:{}),verify:"document.body.dataset.action === '"+Number(tool.name.slice(7))+"' && document.body.dataset.count === '"+(repeat?2:1)+"'"};});
const fence=String.fromCharCode(96).repeat(3);writeSync(1,[...(!selection?['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools}),fence]:[]),'TASKS_JSON',fence+'json',JSON.stringify(tasks),fence].join('\\n'));
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  const originalSource = "export function act(index){document.body.dataset.action=String(index);document.body.dataset.count=String(Number(document.body.dataset.count??0)+1);}\ndocument.querySelector('button')?.addEventListener('click',()=>act(0));\n";
  const createSite = async name => {
    const site = path.join(root, name);
    await mkdir(path.join(site, "src"), { recursive: true });
    await mkdir(path.join(site, "node_modules"));
    await writeFile(path.join(site, "src/app.js"), originalSource);
    await writeFile(path.join(site, "index.html"), "<button>Act</button>");
    await writeFile(path.join(site, ".gitignore"), ".webmcpify/\nnode_modules/\n");
    await writeFile(path.join(site, "package.json"), JSON.stringify({ name: "scaled-task-fixture", type: "module", scripts: { build: "node --check src/app.js && node --check src/webmcp.js" } }));
    for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: site });
    await runGenerate({ path: site, provider: "opencode", productContextPrompt: false });
    return site;
  };
  const directSite = await createSite("direct");
  const directDiscovery = await loadDiscovery(directSite);
  const directMetadata = await readPatchMetadata(directSite);
  const tools = JSON.parse(await readFile(path.join(directSite, ".webmcpify/proposed-tools.json"), "utf8")).tools;
  const initialTasks = extractTasksFromText(await readFile(directMetadata.generationTrajectory, "utf8"));
  assert.equal(initialTasks.length, 13);
  await reviseToolSelection(directSite, directDiscovery, directMetadata, tools.slice(0, 8), tools.slice(8));
  const directRevised = await readPatchMetadata(directSite);
  const directTasks = extractTasksFromText(await readFile(directRevised.generationTrajectory, "utf8"));
  assert.equal(directTasks.length, 11, "Eight retained tools require eleven tests, not at most six");
  assert.deepEqual(directTasks, initialTasks.filter(task => !task.requiredTools.some(name => ["action_8", "action_9"].includes(name))));
  await assert.rejects(readFile(path.join(root, "calls")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(directSite, "src/app.js"), "utf8"), originalSource);
  controller = new AbortController();
  review = withOperationSignal(controller.signal, () => runReviewPrompt(directSite, "4403"));
  review.catch(() => {});
  let page;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch("http://127.0.0.1:4403"); if (response.ok) { page = await response.text(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(page, "Large-task review must start");
  assert.match(page, /11 proposed/);
  const form = new URLSearchParams({ stage: "prepare", reviewRunId: directRevised.runId, reviewPatchHash: directRevised.patchHash, approveSourceDiff: "yes" });
  tools.slice(0, 8).forEach(tool => form.append("toolIds", tool.id));
  const confirmation = await fetch("http://127.0.0.1:4403/approve", { method: "POST", body: form });
  assert.equal(confirmation.status, 200);
  const token = (await confirmation.text()).match(/name="confirmationToken" value="([^"]+)"/)[1];
  form.set("stage", "confirm"); form.set("confirmationToken", token);
  assert.equal((await fetch("http://127.0.0.1:4403/approve", { method: "POST", body: form })).status, 200);
  assert.equal((await review).tasks.length, 11);
  assert.deepEqual(await loadApprovedTasks(directSite), directTasks);
  await runApply({ path: directSite });
  assert.doesNotMatch(await readFile(path.join(directSite, "src/webmcp.js"), "utf8"), /action_[89]/);

  const supplementSite = await createSite("supplement");
  const discovery = await loadDiscovery(supplementSite);
  const metadata = await readPatchMetadata(supplementSite);
  await reviseToolSelection(supplementSite, discovery, metadata, tools.slice(5), tools.slice(0, 5));
  const revised = await readPatchMetadata(supplementSite);
  const revisedTasks = extractTasksFromText(await readFile(revised.generationTrajectory, "utf8"));
  assert.equal(revisedTasks.length, 6);
  assert.deepEqual(revisedTasks.slice(0, 5), initialTasks.filter(task => task.requiredTools.every(name => Number(name.slice(7)) >= 5)), "Coverage-complete retained tests must survive count-only supplementation exactly");
  assert.deepEqual(revisedTasks.slice(5).map(task => task.id), ["supplement_0"]);
  assert.equal(await readFile(path.join(root, "calls"), "utf8"), "supplement\n", "Count-only supplementation should use one source-frozen pass without a metadata retry");
  assert.doesNotMatch(await readPendingPatch(supplementSite, revised), /name:"action_[0-4]"/);
  assert.equal(await readFile(path.join(supplementSite, "src/app.js"), "utf8"), originalSource);
} finally {
  controller?.abort();
  await review?.catch(() => {});
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await rm(root, { recursive: true, force: true });
}
console.log("Task scaling passed: uncapped 12/13/14/30-task proposals, 20–30% margins, explicit extraction, revised approval/apply, and source-frozen count-only supplements");
