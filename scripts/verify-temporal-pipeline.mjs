import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Client, Connection } from '@temporalio/client';
import { fixtureProvider } from './fixture-provider.mjs';
import { coreWorkflowId } from '../dist/lib/durable-run.js';
import { readPatchMetadata } from '../dist/lib/patches.js';
import { loadApprovedTasks, taskFingerprint } from '../dist/lib/tasks.js';

// Real Core CLI + worker + local Temporal + Chrome DevTools MCP + JavaScript
// target, with a deterministic credential-free provider instead of a paid LLM.
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'webmcpify-temporal-pipeline-')));
const site = path.join(root, 'site');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const workerEntry = fileURLToPath(new URL('../dist/temporal/worker.js', import.meta.url));
const mcpClient = fileURLToPath(new URL('../dist/lib/mcp-stdio-client.js', import.meta.url));
const tasks = [
  { id: 'select', description: 'Select an item through the approved capability', requiredTools: ['select_item'], verify: 'document.body.dataset.selected === "true"' },
  { id: 'dismiss-selected', description: 'Select then dismiss an item', requiredTools: ['select_item', 'dismiss_item'], setup: 'Select an item first, then dismiss it.', verify: 'document.body.dataset.selected === undefined' },
  { id: 'dismiss-absent', description: 'Reject dismissing when no item is selected', requiredTools: ['dismiss_item'], expectedOutcome: 'rejection', expectedError: 'No selected item.', verify: 'document.body.dataset.selected === undefined' },
  { id: 'availability', description: 'Discover the live WebMCP capabilities', verify: 'Boolean(document.modelContext)' },
];
const originalSource = 'export function selectItem(){document.body.dataset.selected="true";}\nexport function dismissItem(){if(document.body.dataset.selected!=="true")throw new Error("No selected item.");delete document.body.dataset.selected;}\ndocument.querySelector("#select").addEventListener("click",selectItem);\ndocument.querySelector("#dismiss").addEventListener("click",dismissItem);\n';
const tools = ['select_item', 'dismiss_item'].map((name, index) => ({ id: name, name, title: name,
  description: index ? 'Dismiss the selected UI item' : 'Select a local UI item', parameters: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, untrustedContentHint: false, consequentialHint: false },
  security: { executionScope: 'ui-state', userAuthentication: 'none', agentIdentity: 'none', authorization: 'client-only', originScope: 'same-origin',
    rateLimit: { enforced: false, scope: 'agent-user-tool' }, idempotency: { enforced: false }, notes: 'Only local DOM state changes.' },
  implementation: { handler: `src/app.js#${index ? 'dismissItem' : 'selectItem'}`, action: index ? 'dismiss item' : 'select item', state: 'document.body.dataset.selected' },
  behavior: { success: 'Local selection changes.', preconditions: index ? ['An item is selected.'] : [], expectedFailures: index ? [{ condition: 'No item is selected.', error: 'No selected item.' }] : [] },
  placement: { strategy: 'imperative', file: 'src/webmcp.js', rationale: 'Reuse the existing UI handlers.' }, sourceFiles: ['src/app.js'] }));
