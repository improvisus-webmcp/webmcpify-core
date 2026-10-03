import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { runGenerate } from "../dist/commands/generate.js";
import { assessCapabilityCoverage } from "../dist/lib/capability-coverage.js";
import { inventoryActions } from "../dist/lib/action-inventory.js";
import { readPatchMetadata } from "../dist/lib/patches.js";
import { extractTasksFromText } from "../dist/lib/tasks.js";
import { fixtureProvider } from "./fixture-provider.mjs";

const handlers = ["addToCart", "removeFromCart", "updateCartQuantity", "checkout", "login", "logout", "clearNotice"];
const source = handlers.map(handler => `export function ${handler}(){document.body.dataset.action='${handler}';}`).join("\n") + "\n" + handlers.filter(handler => !["login", "logout"].includes(handler)).map(handler => `document.querySelector('#${handler}')?.addEventListener('click', ${handler});`).join("\n") + "\ndocument.querySelector('#session')?.addEventListener('click', true ? logout : login);\n";
const inventory = await inventoryActions("src/app.js", source);
assert.equal(inventory.candidates.filter(candidate => candidate.resolved).length, 7);
const discovery = {actionCandidates: inventory.candidates, existingWebMCP: [], discoveryWarnings: []};
const fakeTools = handlers.map(handler => ({name: handler, implementation:{handler:`src/app.js#${handler}`}, sourceFiles:["src/app.js"]}));
assert.equal(assessCapabilityCoverage(discovery, fakeTools, "").missing.length, 0);
const missing = assessCapabilityCoverage(discovery, fakeTools.filter(tool => tool.name !== "logout"), "");
assert.deepEqual(missing.missing.map(candidate => candidate.handler), ["logout"], "Login must never silently satisfy logout coverage");
const fence = "```";
const report = entries => `CAPABILITY_COVERAGE_JSON\n${fence}json\n${JSON.stringify({candidates:entries})}\n${fence}`;
const logout = inventory.candidates.find(candidate => candidate.handler === "logout");
assert.throws(() => assessCapabilityCoverage(discovery, fakeTools, report([{candidateId:logout.id,status:"skipped",reason:"Maximum six tools for this draft"}])), /count\/budget/);
assert.throws(() => assessCapabilityCoverage(discovery, fakeTools, report([{candidateId:logout.id,status:"proposed",toolNames:["missing"],reason:"This missing tool would invoke logout"}])), /actual proposed tools/);
assert.throws(() => assessCapabilityCoverage(discovery, fakeTools, report([{candidateId:"unknown",status:"skipped",reason:"A nonexistent private action"}])), /unknown/);
assert.throws(() => assessCapabilityCoverage(discovery, fakeTools, report([{candidateId:logout.id,status:"existing",reason:"Registered in the source already"}])), /source evidence/);
const retained = [{candidateId:logout.id,status:"existing",toolNames:["logout"],reason:"The previous draft already registered this source-backed logout tool."}];
const normalized = assessCapabilityCoverage(discovery, fakeTools, report(retained));
assert.equal(normalized.missing.length, 0);
assert.equal(normalized.entries.find(entry=>entry.candidateId===logout.id).status,"proposed");
assert.equal(assessCapabilityCoverage(discovery, fakeTools, `CAPABILITY_COVERAGE_JSON\n${JSON.stringify({candidates:retained})}\nOther notes`).missing.length,0,"A plain JSON report must not be ignored");
assert.equal(assessCapabilityCoverage(discovery, fakeTools, report([{...retained[0],reason:'Registered logout; braces { and escaped "quotes" are plain text.'}])).missing.length,0);
assert.throws(()=>assessCapabilityCoverage(discovery,fakeTools,report([{...retained[0],toolNames:["invented"]}])),/actual proposed tools/);
const unresolved = {id:"unresolved-hint",file:"src/app.js",handler:"helper",resolved:false};
assert.equal(assessCapabilityCoverage({...discovery,actionCandidates:[...inventory.candidates,unresolved]},fakeTools,report([...retained,{candidateId:unresolved.id,status:"existing",toolNames:["invented"],reason:"Inspection hint only"}])).entries.length,7,"Unresolved hints cannot satisfy or invalidate resolved coverage");
assert.throws(()=>assessCapabilityCoverage(discovery,fakeTools,"CAPABILITY_COVERAGE_JSON\n{\"candidates\":["),/incomplete/);
assert.throws(()=>assessCapabilityCoverage(discovery,fakeTools,report([retained[0],retained[0]])),/duplicate/);
assert.equal(assessCapabilityCoverage(discovery, fakeTools.slice(0,-1), report([{candidateId:inventory.candidates.find(candidate=>candidate.handler==='clearNotice').id,status:"skipped",reason:"Dismisses decorative feedback only; intentionally not exposed as an agent capability."}])).missing.length, 0);
const ignored = await inventoryActions("src/webmcp.js", "document.modelContext.registerTool({name:'x',execute:()=>set({x:1})});");
assert.deepEqual(ignored.candidates, [], "Generated execute wrappers must not become new application actions");
const dynamic = await inventoryActions("src/app.js", "button.addEventListener('click',()=>store[action]());");
assert.deepEqual(dynamic.candidates, [], "Dynamic property keys are not known handler names");
if (process.argv.includes("--unit-only")) {
  console.log("Coverage report checks passed: fenced/plain JSON, draft-existing normalization, unresolved hints and invalid mapping refusal");
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-capability-coverage-"));
const previousEnv = {...process.env};
const terminal = [];
const previousLogs = {log:console.log,warn:console.warn,error:console.error};
try {
  const provider = await fixtureProvider(root, "provider", `
import {readFileSync,writeFileSync,writeSync} from 'node:fs';
const count=Number(readFileSync(process.env.FIXTURE_COUNTER,'utf8'))+1;writeFileSync(process.env.FIXTURE_COUNTER,String(count));
const mode=process.env.FIXTURE_MODE;
const handlers=${JSON.stringify(handlers)};
const omission=mode.startsWith('omission');
const selected=omission?handlers.filter(h=>h!=='clearNotice'):(count===1&&mode!=='already-complete')||mode==='incomplete'?handlers.filter(h=>h!=='logout'):mode==='drop-tool'?handlers.filter(h=>h!=='removeFromCart'):handlers;
const tools=selected.map(handler=>({id:handler,name:handler,title:handler,description:'Run the existing '+handler+' local UI action',parameters:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},security:{executionScope:'ui-state',userAuthentication:'none',agentIdentity:'none',authorization:'client-only',originScope:'same-origin',rateLimit:{enforced:false,scope:'agent-user-tool'},idempotency:{enforced:false},notes:'Only local document state changes.'},implementation:{handler:'src/app.js#'+handler,action:'update local action state',state:'document.body.dataset.action'},behavior:{success:'Local action state updated',preconditions:[],expectedFailures:[]},placement:{strategy:'imperative',file:'src/webmcp.js',rationale:'Registered through the loaded entry integration'},sourceFiles:['src/app.js']}));
if(count===2&&mode==='contract-drift')tools[0].description='PRIVATE_CONTRACT_DRIFT';
if(count===1)writeFileSync('src/app.js',readFileSync('src/app.js','utf8')+"\\nimport './webmcp.js';\\n");
if(mode!=='text-only'||count===1)writeFileSync('src/webmcp.js',"import * as actions from './app.js';const context=document.modelContext;if(context){\\n"+tools.map(tool=>"context.registerTool({name:"+JSON.stringify(tool.name)+",description:'Local UI action',inputSchema:{type:'object',properties:{}},execute:()=>{actions."+tool.name+"();return {};}});").join('\\n')+'\\n}');
if(mode==='git-drift'&&count===2){const {execFileSync}=await import('node:child_process');execFileSync('git',['add','src']);execFileSync('git',['commit','-qm','PRIVATE_IDENTITY_DRIFT']);}
const tasks=tools.map(tool=>({id:tool.id+'_success',description:'Invoke '+tool.name+' and verify its local state',requiredTools:[tool.name],verify:'document.body.dataset.action === '+JSON.stringify(tool.name)}));
tasks.push({id:'availability',description:'Check all declared tools are registered',requiredTools:tools.map(tool=>tool.name),setup:'Load the fixture page and inspect its tool registry without changing application state',verify:JSON.stringify(tools.map(tool=>tool.name))+'.every(name=>document.modelContext.getTools().some(tool=>tool.name===name))'});
tasks.push({id:'repeat_add',description:'Repeat addToCart and verify the supported idempotent local fixture action',requiredTools:['addToCart'],setup:'Invoke addToCart once before repeating it',verify:'document.body.dataset.action === "addToCart"'});
if(tools.length===7)tasks.push({id:'session_roundtrip',description:'Login then logout and verify the final session action',requiredTools:['login','logout'],setup:'Invoke login first',verify:'document.body.dataset.action === "logout"'});
if(mode==='omission-metadata-fix'&&count===1)tasks[0].requiredTools=['PRIVATE_INVALID_METADATA'];
const fence=String.fromCharCode(96).repeat(3);
writeSync(1,['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools}),fence,'TASKS_JSON',fence+'json',JSON.stringify(tasks),fence].join('\\n'));
if(omission&&count===1){const discovery=JSON.parse(readFileSync('.webmcpify/discovery.json','utf8'));const candidate=discovery.actionCandidates.find(c=>c.handler==='clearNotice'&&c.resolved);writeSync(1,'\\nCAPABILITY_COVERAGE_JSON\\n'+fence+'json\\n'+JSON.stringify({candidates:[{candidateId:candidate.id,status:'skipped',reason:'Dismisses decorative feedback only; intentionally not exposed as an agent capability.'}]})+'\\n'+fence);}
`);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
  for (const method of Object.keys(previousLogs)) console[method] = (...values) => terminal.push(values.join(" "));
  for (const mode of ["complete", "already-complete", "omission", "omission-metadata-fix", "incomplete", "contract-drift", "drop-tool", "text-only", "git-drift"]) {
    const site=path.join(root,mode);
    await mkdir(path.join(site,"src"),{recursive:true});
    await writeFile(path.join(site,"src/app.js"),source);
    await writeFile(path.join(site,"index.html"),"<button id='session'>Session</button>");
    await writeFile(path.join(site,"package.json"),JSON.stringify({name:"coffee-coverage-fixture",type:"module",scripts:{build:"node --check src/app.js && node --check src/webmcp.js"}}));
    await writeFile(path.join(site,".gitignore"),".webmcpify/\nnode_modules/\n");
    for(const args of [["init","-q"],["config","user.name","Fixture"],["config","user.email","fixture@example.invalid"],["add","-A"],["commit","-qm","baseline"]])await execa("git",args,{cwd:site});
    process.env.FIXTURE_MODE=mode;
    process.env.FIXTURE_COUNTER=path.join(root,mode+"-counter");
    await writeFile(process.env.FIXTURE_COUNTER,"0");
    // These synthetic handlers only test coverage; security policies are
    // exercised independently, including refusal of misleading checkout labels.
    const generate=()=>runGenerate({path:site,provider:"opencode",productContextPrompt:false,security:"ignore"});
    if(["complete","already-complete","omission","omission-metadata-fix"].includes(mode)) {
      await generate();
      const proposed=JSON.parse(await readFile(path.join(site,".webmcpify/proposed-tools.json"),"utf8"));
      assert.deepEqual(proposed.tools.map(tool=>tool.name),mode.startsWith('omission')?handlers.filter(handler=>handler!=='clearNotice'):handlers,"Source-backed actions must reach review unless explicitly omitted");
      const metadata=await readPatchMetadata(site);
      const draft=await readFile(metadata.generationTrajectory,"utf8");
      const tasks=extractTasksFromText(draft);
      assert.equal(tasks.length,mode.startsWith('omission')?8:10,"Tasks scale with the actual tool count, without a six-test ceiling");
      if(mode.startsWith('omission'))assert.match(draft,/Dismisses decorative feedback only/,"Reviewed draft must retain explicit omission reasons after metadata correction");
      assert.ok(tasks.some(task=>task.requiredTools.includes("logout")));
    } else {
      await assert.rejects(generate(),/capabilities could not be fully accounted/);
      await assert.rejects(readFile(path.join(site,".webmcpify/pending-diff.meta.json")),{code:"ENOENT"});
    }
    assert.equal(await readFile(process.env.FIXTURE_COUNTER,"utf8"),['already-complete','omission'].includes(mode)?'1':'2',"Completion must be bounded and skipped for fully accounted drafts");
    assert.equal(await readFile(path.join(site,"src/app.js"),"utf8"),source,"No target edits before approval");
    await assert.rejects(readFile(path.join(site,"src/webmcp.js")),{code:"ENOENT"});
    await assert.rejects(readFile(path.join(site,".webmcpify/approved-tools.json")),{code:"ENOENT"});
  }
  assert.doesNotMatch(terminal.join("\n"),/PRIVATE_CONTRACT_DRIFT|PRIVATE_IDENTITY_DRIFT|PRIVATE_INVALID_METADATA/);
} finally {
  Object.assign(console,previousLogs);
  for(const key of Object.keys(process.env))if(!(key in previousEnv))delete process.env[key];
  Object.assign(process.env,previousEnv);
  await rm(root,{recursive:true,force:true});
}
console.log("Capability coverage passed: seven distinct actions including login/logout, ten tests, bounded completion, immutable existing contracts, omission evidence, and unchanged target source");
await import("./verify-coverage-report.mjs");
