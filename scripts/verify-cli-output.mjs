import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { printCliLine, printWorkflowBanner, renderBox, renderTable, textWidth, wrapText } from "../dist/lib/cli-output.js";
import { startCliProgress } from "../dist/lib/cli-progress.js";
import { printEvaluationReport, runEval, showSavedEvaluation } from "../dist/commands/eval.js";
import { runApply } from "../dist/commands/apply.js";

const long = "/project/" + "long-project-name/".repeat(12);
const taskId = "flight-cap-atomic-rejection-".repeat(4);
const rows = [["1", "PASS", taskId, "tools observed; verify true"], ["2", "FAIL", "咖啡 e\u0301 ☕ 👩‍💻", long]];
for (const width of [1, 8, 24, 40, 59, 79, 99]) {
  for (const value of [renderBox("WEBMCPIFY | RUN", [long, "AI generation and human review take time", "咖啡 e\u0301 ☕ 👩‍💻"], width),
    renderTable(["#", "Status", "Task", "Verification"], rows, width)]) {
    const lines = value.split("\n");
    assert.ok(lines.every(line => textWidth(line) <= width), `Output must fit ${width} columns`);
    for (const line of lines.filter(line => line.startsWith("|"))) {
      assert.ok(line.endsWith("|"), "Wrapped cells must retain the right border");
    }
    const borders = lines.filter(line => line.startsWith("+"));
    if (borders.length) assert.ok(borders.every(line => textWidth(line) === textWidth(borders[0])), "Borders must align");
    if (borders.length) assert.ok(lines.filter(line => line.startsWith("|")).every(line => textWidth(line) === textWidth(borders[0])), "Wrapped rows must align with the borders");
    assert.doesNotMatch(value, /\x1b|\r/, "Saved/piped tables must contain no terminal controls");
  }
}
assert.equal(textWidth("咖啡"), 4);
assert.equal(textWidth("e\u0301"), 1);
assert.equal(textWidth("©"), 1);
assert.equal(textWidth("👩‍💻"), 2);
assert.equal(wrapText("\x1b[31mPASS\x1b[0m\n\x07safe", 20).join(" "), "PASS safe");

