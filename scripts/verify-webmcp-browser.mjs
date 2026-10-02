import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { fixtureProvider } from "./fixture-provider.mjs";
import { withManagedChrome } from "../dist/lib/browser.js";
import { closeScoringBrowser, resetScoringState, scoreTask } from "../dist/lib/scoring.js";
import { taskFingerprint, validateTasks, writeApprovedTasksAtomically } from "../dist/lib/tasks.js";
import { runApprovedTask, runTest } from "../dist/commands/test.js";
import { runBaseline } from "../dist/commands/baseline.js";

// Real Chrome + the real pinned Chrome DevTools MCP, but no paid/authenticated
// model. A fixture provider uses exactly the MCP methods a test agent receives.
const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify-webmcp-browser-"));
const environmentKeys = ["WEBMCPIFY_CDP_URL", "WEBMCPIFY_OPENCODE_BIN", "WEBMCPIFY_FIXTURE_CLAIM_ONLY", "WEBMCPIFY_FIXTURE_PROVIDER_FAIL", "WEBMCPIFY_FIXTURE_LATE_MUTATION", "WEBMCPIFY_FIXTURE_SOURCE_DRIFT"];
const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
let completed = false;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><html><body><h1>WebMCP coffee fixture</h1><script>
    const selected = [];
    const register = (name, execute) => document.modelContext.registerTool({
      name, description: name + ' fixture action',
      inputSchema: {type:'object',properties:{id:{type:'string'}},required:['id']}, execute
    });
    register('add_item', async ({id}) => {
      localStorage.setItem('fixture-store', JSON.stringify({state:{cart:{[id]:1}}}));
      setTimeout(() => { document.body.dataset.cart = id; }, 100);
      return {added:id};
    });
    register('remove_item', async ({id}) => {
      const cart = JSON.parse(localStorage.getItem('fixture-store') ?? '{}')?.state?.cart ?? {};
      if (!Object.hasOwn(cart, id)) throw new Error('Item is not in the cart.');
      delete cart[id];
      localStorage.setItem('fixture-store', JSON.stringify({state:{cart}}));
      return {removed:id};
    });
    register('select_coffee', async ({id}) => {
      if (selected.length === 3) throw new Error('Compare up to three coffees at a time.');
      selected.push(id);
      document.body.dataset.selected = JSON.stringify(selected);
      return {selected:[...selected]};
    });
    register('checkout', async () => ({isError:true,content:[{type:'text',text:'Log in before checkout.'}]}));
    register('late_guard', async () => {
      setTimeout(() => { document.body.dataset.forbidden = 'true'; }, 250);
      throw new Error('Guard rejected.');
    });
  </script></body></html>`);
});
const portProbe = createServer();
const tasks = validateTasks([
  { id: "add", description: "Add an item through WebMCP", requiredTools: ["add_item"], verify: "JSON.parse(localStorage.getItem('fixture-store') ?? '{}')?.state?.cart?.coffee === 1 && document.body.dataset.cart === 'coffee'" },
  { id: "remove-absent", description: "Reject removing an absent item without creating storage", requiredTools: ["remove_item"], expectedOutcome: "rejection", expectedError: "Item is not in the cart.", verify: "!Object.hasOwn(JSON.parse(localStorage.getItem('fixture-store') ?? '{}')?.state?.cart ?? {}, 'coffee') && localStorage.getItem('fixture-store') === null" },
  { id: "comparison-limit", description: "Keep three selected coffees after rejecting a fourth", requiredTools: ["select_coffee"], setup: "Select a, b and c through select_coffee; attempt d exactly once.", expectedOutcome: "rejection", expectedError: "Compare up to three coffees at a time.", verify: "document.body.dataset.selected === JSON.stringify(['a','b','c'])" },
  { id: "availability", description: "Discover the live WebMCP capabilities", verify: "Boolean(document.modelContext)" },
  { id: "checkout-guard", description: "Reject UI checkout while logged out", requiredTools: ["checkout"], expectedOutcome: "rejection", expectedError: "Log in before checkout.", verify: "localStorage.getItem('fixture-store') === null && !document.body.dataset.purchased" },
  { id: "remove-populated", description: "Add an item then remove it", requiredTools: ["add_item", "remove_item"], setup: "Add coffee through add_item, then remove it through remove_item.", verify: "JSON.parse(localStorage.getItem('fixture-store') ?? '{}')?.state?.cart && !Object.hasOwn(JSON.parse(localStorage.getItem('fixture-store') ?? '{}')?.state?.cart ?? {}, 'coffee')" },
]);
try {
  await mkdir(path.join(root, ".webmcpify"));
  await writeApprovedTasksAtomically(root, {
    version: 1, approved: true, approvalId: "browser-fixture", draftPath: "fixture",
    tasks, taskSetId: taskFingerprint(tasks),
    tools: ["add_item", "remove_item", "select_coffee", "checkout"],
  });
  const originalTasks = await readFile(path.join(root, "tasks.json"), "utf8");
  const provider = await fixtureProvider(root, "webmcp-agent", `
    import {connectStdioMcp} from ${JSON.stringify(fileURLToPath(new URL("../dist/lib/mcp-stdio-client.js", import.meta.url)))};
    import {appendFile} from 'node:fs/promises';
    const prompt = process.argv.at(-1);
    if (process.env.WEBMCPIFY_FIXTURE_PROVIDER_FAIL) process.exit(1);
    if (process.env.WEBMCPIFY_FIXTURE_CLAIM_ONLY) {
      console.log(JSON.stringify({type:'text',part:{text:'No browser connected. Required tools not executed: add_item remove_item select_coffee.'}}));
      process.exit(0);
    }
    const server = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp['chrome-devtools'];
    const client = await connectStdioMcp({command:server.command[0],args:server.command.slice(1)});
    const call = async (toolName,id) => {
      const result = await client.call('call_webmcp_tool',{toolName,input:JSON.stringify({id})});
      if (result.isError) throw new Error('Fixture gateway failed');
    };
    try {
      await client.call('list_webmcp_tools');
      if (process.env.WEBMCPIFY_FIXTURE_LATE_MUTATION) await call('late_guard','coffee');
      else if (prompt.includes('"id": "add"')) await call('add_item','coffee');
      else if (prompt.includes('"id": "remove-absent"')) await call('remove_item','coffee');
      else if (prompt.includes('"id": "comparison-limit"')) {
        for (const id of ['a','b','c','d']) await call('select_coffee',id);
      }
      else if (prompt.includes('"id": "checkout-guard"')) await call('checkout','coffee');
      else if (prompt.includes('"id": "remove-populated"')) {
        await call('add_item','coffee');
        await call('remove_item','coffee');
      }
      if (process.env.WEBMCPIFY_FIXTURE_SOURCE_DRIFT) await appendFile(process.env.WEBMCPIFY_FIXTURE_SOURCE_DRIFT, 'changed\\n');
      console.log(JSON.stringify({type:'text',part:{text:'Real MCP calls completed; Core checks the state.'}}));
    } finally { await client.close(); }
  `);
  process.env.WEBMCPIFY_OPENCODE_BIN = provider;
  delete process.env.WEBMCPIFY_FIXTURE_CLAIM_ONLY;
  delete process.env.WEBMCPIFY_FIXTURE_PROVIDER_FAIL;
  delete process.env.WEBMCPIFY_FIXTURE_LATE_MUTATION;
  delete process.env.WEBMCPIFY_FIXTURE_SOURCE_DRIFT;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  await new Promise((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
  process.env.WEBMCPIFY_CDP_URL = `http://127.0.0.1:${portProbe.address().port}`;
  await new Promise(resolve => portProbe.close(resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await withManagedChrome(url, async () => {
    try {
      const evaluation = await runTest({ path: root, url, provider: "opencode" });
      assert.equal(evaluation.scores.passed, tasks.length, JSON.stringify(evaluation.scores.results));
      const durable = await runApprovedTask({ path: root, url, provider: "opencode", taskId: "remove-absent", taskSetId: taskFingerprint(tasks) });
      assert.equal(durable.passed, true, "Durable task attempts must share the CLI WebMCP boundary");
      const artifacts = await readdir(path.join(root, ".webmcpify/trajectories"));
      const evidence = await Promise.all(artifacts.filter(name => /^test-evidence-.*\.json$/.test(name) && !name.endsWith('.meta.json')).map(async name => JSON.parse(await readFile(path.join(root, ".webmcpify/trajectories", name), "utf8"))));
      assert.ok(evidence.some(item => item.calls?.some(call => call.toolName === "remove_item" && call.status === "error" && /not in the cart/.test(call.error))));
      assert.ok(evidence.some(item => item.calls?.filter(call => call.toolName === "select_coffee" && call.status === "success").length === 3));
      process.env.WEBMCPIFY_FIXTURE_CLAIM_ONLY = "1";
      const unavailable = await runTest({ path: root, url, provider: "opencode" });
      assert.equal(unavailable.scores.passed, 0, "Tool-name mentions cannot pass an initially-true state check");
      assert.equal(unavailable.scores.total, tasks.length);
      assert.ok(unavailable.scores.results.every(result => result.failureKind === "infrastructure"));
      assert.match(unavailable.scores.results[1].detail, /Not executed/);
      await assert.rejects(runApprovedTask({ path: root, url, provider: "opencode", taskId: "add" }), /mandatory Chrome DevTools/);
      assert.equal(await readFile(path.join(root, "tasks.json"), "utf8"), originalTasks, "Do not rewrite approved criteria during testing");
      const cli = await execa(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "test", "--path", root, "--url", url, "--provider", "opencode"], { reject: false, timeout: 60_000 });
      assert.equal(cli.exitCode, 1, "A failed standalone test must fail CI, not silently exit zero");
      assert.match(cli.stdout + cli.stderr, /WebMCP audit failed/);
      delete process.env.WEBMCPIFY_FIXTURE_CLAIM_ONLY;

      const baselineTasks = [tasks.find(task => task.id === "availability"), tasks[0]];
      await writeApprovedTasksAtomically(root, { version: 1, approved: true, approvalId: "baseline-fixture", draftPath: "fixture", tools: ["add_item"], tasks: baselineTasks, taskSetId: taskFingerprint(baselineTasks) });
      process.env.WEBMCPIFY_FIXTURE_PROVIDER_FAIL = "1";
      const baseline = await runBaseline({ path: root, url, provider: "opencode", readOnly: true });
      assert.equal(baseline.scores.passed, 0, "A failed baseline provider cannot pass an initially-true availability check");
      assert.equal(baseline.scores.total, baselineTasks.length);
      assert.ok(baseline.scores.results.every(result => result.failureKind === "infrastructure"));
      assert.match(baseline.scores.results[1].detail, /Not executed/);
      delete process.env.WEBMCPIFY_FIXTURE_PROVIDER_FAIL;

      const delayed = validateTasks([{ id: "late-guard", description: "Reject without delayed mutations", requiredTools: ["late_guard"], expectedOutcome: "rejection", expectedError: "Guard rejected.", verify: "!document.body.dataset.forbidden" }]);
      await writeApprovedTasksAtomically(root, { version: 1, approved: true, approvalId: "late-fixture", draftPath: "fixture", tools: ["late_guard"], tasks: delayed, taskSetId: taskFingerprint(delayed) });
      process.env.WEBMCPIFY_FIXTURE_LATE_MUTATION = "1";
      const delayedResult = await runApprovedTask({ path: root, url, provider: "opencode", taskId: "late-guard" });
      assert.equal(delayedResult.passed, false, "A real guard exception cannot hide a queued forbidden mutation");
      assert.equal(delayedResult.failureKind, "postcondition");
      delete process.env.WEBMCPIFY_FIXTURE_LATE_MUTATION;

      const session = await resetScoringState(url);
      try {
        const hung = await scoreTask(url, { id: "hung-verifier", description: "Never resolve", verify: "new Promise(() => {})" }, { page: session.page, verificationTimeoutMs: 100 });
        assert.equal(hung.failureKind, "verification", "Real Chrome verification promises have a deadline");
        assert.match(hung.detail, /timed out/);
      } finally { await session.close(); }
      const sourceProbe = path.join(root, "source-probe.txt");
      await writeFile(sourceProbe, "stable\n");
      await execa("git", ["init", "-q"], { cwd: root });
      await execa("git", ["config", "user.name", "WebMCP Browser Fixture"], { cwd: root });
      await execa("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
      await execa("git", ["config", "commit.gpgsign", "false"], { cwd: root });
      await execa("git", ["config", "core.hooksPath", path.join(root, ".git", "disabled-hooks")], { cwd: root });
      await execa("git", ["add", "--", "source-probe.txt"], { cwd: root });
      await execa("git", ["commit", "-qm", "fixture source identity"], { cwd: root });
      const driftTasks = [tasks.find(task => task.id === "availability")];
      await writeApprovedTasksAtomically(root, { version: 1, approved: true, approvalId: "source-drift-fixture", draftPath: "fixture", tools: ["add_item"], tasks: driftTasks, taskSetId: taskFingerprint(driftTasks) });
      process.env.WEBMCPIFY_FIXTURE_SOURCE_DRIFT = sourceProbe;
      const drift = await runTest({ path: root, url, provider: "opencode" });
      assert.equal(drift.scores.passed, 0, "Source drift invalidates even a genuinely executed initially-true check");
      assert.equal(drift.scores.results[0].failureKind, "infrastructure");
      assert.match(drift.scores.results[0].detail, /changed during testing/);
      assert.ok(drift.sourceSnapshot.sourceVersion);
      await assert.rejects(runApprovedTask({ path: root, url, provider: "opencode", taskId: "availability" }), /changed during the durable attempt/);
      delete process.env.WEBMCPIFY_FIXTURE_SOURCE_DRIFT;
      await writeApprovedTasksAtomically(root, { version: 1, approved: true, approvalId: "browser-fixture", draftPath: "fixture", tools: ["add_item", "remove_item", "select_coffee", "checkout"], tasks, taskSetId: taskFingerprint(tasks) });
      assert.equal(await readFile(path.join(root, "tasks.json"), "utf8"), originalTasks);
    } finally { await closeScoringBrowser(); }
  });
  console.log("Real WebMCP browser verification passed: pinned Chrome MCP, exact isolated tab, real calls/rejections, async effects, same-tool setup, CLI failure status, baseline false-pass prevention, bounded verification, and CLI/durable source-drift guards");
  completed = true;
} finally {
  await closeScoringBrowser();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (portProbe.listening) await new Promise(resolve => portProbe.close(resolve));
  for (const key of environmentKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  if (completed) await rm(root, { recursive: true, force: true });
  else console.error(`Private fixture diagnostics retained at ${root}`);
}
