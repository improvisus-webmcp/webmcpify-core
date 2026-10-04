import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { fixtureProvider } from "./fixture-provider.mjs";
import { runGenerate } from "../dist/commands/generate.js";
import { loadGenerationMetadata } from "../dist/lib/generation-source.js";
import { loadDiscovery, validateProposedTools } from "../dist/lib/tool-proposals.js";
import { readPatchMetadata } from "../dist/lib/patches.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-metadata-passes-"));
const originalEnv = { ...process.env };
const originalLogs = { log: console.log, warn: console.warn, error: console.error };
const logs = [];
try {
  const calls = path.join(root, "calls");
  const provider = await fixtureProvider(root, "provider", `
import {appendFileSync,readFileSync,writeFileSync,writeSync} from 'node:fs';
const args=process.argv.slice(2),prompt=args.at(-1);
if(args.includes('--output-schema'))throw new Error('No combined response schema is allowed');
const toolsPass=prompt.includes('Return only TOOL_PROPOSALS_JSON');
const tasksPass=prompt.includes('Return only TASKS_JSON');
const stage=toolsPass?'tools':tasksPass?'tasks':'source';
appendFileSync(${JSON.stringify(calls)},stage+'\\n');
if(process.env.METADATA_FIXTURE_MODE===stage+'-fail'){process.stderr.write('PRIVATE_PROVIDER_DIAGNOSTICS');process.exit(7);}
if(stage==='source'){
 writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+"\\nimport './webmcp.js';\\n");
 writeFileSync('src/webmcp.js',"import {selectItem} from './app.js';const context=document.modelContext;if(context){const controller=new AbortController();context.registerTool({name:'select_item',title:'Select item',description:'Select item',inputSchema:{type:'object',properties:{}},execute:()=>{selectItem();return {selected:true};}},{signal:controller.signal});}\\n");
 writeSync(1,'Source integration completed.');process.exit(0);
}
if(!readFileSync('src/webmcp.js','utf8').includes('select_item'))throw new Error('Saved source was not restored');
if(process.env.METADATA_FIXTURE_MODE==='source-drift')writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+'// forbidden edit\\n');
const tool={id:'select_item',name:'select_item',title:'Select item',description:'Select item in local UI state',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Only local UI state'},implementation:{handler:'src/app.js#selectItem',action:'select item',state:'document.body.dataset.selected'},behavior:{success:'Item selected',preconditions:[],expectedFailures:[]},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Loaded from the real entry'},sourceFiles:['src/app.js']};
const fence=String.fromCharCode(96).repeat(3);
if(toolsPass){
 if(prompt.includes('Each task must declare expectedOutcome'))throw new Error('Tools pass contains task authoring instructions');
 writeSync(1,'TOOL_PROPOSALS_JSON\\n'+fence+'json\\n'+JSON.stringify({tools:[tool]})+'\\n'+fence);
}else{
 const retained=JSON.parse(readFileSync('.webmcpify/generated-tools.json','utf8')).tools;
 if(retained[0].name!=='select_item')throw new Error('Tool handoff failed');
 const tasks=Array.from({length:2},(_,i)=>({id:'select_'+i,description:'Select item and inspect local state',requiredTools:['select_item'],verify:'document.body.dataset.selected === "true"'}));
 writeSync(1,'TASKS_JSON\\n'+fence+'json\\n'+JSON.stringify(tasks)+'\\n'+fence);
 const candidates=JSON.parse(readFileSync('.webmcpify/discovery.json','utf8')).actionCandidates.filter(candidate=>candidate.resolved);
 writeSync(1,'\\nCAPABILITY_COVERAGE_JSON\\n'+fence+'json\\n'+JSON.stringify({candidates:candidates.map(candidate=>({candidateId:candidate.id,status:'proposed',toolNames:['select_item'],reason:'src/app.js#selectItem selects the item in local UI state'}))})+'\\n'+fence);
}
`);
  process.env.WEBMCPIFY_CODEX_BIN = provider;
  const site = path.join(root, "site");
  await mkdir(path.join(site, "src"), { recursive: true });
  await mkdir(path.join(site, ".webmcpify"));
  const source = "export function selectItem(){document.body.dataset.selected='true';}\ndocument.querySelector('button')?.addEventListener('click',selectItem);\n";
  await writeFile(path.join(site, "src/app.js"), source);
  await writeFile(path.join(site, "package.json"), JSON.stringify({ type: "module", scripts: { build: "node -e \"process.exit(97)\"" } }));
  await writeFile(path.join(site, ".gitignore"), ".webmcpify/\n");
  const preserved = ["approved-tools.json", "proposed-tools.json", "security-report.json", "pending-diff.patch", "pending-diff.meta.json", "discovery.json"];
  for (const file of preserved) await writeFile(path.join(site, ".webmcpify", file), "existing state\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: site });
  for (const key of Object.keys(originalLogs)) console[key] = (...args) => logs.push(args.map(String).join(" "));
  const opts = { path: site, provider: "codex", productContextPrompt: false };
  await assert.rejects(runGenerate({ ...opts, diagnosticMetadataOnly: true }), /No saved source checkpoint/);
  await runGenerate({ ...opts, diagnosticSourceOnly: true });
  const saved = await readFile(path.join(site, ".webmcpify/generation-source.json"), "utf8");
  await runGenerate({ ...opts, diagnosticMetadataOnly: true });
  assert.equal(await readFile(calls, "utf8"), "source\ntools\ntasks\n");
  const trajectories = path.join(site, ".webmcpify/trajectories");
  const completed = (await readdir(trajectories)).find(file => /^generate-metadata-\d.*\.json$/.test(file) && !file.endsWith('.meta.json'));
  const sourceTrajectory = JSON.parse(saved).sourceTrajectory;
  const resumed = await loadGenerationMetadata(site, path.join(trajectories, completed), sourceTrajectory);
  assert.match(await readFile(resumed, "utf8"), /TOOL_PROPOSALS_JSON.*TASKS_JSON/);
  assert.equal(await readFile(calls, "utf8"), "source\ntools\ntasks\n", "Loading completed metadata must not invoke a provider");
  await assert.rejects(loadGenerationMetadata(site, path.join(root, "outside.json"), sourceTrajectory), /complete metadata/);
  await assert.rejects(loadGenerationMetadata(site, path.join(trajectories, completed), sourceTrajectory + '.different'), /does not belong/);
  for (const mode of ["tools-fail", "tasks-fail", "source-drift", "ok"]) {
    process.env.METADATA_FIXTURE_MODE = mode;
    const retry = () => runGenerate({ ...opts, diagnosticMetadataOnly: true });
    if (mode === "ok") await retry();
    else await assert.rejects(retry(), /metadata could not be safely authored/);
    assert.equal(await readFile(path.join(site, ".webmcpify/generation-source.json"), "utf8"), saved, "Retry must preserve the checkpoint even after failure");
    assert.equal(await readFile(path.join(site, "src/app.js"), "utf8"), source);
  }
  assert.equal((await readFile(calls, "utf8")).split("\n").filter(stage => stage === "source").length, 1, "Metadata retries must never repeat source generation");
  for (const file of preserved) assert.equal(await readFile(path.join(site, ".webmcpify", file), "utf8"), "existing state\n");
  await assert.rejects(readFile(path.join(site, "src/webmcp.js")), { code: "ENOENT" });
  const before = await readFile(calls, "utf8");
  await writeFile(path.join(site, "src/app.js"), source + "// owner edit\n");
  await assert.rejects(runGenerate({ ...opts, diagnosticMetadataOnly: true }), /Target source changed/);
  assert.equal(await readFile(calls, "utf8"), before, "Stale checkpoints fail before a provider call");
  // Diagnostics must remain private, but a completed continuation must publish
  // the checkpoint discovery that review uses to validate the pending tools.
  const continuedSite = path.join(root, "continuation");
  await mkdir(path.join(continuedSite, "src"), { recursive: true });
  await writeFile(path.join(continuedSite, "src/app.js"), source);
  await writeFile(path.join(continuedSite, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(continuedSite, ".gitignore"), ".webmcpify/\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-qm", "baseline"]]) await execa("git", args, { cwd: continuedSite });
  process.env.METADATA_FIXTURE_MODE = "ok";
  const continuedOpts = { ...opts, path: continuedSite };
  await runGenerate({ ...continuedOpts, diagnosticSourceOnly: true });
  await runGenerate({ ...continuedOpts, diagnosticMetadataOnly: true });
  await assert.rejects(readFile(path.join(continuedSite, ".webmcpify/discovery.json")), { code: "ENOENT" });
  const continuedTrajectories = path.join(continuedSite, ".webmcpify/trajectories");
  const completedMetadata = (await readdir(continuedTrajectories)).find(file => /^generate-metadata-\d.*\.json$/.test(file) && !file.endsWith(".meta.json"));
  const callsBeforeContinuation = await readFile(calls, "utf8");
  await runGenerate({ ...continuedOpts, continueFromMetadata: path.join(continuedTrajectories, completedMetadata) });
  assert.equal(await readFile(calls, "utf8"), callsBeforeContinuation, "Continuation must not regenerate source or metadata");
  const continuedDiscovery = await loadDiscovery(continuedSite);
  const continuedCheckpoint = JSON.parse(await readFile(path.join(continuedSite, ".webmcpify/generation-source.json"), "utf8"));
  assert.deepEqual(continuedDiscovery, continuedCheckpoint.discovery, "Review must receive the exact checkpoint inventory");
  const proposals = JSON.parse(await readFile(path.join(continuedSite, ".webmcpify/proposed-tools.json"), "utf8"));
  assert.equal(validateProposedTools(proposals, continuedDiscovery).length, 1);
  assert.equal((await readPatchMetadata(continuedSite)).patchStatus, "awaiting-review");
  await assert.rejects(readFile(path.join(continuedSite, ".webmcpify/approved-tools.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(continuedSite, "src/app.js"), "utf8"), source);
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_PROVIDER_DIAGNOSTICS|forbidden edit/);
} finally {
  Object.assign(console, originalLogs);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(root, { recursive: true, force: true });
}
console.log("Metadata passes passed: separate tools/tasks, no response schema, source checkpoint reuse, failure retry, source freeze, stale checkpoint refusal, no target or approval changes.");
