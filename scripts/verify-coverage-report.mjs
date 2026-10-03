import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeAgentWorkspace } from "../dist/lib/agent-workspace.js";
import { discoverProject } from "../dist/lib/discovery.js";
import { validateGenerationMetadata } from "../dist/lib/generation-metadata.js";
import { completeCapabilityCoverage, assessCapabilityCoverage } from "../dist/lib/capability-coverage.js";
import { extractAndValidateProposedTools } from "../dist/lib/tool-proposals.js";
import { extractTasksFromText } from "../dist/lib/tasks.js";
import { fixtureProvider } from "./fixture-provider.mjs";

// Only the metadata -> coverage handoff. No target build, browser, Temporal,
// real model call or review approval is needed to exercise these failures.
const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-coverage-report-"));
const environment = { ...process.env }, logs = [];
const logging = [console.log, console.warn, console.error];
const block = (label,value) => `${label}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const source = "export function login(){return true;}\nbutton.addEventListener('click', login);\n";
try {
  const provider = await fixtureProvider(root,"report-provider",`
import {readFileSync,writeFileSync,writeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const counter=process.env.FIXTURE_REPORT_COUNTER;
writeFileSync(counter,String(Number(readFileSync(counter,'utf8'))+1));
const prompt=process.argv.join(' '), mode=process.env.FIXTURE_REPORT_MODE;
const fence=String.fromCharCode(96).repeat(3);
if(prompt.includes('Return only a complete TASKS_JSON block')) {
  const tasks=JSON.parse(readFileSync('.webmcpify/valid-tasks.json','utf8'));
  writeSync(1,['TASKS_JSON',fence+'json',JSON.stringify(tasks),fence].join('\\n'));
} else {
  if(!prompt.includes('Correct only the capability report'))process.exit(9);
  const details=JSON.parse(readFileSync('.webmcpify/coverage-correction.json','utf8'));
  if(mode==='source-drift')writeFileSync('src/app.js','export const unauthorized=true;');
  if(mode==='git-drift')execFileSync('git',['commit','--allow-empty','-qm','unauthorized']);
  if(mode==='commentary'){writeSync(1,'The coverage report should now be complete.');process.exit(0);}
  const candidates=details.resolvedCandidates.map(candidate=>({candidateId:candidate.id,status:'existing',toolNames:[mode==='invented'?'PRIVATE_INVENTED_TOOL':'login'],reason:'The draft registers login from this same source handler.'}));
  writeSync(1,['CAPABILITY_COVERAGE_JSON',fence+'json',JSON.stringify({candidates}),fence].join('\\n'));
}
`);
  process.env.WEBMCPIFY_OPENCODE_BIN=provider;
  console.log=console.warn=console.error=(...args)=>logs.push(args.map(String).join(" "));
  for(const mode of ["plain-report","metadata-handoff","report-repair","commentary","invented","source-drift","git-drift"]){
    const workspace=path.join(root,mode);
    await mkdir(path.join(workspace,"src"),{recursive:true});
    await writeFile(path.join(workspace,"src/app.js"),source);
    await writeFile(path.join(workspace,"package.json"),JSON.stringify({name:"coverage-report-fixture",type:"module"}));
    await initializeAgentWorkspace(workspace);
    const discovery=await discoverProject(workspace);
    await mkdir(path.join(workspace,".webmcpify"),{recursive:true});
    await writeFile(path.join(workspace,".webmcpify/discovery.json"),JSON.stringify(discovery));
    const tool={id:"login",name:"login",title:"Log in",description:"Log into the local fixture",parameters:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},implementation:{handler:"src/app.js#login",action:"login"},behavior:{success:"Logged in",preconditions:[],expectedFailures:[]},placement:{strategy:"imperative",file:"src/app.js",rationale:"Alongside fixture handler"},sourceFiles:["src/app.js"]};
    const tasks=[{id:"login-success",description:"Log in and verify session",requiredTools:["login"],verify:"document.body.dataset.loggedIn === 'true'"},{id:"availability",description:"Verify WebMCP is available",requiredTools:[],verify:"Boolean(document.modelContext)"}];
    const reports=discovery.actionCandidates.map(candidate=>({candidateId:candidate.id,status:"existing",toolNames:["login"],reason:'The draft registers login from this source handler; {braces} and "quotes" are text.'}));
    const originalTasks=structuredClone(tasks);
    if(mode==="metadata-handoff")originalTasks[0].requiredTools=["PRIVATE_INVALID_TOOL"];
    const validReport=["plain-report","metadata-handoff"].includes(mode);
    const report=validReport?{candidates:reports}:{candidates:[{candidateId:"PRIVATE_STALE_ID",status:"existing",toolNames:["login"],reason:"A stale report ID needs correction to the actual inventory."}]};
    const draftPath=path.join(workspace,".webmcpify/original.json");
    await writeFile(draftPath,`${block("TOOL_PROPOSALS_JSON",{tools:[tool]})}\n${block("TASKS_JSON",originalTasks)}\nCAPABILITY_COVERAGE_JSON\n${JSON.stringify(report)}\nOther draft notes`);
    await writeFile(path.join(workspace,".webmcpify/valid-tasks.json"),JSON.stringify(tasks));
    process.env.FIXTURE_REPORT_MODE=mode;
    process.env.FIXTURE_REPORT_COUNTER=path.join(workspace,".webmcpify/counter");
    await writeFile(process.env.FIXTURE_REPORT_COUNTER,"0");
    const metadata=await validateGenerationMetadata({provider:"opencode",sitePath:workspace,workspace,draftPath,discovery});
    const complete=()=>completeCapabilityCoverage({provider:"opencode",sitePath:workspace,workspace,discovery,...metadata,originalDraftPath:draftPath});
    if(["plain-report","metadata-handoff","report-repair"].includes(mode)){
      const result=await complete();
      assert.equal(result.coverage.missing.length,0);
      assert.ok(result.coverage.entries.every(entry=>entry.status==="proposed"));
      const reviewed=await readFile(result.draftPath,"utf8");
      assert.deepEqual(extractAndValidateProposedTools(reviewed,discovery),metadata.tools);
      assert.deepEqual(extractTasksFromText(reviewed),tasks);
      assert.deepEqual(assessCapabilityCoverage(discovery,result.tools,reviewed).entries,result.coverage.entries,"Review must see the normalized, validated report");
      assert.equal(await readFile(path.join(workspace,"src/app.js"),"utf8"),source);
    }else await assert.rejects(complete(),/capability report could not be safely corrected/);
    assert.equal(Number(await readFile(process.env.FIXTURE_REPORT_COUNTER,"utf8")),mode==="plain-report"?0:1,"No extra source generation or repeated correction");
    await assert.rejects(readFile(path.join(workspace,".webmcpify/approved-tools.json")),{code:"ENOENT"});
  }
  assert.doesNotMatch(logs.join("\n"),/PRIVATE_STALE_ID|PRIVATE_INVENTED_TOOL|PRIVATE_INVALID_TOOL/);
}finally{
  [console.log,console.warn,console.error]=logging;
  for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];
  Object.assign(process.env,environment);
  await rm(root,{recursive:true,force:true});
}
console.log("Coverage handoff passed: plain JSON, retained draft tools, metadata correction, report-only repair, frozen source/tasks, invalid-output refusal");
