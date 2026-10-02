import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixtureProvider } from "./fixture-provider.mjs";
import { EventEmitter } from "node:events";
import { connectStdioMcp } from "../dist/lib/mcp-stdio-client.js";
import { connectChromeWebMcp, webMcpExecutionResult } from "../dist/lib/webmcp-task-bridge.js";
import { observeWebMcpExecution } from "../dist/lib/webmcp-observer.js";
import { requiredToolsObserved, expectedRejectionObserved, scoreTask } from "../dist/lib/scoring.js";
import { runAgent } from "../dist/lib/agent.js";
import { taskOutcomeInstruction } from "../dist/commands/test.js";
import { selectFailedTasks } from "../dist/commands/repair.js";
import { validateTasks, validateToolScaledTasks, taskVerificationIssues } from "../dist/lib/tasks.js";
import { withOperationSignal } from "../dist/lib/operation-context.js";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-webmcp-execution-"));
let connection;
let bridge;
let adapter;
let slowClient;
const previousCodex = process.env.WEBMCPIFY_CODEX_BIN;
const evidence = calls => ({ source: "chrome-devtools-mcp", pageId: 7, discovered: true, calls, policyViolations: [] });
const task = { id: "clear", description: "Clear populated comparison", requiredTools: ["select", "clear"], setup: "Select first, then clear", verify: "document.body.dataset.empty === 'true'" };
const negative = { id: "remove-absent", description: "Remove an absent item", requiredTools: ["remove"], expectedOutcome: "rejection", expectedError: "Item is not in the cart.", verify: "!Object.hasOwn(JSON.parse(localStorage.getItem('fixture-store') ?? '{}')?.state?.cart ?? {}, 'coffee')" };
try {
  assert.equal(requiredToolsObserved(task, "Required tools not executed: select clear"), false);
  assert.equal(requiredToolsObserved(task, { response: "Called select and clear" }), false, "Final claims never count as call records");
  assert.equal(requiredToolsObserved(task, evidence([{ toolName: "clear", status: "success" }, { toolName: "select", status: "success" }])), false, "Required setup/action order must hold");
  assert.equal(requiredToolsObserved(task, evidence([{ toolName: "select", status: "success" }, { toolName: "clear", status: "error" }])), false);
  assert.equal(requiredToolsObserved(task, evidence([{ toolName: "select", status: "success" }, { toolName: "clear", status: "success" }])), true);
  assert.equal(expectedRejectionObserved(negative, "remove: Item is not in the cart."), false);
  assert.equal(expectedRejectionObserved(negative, evidence([{ toolName: "remove", status: "error", error: "Network unavailable" }])), false);
  assert.equal(expectedRejectionObserved(negative, evidence([{ toolName: "remove", status: "error", error: negative.expectedError }])), true);
  assert.equal(expectedRejectionObserved(negative, evidence([{ toolName: "remove", status: "error", error: negative.expectedError }, { toolName: "remove", status: "success" }])), false, "An eventual successful retry cannot count as the approved rejection");
  assert.equal(expectedRejectionObserved(negative, evidence([{ toolName: "remove", status: "error", error: negative.expectedError }, { toolName: "remove", status: "error", error: negative.expectedError }])), false, "Make one primary rejection attempt, not repeated failures");
  let evaluated = false;
  const emptyPage = { evaluate: async () => { evaluated = true; return true; } };
  assert.equal((await scoreTask("http://localhost/", task, { page: emptyPage, agentOutput: "Not executed: select, clear", requireToolEvidence: true })).passed, false);
  assert.equal(evaluated, false, "An initially-true postcondition cannot hide missing execution");
  assert.equal((await scoreTask("http://localhost/", task, { page: emptyPage, toolEvidence: { ...evidence([]), infrastructureError: "Unavailable browser" }, requireToolEvidence: true })).failureKind, "infrastructure");
  const pendingPage = { evaluate: () => new Promise(() => {}) };
  const started = Date.now();
  const timeout = await scoreTask("http://localhost/", task, { page: pendingPage, verificationTimeoutMs: 30 });
  assert.equal(timeout.passed, false);
  assert.equal(timeout.failureKind, "verification");
  assert.match(timeout.detail, /timed out/);
  assert.ok(Date.now() - started < 1_000, "An unresolved verification promise cannot hang the audit");
  const cancelled = new AbortController();
  const cancellationTimer = setTimeout(() => cancelled.abort(), 20);
  try {
    const result = await withOperationSignal(cancelled.signal, () => scoreTask("http://localhost/", task, { page: pendingPage }));
    assert.equal(result.failureKind, "infrastructure");
    assert.match(result.detail, /cancelled/);
  } finally { clearTimeout(cancellationTimer); }
  const falseResult = await scoreTask("http://localhost/", task, { page: { evaluate: async () => false }, verificationTimeoutMs: 40 });
  assert.equal(falseResult.failureKind, "postcondition", "A normal false postcondition is not a verifier exception");
  let reads = 0;
  const lateMutation = await scoreTask("http://localhost/", negative, {
    page: { evaluate: async () => ++reads === 1 }, requireToolEvidence: true,
    toolEvidence: evidence([{ toolName: "remove", status: "error", error: negative.expectedError }]),
  });
  assert.equal(lateMutation.passed, false, "A guard error cannot hide a later forbidden state change");
  assert.equal(lateMutation.failureKind, "postcondition");
  assert.equal(Function("localStorage", `return (${negative.verify})`)({ getItem: () => null }), true);
  const unsafe = { ...negative, verify: "JSON.parse(localStorage.getItem('fixture-store')).state.cart.coffee === undefined" };
  assert.ok(taskVerificationIssues(unsafe).some(issue => issue.code === "storage-null"));
  assert.doesNotThrow(() => validateTasks([unsafe]), "Existing approved task identity remains readable; do not rewrite it silently");
  assert.throws(() => validateToolScaledTasks([unsafe, { ...unsafe, id: "second" }], [{ name: "remove", expectedFailures: [{ condition: "Absent", error: negative.expectedError }] }]), /unsafe empty-storage/);
  assert.match(taskOutcomeInstruction({ ...negative, setup: "Select three items before rejecting a fourth" }), /successful calls with different inputs/);
  assert.throws(() => selectFailedTasks({ scores: { results: [{ task: "clear", passed: false, failureKind: "infrastructure" }] } }), /not a proven application defect/);
  assert.throws(() => selectFailedTasks({ scores: { results: [{ task: "clear", passed: false, failureKind: "verification" }] } }), /invalid\/timed-out verification/);
  assert.equal(webMcpExecutionResult({ isError: true, content: [{ type: "text", text: negative.expectedError }] }), undefined);
  assert.equal(webMcpExecutionResult({ content: [{ type: "text", text: '{"status":"cancelled"}' }] }), undefined);
  assert.equal(webMcpExecutionResult({ content: [{ type: "text", text: '{"status":"Canceled","errorText":"Item is not in the cart."}' }] }), undefined);
  assert.deepEqual(webMcpExecutionResult({ content: [{ type: "text", text: '{"status":"Completed","output":{"added":"coffee"}}' }] }), { status: "success" });
  assert.deepEqual(webMcpExecutionResult({ structuredContent: { status: "Error", errorText: negative.expectedError } }), { status: "error", error: negative.expectedError });
  assert.deepEqual(webMcpExecutionResult({ structuredContent: { status: "Error", errorText: "" } }, negative.expectedError), { status: "error", error: negative.expectedError });
  assert.equal(webMcpExecutionResult({ isError: true, structuredContent: { status: "Error" } }, negative.expectedError), undefined, "A protocol error cannot borrow an observed business exception");
  assert.equal(webMcpExecutionResult({ structuredContent: { status: "Canceled" } }, negative.expectedError), undefined);
  assert.deepEqual(webMcpExecutionResult({ structuredContent: { status: "Completed", output: { isError: true, content: [{ type: "text", text: negative.expectedError }] } } }), { status: "error", error: negative.expectedError });
  assert.deepEqual(webMcpExecutionResult({ structuredContent: { status: "Completed", output: JSON.stringify({ ok: false, error: { message: negative.expectedError } }) } }), { status: "error", error: negative.expectedError });
  assert.equal(webMcpExecutionResult({ structuredContent: { status: "Completed", output: { isError: true } } }), undefined);

  const cdp = new EventEmitter();
  let detached = false;
  cdp.send = async () => ({});
  cdp.detach = async () => { detached = true; };
  const observer = await observeWebMcpExecution({ context: () => ({ newCDPSession: async () => cdp }) }, "remove", '{"id":"coffee"}');
  cdp.emit("WebMCP.toolResponded", { invocationId: "unrelated", status: "Error", exception: { description: negative.expectedError } });
  assert.equal(observer.error(), undefined);
  cdp.emit("WebMCP.toolInvoked", { toolName: "remove", invocationId: "wrong-input", input: '{"id":"other"}' });
  cdp.emit("WebMCP.toolResponded", { invocationId: "wrong-input", status: "Error", errorText: negative.expectedError });
  assert.equal(observer.error(), undefined, "Another invocation/input cannot supply a business error");
  cdp.emit("WebMCP.toolInvoked", { toolName: "remove", invocationId: "matched", input: '{"id":"coffee"}' });
  cdp.emit("WebMCP.toolResponded", { invocationId: "matched", status: "Canceled", exception: { description: negative.expectedError } });
  assert.equal(observer.error(), undefined);
  cdp.emit("WebMCP.toolResponded", { invocationId: "matched", status: "Error", exception: { description: negative.expectedError + "\nprivate stack" } });
  assert.equal(observer.error(), negative.expectedError);
  cdp.emit("WebMCP.toolInvoked", { toolName: "remove", invocationId: "duplicate", input: '{"id":"coffee"}' });
  assert.equal(observer.error(), undefined, "Ambiguous duplicate calls fail closed");
  await observer.close();
  assert.equal(detached, true);
  const delayedObserver = await observeWebMcpExecution({ context: () => ({ newCDPSession: async () => cdp }) }, "remove", '{"id":"coffee"}');
  cdp.emit("WebMCP.toolInvoked", { toolName: "remove", invocationId: "delayed", input: '{"id":"coffee"}' });
  const delayedEvent = setTimeout(() => cdp.emit("WebMCP.toolResponded", { invocationId: "delayed", status: "Error", exception: { description: negative.expectedError } }), 30);
  try { assert.equal(await delayedObserver.waitForError(), negative.expectedError, "Separate CDP connections may deliver the exception after the MCP response"); }
  finally { clearTimeout(delayedEvent); await delayedObserver.close(); }
  assert.deepEqual(webMcpExecutionResult({ content: [{ type: "text", text: '## execute_webmcp_tool\n{"status":"error","errorText":"Item is not in the cart."}' }] }), { status: "error", error: negative.expectedError });

  const fakeMcp = await fixtureProvider(root, "chrome-mcp", `
import {createInterface} from 'node:readline';
const methods=['list_pages','select_page','evaluate_script','list_webmcp_tools','execute_webmcp_tool'];
for await (const line of createInterface({input:process.stdin})) {
  const r=JSON.parse(line);if(r.id===undefined)continue;let result;
  if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fake-chrome',version:'1'}};
  else if(r.method==='tools/list')result={tools:methods.map(name=>({name,inputSchema:{type:'object',properties:{}}}))};
  else if(r.method==='tools/call') {
    const n=r.params.name,a=r.params.arguments;
    if(n==='list_pages')result={structuredContent:{pages:[{id:7,url:'http://localhost:5173/'}]},content:[]};
    else if(n==='evaluate_script')result={content:[{type:'text',text:JSON.stringify('test-marker')}]};
    else if(n==='execute_webmcp_tool')result={content:[{type:'text',text:JSON.stringify(a.toolName==='remove'?{status:'error',errorText:'Item is not in the cart.'}:{status:'success',output:{}})}]};
    else result={content:[{type:'text',text:'live tools'}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
}`);
  const configPath = path.join(root, "chrome.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { "chrome-devtools": { command: fakeMcp } } }));
  connection = await connectChromeWebMcp(configPath, root);
  bridge = await connection.bindTask({ url: "http://localhost:5173/redirected-entry", marker: "test-marker", toolNames: ["select", "clear", "remove"], workspace: root });
  const config = JSON.parse(await readFile(bridge.configPath, "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), ["chrome-devtools"]);
  const server = config.mcpServers["chrome-devtools"];
  adapter = await connectStdioMcp(server, 2_000);
  const catalog = await adapter.request("tools/list");
  assert.deepEqual(catalog.tools.map(tool => tool.name), ["list_webmcp_tools", "call_webmcp_tool"]);
  const endpoint = JSON.parse(await readFile(server.args[1], "utf8"));
  assert.equal((await fetch(endpoint.url, { method: "POST", body: '{}' })).status, 403, "Unauthenticated loopback requests cannot execute tools");
  assert.equal((await fetch(endpoint.url, { method: "POST", headers: { Authorization: 'é'.repeat(71) }, body: '{}' })).status, 403, "Malformed multibyte credentials must not crash timing-safe authentication");
  assert.equal((await adapter.call("list_webmcp_tools")).isError, undefined);
  await adapter.call("call_webmcp_tool", { toolName: "select" });
  await adapter.call("call_webmcp_tool", { toolName: "clear" });
  await adapter.call("call_webmcp_tool", { toolName: "remove" });
  assert.equal(requiredToolsObserved(task, bridge.evidence), true);
  assert.equal(expectedRejectionObserved(negative, bridge.evidence), true);
  assert.equal((await adapter.call("call_webmcp_tool", { toolName: "unapproved" })).isError, true);
  assert.equal((await adapter.call("evaluate_script", { function: "() => true" })).isError, true);
  assert.equal(requiredToolsObserved(task, bridge.evidence), false, "Policy violations fail the attempt instead of being hidden by a true postcondition");

  const argsPath = path.join(root, "codex-args.json");
  const fakeCodex = await fixtureProvider(root, "codex", `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'turn.completed'}));`);
  process.env.WEBMCPIFY_CODEX_BIN = fakeCodex;
  await runAgent({ provider: "codex", prompt: "Private fixture prompt", cwd: root, mcpConfig: bridge.configPath, saveTo: path.join(root, "agent.json") });
  const args = JSON.parse(await readFile(argsPath, "utf8"));
  assert.ok(args.includes('mcp_servers."chrome-devtools".required=true'));
  assert.ok(args.includes('mcp_servers."chrome-devtools".enabled=true'));
  assert.ok(args.includes('mcp_servers."chrome-devtools".enabled_tools=["list_webmcp_tools","call_webmcp_tool"]'));
  assert.ok(args.includes("mcp_optional_startup_grace_ms=0"));
  await adapter.close(); adapter = undefined;
  await bridge.close(); bridge = undefined;
  await connection.close(); connection = undefined;
  const bad = await fixtureProvider(root, "missing-methods", `import {createInterface} from 'node:readline';for await(const l of createInterface({input:process.stdin})){const r=JSON.parse(l);if(r.id===undefined)continue;console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{capabilities:{},protocolVersion:'2025-03-26'}:{tools:[{name:'click'}]}}));}`);
  await writeFile(configPath, JSON.stringify({ mcpServers: { "chrome-devtools": { command: bad } } }));
  await assert.rejects(connectChromeWebMcp(configPath, root), /No capability tests were run/);
  assert.ok((await readdir(path.join(root, ".webmcpify/trajectories"))).some(name => name.startsWith("browser-mcp-failure")));
  const slow = await fixtureProvider(root, "slow-mcp", `import {createInterface} from 'node:readline';for await(const l of createInterface({input:process.stdin})){const r=JSON.parse(l);if(r.id===undefined)continue;if(r.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{capabilities:{},protocolVersion:'2025-03-26'}}));else setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[]}})),5000);}`);
  slowClient = await connectStdioMcp({ command: slow }, 1_000);
  await assert.rejects(slowClient.call("slow"), /timed out/);
  await assert.rejects(slowClient.call("retry"), /not connected/, "Timed-out MCP execution must fail closed, not overlap a retry");
  await slowClient.close(); slowClient = undefined;
  console.log("WebMCP execution verification passed: mandatory MCP initialization, two-method task gateway, exact tab binding, authenticated access, approved-only calls, real rejection evidence, false-pass prevention, null-safe new tasks, and Codex required settings");
} finally {
  await adapter?.close();
  await slowClient?.close();
  await bridge?.close();
  await connection?.close();
  if (previousCodex === undefined) delete process.env.WEBMCPIFY_CODEX_BIN; else process.env.WEBMCPIFY_CODEX_BIN = previousCodex;
  await rm(root, { recursive: true, force: true });
}