const originalLog = console.log;
const columnDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const output = [];
const evaluation = {
  version: 1, mode: "webmcp", targetProject: long, runId: "presentation-fixture", taskSetId: "fixture",
  tasks: [{ id: taskId, description: "Keep approved verification criteria", verify: "true" }],
  scores: { passed: 0, total: 1, results: [{ task: taskId, passed: false, detail: "Independent postcondition failed", failureKind: "postcondition" }] },
};
try {
  console.log = value => output.push(String(value));
  for (const columns of [24, 40, 80, 120]) {
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
    for (const command of ["run", "final-eval"]) {
      for (const baseline of [false, true]) {
        output.length = 0;
        printWorkflowBanner(command, { baseline, durable: command === "run", resume: true });
        assert.ok(output.join("\n").split("\n").every(line => textWidth(line) < columns));
        const text = output.join("\n").split("\n").filter(line => !line.startsWith("+"))
          .map(line => line.replace(/^\| | \|$/g, "")).join(" ").replace(/\s+/g, " ");
        assert.match(text, /Human review/);
        assert.equal(text.includes("optional UI-only baseline before"), baseline);
      }
    }
    output.length = 0;
    const before = JSON.stringify(evaluation);
    printEvaluationReport(evaluation);
    assert.equal(JSON.stringify(evaluation), before, "Rendering must not change saved scores or task definitions");
    assert.ok(output.join("\n").split("\n").every(line => textWidth(line) < columns));
    assert.match(output.join("\n"), /0\/1 tasks passed/);
    assert.match(output.join("\n"), /FAIL/);
    assert.match(output.join("\n"), /Keep approved/);
  }
  const writes = [];
  const stream = { isTTY: true, columns: 40, write: text => { writes.push(text); return true; } };
  const stop = startCliProgress("codex", "test agent", { stream, intervalMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 35));
  console.log = text => writes.push("LOG:" + text);
  printCliLine("webmcp", "CALL | add_to_cart | SUCCESS");
  const logIndex = writes.findIndex(value => value.startsWith("LOG:"));
  assert.match(writes[logIndex - 1], /\r\x1b\[2K/, "Clear the spinner before a permanent MCP line");
  stop();
  const stoppedWrites = writes.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(writes.length, stoppedWrites, "Stop progress timers when the provider finishes");
  console.log = value => output.push(String(value));
  const empty = await mkdtemp(path.join(os.tmpdir(), "webmcpify-cli-prerequisites-"));
  try {
    await assert.rejects(runApply({ path: empty }), /generate.*first/);
    await assert.rejects(runEval(empty), /test.*first/);
    await showSavedEvaluation(empty, "run");
    assert.ok(output.some(line => line.includes("View again:")), "Offer the report command even when worker evidence is unavailable locally");
  } finally { await rm(empty, { recursive: true, force: true }); }
} finally {
  console.log = originalLog;
  if (columnDescriptor) Object.defineProperty(process.stdout, "columns", columnDescriptor);
  else delete process.stdout.columns;
}
console.log("CLI output passed: narrow/wide tables, Unicode alignment, control stripping, spinner/MCP separation, honest failure reports and existing command prerequisites");

// Exercise the real run coordinator with fixture stages, leaving its saved-report
// reader and rendering intact. No live browser/provider or target source is used.
const workflowFixture = await mkdtemp(path.join(os.tmpdir(), "webmcpify-cli-report-"));
try {
  const base = new URL("../dist/", import.meta.url).href;
  const loader = path.join(workflowFixture, "loader.mjs");
  const testModule = `import {createTrajectoryArtifact} from ${JSON.stringify(base + "lib/trajectories.js")};
      export async function runTest({path: targetProject}) {
        const passed = process.env.CLI_OUTCOME === 'passed';
        const tasks = [{id:'fixture_browser_task',description:'A verified task',verify:'true'}];
        const value = {version:1,mode:'webmcp',runId:'fixture-run',targetProject,taskSetId:'fixture',tasks,
          scores:{passed:passed?1:0,total:1,results:[{task:tasks[0].id,passed,detail:passed?'verify true':'verify false'}]}};
        await createTrajectoryArtifact('test-eval',value,{sitePath:targetProject}); return value;
      }`;
  await writeFile(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL !== ${JSON.stringify(base + "commands/run.js")}) return nextResolve(specifier, context);
  const fixtures = {
    './generate.js': 'export async function runGenerate() {}',
    './review.js': 'export async function runReviewPrompt() { return {approved: process.env.CLI_OUTCOME !== "rejected", sourceDiff: {runId:"fixture", patchHash:"fixture"}}; }',
    './apply.js': 'export async function runApply() {}',
    '../lib/browser.js': 'export async function withManagedChrome(url, operation) { return operation(); }',
    '../lib/scoring.js': 'export async function closeScoringBrowser() {}',
    '../lib/target-url.js': 'export async function ensureTargetReachable() {} export function normalizeTargetUrl(url) { return url; }',
    '../lib/config.js': 'export async function resolveDurable() { return false; }',
    './test.js': ${JSON.stringify(testModule)}
  };
  const source = fixtures[specifier];
  return source ? {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true} : nextResolve(specifier,context);
}
`);
  const entry = path.join(workflowFixture, "entry.mjs");
  await writeFile(entry, `
import {register} from 'node:module';
register('./loader.mjs',import.meta.url);
const {runWorkflow}=await import(${JSON.stringify(base + "commands/run.js")});
try { await runWorkflow({path:process.env.CLI_TARGET,url:'http://fixture.invalid',durable:false}); }
catch(error) { console.error(error.message); process.exitCode=1; }
`);
  for (const outcome of ["passed", "failed", "rejected"]) {
    const result = spawnSync(process.execPath, [entry], {
      env: { ...process.env, CLI_OUTCOME: outcome, CLI_TARGET: path.join(workflowFixture, outcome) }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, outcome === "failed" ? 1 : 0, result.stderr);
    assert.match(result.stdout, /WEBMCPIFY \| RUN/);
    if (outcome === "rejected") {
      assert.doesNotMatch(result.stdout, /WEBMCPIFY \| EVALUATION/, "Rejection must not display a fabricated test report");
    } else {
      assert.match(result.stdout, /WEBMCPIFY \| EVALUATION/, "Both successful and failed task runs must display eval automatically");
      assert.match(result.stdout, outcome === "passed" ? /1\/1 tasks passed/ : /0\/1 tasks passed/);
      assert.match(result.stdout, /fixture_browser_task/);
      assert.match(result.stdout, /View again:/);
    }
  }
} finally { await rm(workflowFixture, { recursive: true, force: true }); }
console.log("Workflow report passed: automatic saved eval on success/failure, unchanged failed exit status, and no report after review rejection");