const registration = 'import {selectItem,dismissItem} from "./app.js";\nconst context=document.modelContext;if(context){\ncontext.registerTool({name:"select_item",description:"Select item",inputSchema:{type:"object",properties:{}},execute:()=>{selectItem();return {selected:true};}});\ncontext.registerTool({name:"dismiss_item",description:"Dismiss item",inputSchema:{type:"object",properties:{}},execute:()=>{dismissItem();return {dismissed:true};}});\n}\n';
let server, occupied, service, worker, clientProcess, connection;
let workerOutput = '';
let passed = false;
async function port() {
  const probe = netServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const value = probe.address().port; await new Promise(resolve => probe.close(resolve)); return value;
}
async function until(operation, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child) {
  if (!child) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { await child.catch(() => {}); } finally { clearTimeout(timer); }
}
try {
  await mkdir(path.join(site, 'src'), { recursive: true });
  await writeFile(path.join(site, 'src/app.js'), originalSource);
  await writeFile(path.join(site, 'index.html'), '<!doctype html><body><button id="select">Select item</button><button id="dismiss">Dismiss item</button><script type="module" src="/src/app.js"></script></body>\n');
  await writeFile(path.join(site, '.gitignore'), '.webmcpify/\n');
  await writeFile(path.join(site, 'package.json'), JSON.stringify({ name: 'temporal-js-fixture', type: 'module', scripts: { build: 'node --check src/app.js && node --check src/webmcp.js' } }));
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Temporal Fixture'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.hooksPath', path.join(site, '.git/disabled-hooks')], ['add', '-A'], ['commit', '-qm', 'fixture baseline']]) await execa('git', args, { cwd: site });
  const provider = await fixtureProvider(root, 'provider', `
    import {readFileSync,writeFileSync,existsSync} from 'node:fs';
    import {connectStdioMcp} from ${JSON.stringify(mcpClient)};
    const prompt=process.argv.at(-1);
    const task=${JSON.stringify(tasks)}.find(task=>prompt.includes('"id": "'+task.id+'"'));
    if(existsSync('.webmcpify/tool-selection.json')){
      const selection=JSON.parse(readFileSync('.webmcpify/tool-selection.json','utf8'));
      const source=readFileSync('src/webmcp.js','utf8');
      const revised=source.split('\\n').filter(line=>!selection.rejectedNames.some(name=>line.includes('name:"'+name+'"'))).join('\\n');
      if(revised!==source)writeFileSync('src/webmcp.js',revised);
      const fence=String.fromCharCode(96).repeat(3);
      console.log(['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools:selection.selected}),fence,'TASKS_JSON',fence+'json',JSON.stringify(selection.reusableTasks),fence].join('\\n'));
    }else if(!task){
      let source=readFileSync('src/app.js','utf8');
      if(!source.includes("import './webmcp.js'"))source+="\\nimport './webmcp.js';\\n";
      writeFileSync('src/app.js',source);writeFileSync('src/webmcp.js',${JSON.stringify(registration)});
      const fence=String.fromCharCode(96).repeat(3);
      console.log(['TOOL_PROPOSALS_JSON',fence+'json',JSON.stringify({tools:${JSON.stringify(tools)}}),fence,'TASKS_JSON',fence+'json',JSON.stringify(${JSON.stringify(tasks)}),fence].join('\\n'));
    }else{
      const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp['chrome-devtools'];
      const client=await connectStdioMcp({command:config.command[0],args:config.command.slice(1)});
      const text=result=>(result.content??[]).filter(item=>item.type==='text').map(item=>item.text).join('\\n');
      try{
        if(prompt.includes('This is the plain baseline')){
          const marker=prompt.match(/window\\.name is ("[^"]+")/)[1];
          const pages=text(await client.call('list_pages'));
          let found=false;
          for(const match of pages.matchAll(/^(\\d+):/gm)){
            await client.call('select_page',{pageId:Number(match[1])});
            if(text(await client.call('evaluate_script',{function:'()=>window.name'})).includes(marker)){found=true;break;}
          }
          if(!found)throw new Error('Fixture baseline did not bind its isolated tab');
          const click=async label=>{
            const snapshot=text(await client.call('take_snapshot'));
            const row=snapshot.split('\\n').find(line=>line.includes('button "'+label+'"'));
            const uid=row?.match(/uid=([^ ]+)/)?.[1];if(!uid)throw new Error('Missing UI button');
            await client.call('click',{uid});
          };
          if(task.id==='select')await click('Select item');
          if(task.id==='dismiss-selected'){await click('Select item');await click('Dismiss item');}
          if(task.id==='dismiss-absent'){
            await click('Dismiss item');
            const messages=text(await client.call('list_console_messages'));
            if(!messages.includes('No selected item.'))throw new Error('UI rejection was not observed');
          }
        }else{
          await client.call('list_webmcp_tools');
          const call=async name=>{const result=await client.call('call_webmcp_tool',{toolName:name,input:'{}'});if(result.isError)throw new Error('Fixture WebMCP gateway failed');};
          if(task.id==='select')await call('select_item');
          if(task.id==='dismiss-selected'){await call('select_item');await call('dismiss_item');}
          if(task.id==='dismiss-absent')await call('dismiss_item');
        }
        console.log(JSON.stringify({type:'text',part:{text:task.id==='dismiss-absent'?'Observed No selected item. rejection.':'Observed task calls completed.'}}));
      }finally{await client.close();}
    }
  `);
  server = httpServer(async (request, response) => {
    try {
      const filename = new URL(request.url, 'http://fixture').pathname === '/' ? 'index.html' : new URL(request.url, 'http://fixture').pathname.slice(1);
      if (!['index.html', 'src/app.js', 'src/webmcp.js'].includes(filename)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/html');
      response.end(await readFile(path.join(site, filename)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  occupied = netServer(); await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const reviewPort = String(occupied.address().port);
  const address = `127.0.0.1:${await port()}`;
  service = execa(process.env.WEBMCPIFY_TEMPORAL_CLI ?? 'temporal', ['--disable-config-file', '--disable-config-env', 'server', 'start-dev', '--headless', '--ip', '127.0.0.1', '--port', address.split(':')[1], '--db-filename', path.join(root, 'temporal.sqlite')]);
  service.catch(() => {});
  connection = await until(async () => Connection.connect({ address, connectTimeout: '1 second' }), 'isolated Temporal service', 45_000);
  const env = { ...process.env, WEBMCPIFY_URL: 'http://127.0.0.1:1', WEBMCPIFY_TEMPORAL_ADDRESS: address, WEBMCPIFY_TEMPORAL_NAMESPACE: 'default', WEBMCPIFY_TEMPORAL_TLS: 'false', WEBMCPIFY_TEMPORAL_API_KEY: '', WEBMCPIFY_TEMPORAL_TASK_QUEUE: `pipeline-${path.basename(root)}`, WEBMCPIFY_OPENCODE_BIN: provider, WEBMCPIFY_PACKAGE_MANAGER: 'npm', WEBMCPIFY_CDP_URL: `http://127.0.0.1:${await port()}` };
  worker = execa(process.execPath, [workerEntry], { cwd: site, env, all: true }); worker.catch(() => {});
  worker.all.on('data', chunk => { workerOutput += chunk.toString(); });
  const workflowId = coreWorkflowId(site);
  clientProcess = execa(process.execPath, [cli, 'run', '--durable', '--baseline', '--path', site, '--url', url, '--provider', 'opencode', '--review-port', reviewPort, '--no-product-context-prompt'], { cwd: site, env, all: true }); clientProcess.catch(() => {});
  const client = new Client({ connection });
  const handle = client.workflow.getHandle(workflowId);
  const progress = await until(async () => { const progress = await handle.query('coreProgress'); return progress.reviewUrl && progress; }, 'real Core review page');
  const firstExecution = (await handle.describe()).runId;
  assert.notEqual(new URL(progress.reviewUrl).port, reviewPort, 'Review fallback must publish the actual bound port to the client');
  assert.equal(await readFile(path.join(site, 'src/app.js'), 'utf8'), originalSource, 'Generation/review must leave the target unchanged');
  const metadata = await readPatchMetadata(site);
  const duplicate = await execa(process.execPath, [cli, 'run', '--durable', '--path', site, '--url', url, '--provider', 'opencode', '--no-product-context-prompt'], { cwd: site, env, reject: false });
  assert.equal(duplicate.exitCode, 1); assert.match(duplicate.stderr, /already running/);
  assert.equal((await readPatchMetadata(site)).runId, metadata.runId, 'Duplicate launch must not invalidate a live draft');
  await stop(clientProcess);
  clientProcess = execa(process.execPath, [cli, 'run', '--durable', '--resume', workflowId, '--path', site], { cwd: site, env, all: true }); clientProcess.catch(() => {});
  const form = stage => { const form = new URLSearchParams({ stage, reviewRunId: metadata.runId, reviewPatchHash: metadata.patchHash, approveSourceDiff: 'yes' }); tools.forEach(tool => form.append('toolIds', tool.id)); return form; };
  const prepared = await fetch(`${progress.reviewUrl}/approve`, { method: 'POST', body: form('prepare') });
  const confirmation = await prepared.text(); assert.equal(prepared.status, 200, 'Preparing exact-source approval failed');
  const confirm = form('confirm'); confirm.set('confirmationToken', confirmation.match(/name="confirmationToken" value="([^"]+)"/)[1]);
  const approval = await fetch(`${progress.reviewUrl}/approve`, { method: 'POST', body: confirm }); assert.equal(approval.status, 200);
  const completed = await clientProcess;
  assert.match(completed.stdout, /4\/4 approved tasks verified through Temporal/);
  const result = await handle.result(); assert.equal(result.status, 'passed'); assert.equal(result.total, 4);
  const evaluation = JSON.parse(await readFile(result.evaluationPath, 'utf8'));
  assert.equal(evaluation.taskSetId, taskFingerprint(await loadApprovedTasks(site)));
  assert.equal(evaluation.scores.passed, 4);
  const baseline = JSON.parse(await readFile(result.baselinePath, 'utf8'));
  assert.equal(baseline.mode, 'baseline'); assert.equal(baseline.readOnly, true); assert.equal(baseline.scores.total, 4);
  assert.equal(baseline.agentError, undefined, 'Real native UI baseline provider must execute without infrastructure errors');
  assert.ok(baseline.scores.passed < 4, 'WebMCP availability is correctly absent before apply');
  const repair = await execa(process.execPath, [cli, 'repair', '--durable', '--path', site, '--url', url, '--task', 'dismiss-absent', '--max-repairs', '0', '--provider', 'opencode'], { cwd: site, env });
  assert.match(repair.stdout, /"passed":true/);
  const resumed = await execa(process.execPath, [cli, 'run', '--durable', '--resume', workflowId, '--path', site], { cwd: site, env });
  assert.match(resumed.stdout, /4\/4 approved tasks verified/);
  assert.match(resumed.stdout, /saved result of a finished execution/);
  // A new durable draft can remove capabilities, revise source/tests, reopen
  // review, then bind apply to the revised ID rather than the initial draft.
  await writeFile(path.join(site, 'src/app.js'), originalSource);
  clientProcess = execa(process.execPath, [cli, 'run', '--durable', '--path', site, '--url', url, '--provider', 'opencode', '--review-port', reviewPort, '--no-product-context-prompt'], { cwd: site, env, all: true }); clientProcess.catch(() => {});
  const subsetProgress = await until(async () => { const progress = await client.workflow.getHandle(workflowId).query('coreProgress'); return progress.phase === 'review' && progress.reviewUrl && progress; }, 'second durable review');
  const initialSubset = await readPatchMetadata(site);
  const subsetForm = stage => new URLSearchParams({ stage, reviewRunId: initialSubset.runId, reviewPatchHash: initialSubset.patchHash, toolIds: 'select_item' });
  const revision = await fetch(`${subsetProgress.reviewUrl}/approve`, { method: 'POST', body: subsetForm('prepare') });
  assert.equal(revision.status, 202, 'Durable initial review must allow tool deselection instead of treating it as a repair');
  const revisionStatus = await until(async () => { const status = await (await fetch(`${subsetProgress.reviewUrl}/review-status`)).json(); return ['ready', 'error'].includes(status.state) && status; }, 'revised durable draft');
  assert.equal(revisionStatus.state, 'ready', 'Subset revision failed; inspect the fixture-owned private diagnostics');
  const revised = await readPatchMetadata(site); assert.notEqual(revised.runId, initialSubset.runId);
  const revisedForm = stage => new URLSearchParams({ stage, reviewRunId: revised.runId, reviewPatchHash: revised.patchHash, toolIds: 'select_item', approveSourceDiff: 'yes' });
  const subsetPrepare = await fetch(`${subsetProgress.reviewUrl}/approve`, { method: 'POST', body: revisedForm('prepare') });
  const subsetConfirm = revisedForm('confirm'); subsetConfirm.set('confirmationToken', (await subsetPrepare.text()).match(/name="confirmationToken" value="([^"]+)"/)[1]);
  assert.equal((await fetch(`${subsetProgress.reviewUrl}/approve`, { method: 'POST', body: subsetConfirm })).status, 200);
  assert.match((await clientProcess).stdout, /2\/2 approved tasks verified through Temporal/);
  assert.equal((await loadApprovedTasks(site)).length, 2);
  assert.doesNotMatch(await readFile(path.join(site, 'src/webmcp.js'), 'utf8'), /name:\s*["']dismiss_item["']/);
  const historical = await execa(process.execPath, [cli, 'run', '--durable', '--resume', workflowId, '--execution-id', firstExecution, '--path', site], { cwd: site, env });
  assert.match(historical.stdout, /4\/4 approved tasks verified/, 'An explicit execution ID must retain the original result after workflow ID reuse');
  assert.match(historical.stdout, /saved result of a finished execution/);
  await writeFile(path.join(site, 'src/app.js'), originalSource);
  clientProcess = execa(process.execPath, [cli, 'run', '--durable', '--path', site, '--url', url, '--provider', 'opencode', '--review-port', reviewPort, '--no-product-context-prompt'], { cwd: site, env, all: true }); clientProcess.catch(() => {});
  const rejectProgress = await until(async () => { const progress = await client.workflow.getHandle(workflowId).query('coreProgress'); return progress.phase === 'review' && progress.reviewUrl && progress; }, 'durable draft rejection');
  assert.equal((await fetch(`${rejectProgress.reviewUrl}/reject`, { method: 'POST' })).status, 200);
  assert.match((await clientProcess).stdout, /draft rejected; no patch was applied/);
  assert.equal(await readFile(path.join(site, 'src/app.js'), 'utf8'), originalSource);
  await writeFile(path.join(root, 'worker-output.txt'), workerOutput);
  console.log('Real Core Temporal pipeline passed: JavaScript discovery/generation, balanced security, occupied-port review, duplicate-run guard, disconnect/reattach, native UI baseline before exact-source apply/build, real Chrome WebMCP calls and expected rejection, durable task repair, completed-run reattach, subset source/task revision and rejected-draft safety');
  passed = true;
} catch (error) {
  await writeFile(path.join(root, 'fixture-failure.txt'), error instanceof Error ? `${error.name}: ${error.message}` : 'Fixture failed');
  await writeFile(path.join(root, 'worker-output.txt'), workerOutput);
  throw new Error(`Real Core Temporal pipeline fixture failed. Private test diagnostics: ${root}`);
} finally {
  await stop(clientProcess); await stop(worker); await connection?.close(); await stop(service);
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
  if (passed) await rm(root, { recursive: true, force: true });
}
