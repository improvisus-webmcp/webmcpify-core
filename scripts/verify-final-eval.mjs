import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertRepairableWebMcpResults, buildFinalEvalPlan, compareTaskSets, finalEvalComparisonComplete, finalEvalVerified, matchesEvaluationContext } from "../dist/commands/final-eval.js";
import { taskFingerprint } from "../dist/lib/tasks.js";
import { initializeAgentWorkspace, readAgentWorkspaceDiff } from "../dist/lib/agent-workspace.js";

const tasks = [
  { id: "compare", description: "Compare two products", verify: "document.body.dataset.compare === 'true'" },
  { id: "flight", description: "Build a tasting flight", verify: "document.body.dataset.flight === 'true'" },
];
assert.deepEqual(buildFinalEvalPlan(), [
  "prepare-and-review",
  "apply-and-test",
  "repair-if-needed",
  "temporal-evaluation",
  "compare-and-record",
], "UI baseline is skipped by default");
assert.deepEqual(buildFinalEvalPlan(true), [
  "prepare-and-review",
  "baseline",
  "apply-and-test",
  "repair-if-needed",
  "temporal-evaluation",
  "compare-and-record",
]);
compareTaskSets(tasks, structuredClone(tasks));
assert.throws(() => compareTaskSets(tasks, [{ ...tasks[0], verify: "false" }, tasks[1]]), /exact same task definitions/);
assert.throws(() => assertRepairableWebMcpResults({ results: [{ passed: true }, { passed: false, failureKind: "infrastructure" }] }), /not a proven application defect/);
assert.throws(() => assertRepairableWebMcpResults({ results: [{ passed: false, failureKind: "evidence" }] }), /No source repair or durable evaluation/);
assert.throws(() => assertRepairableWebMcpResults({ results: [{ passed: false, failureKind: "verification" }] }), /verification expression failed/);
assert.doesNotThrow(() => assertRepairableWebMcpResults({ results: [{ passed: false, failureKind: "postcondition" }] }));
const context = { sitePath: process.cwd(), taskSetId: taskFingerprint(tasks), mode: "webmcp", url: "http://localhost:5173", provider: "codex", sourceSnapshot: { sourceVersion: "head", workingTreeHash: "reviewed-tree" } };
const evaluation = {
  version: 1, executionVersion: 1, mode: "webmcp", targetProject: context.sitePath,
  taskSetId: context.taskSetId, url: context.url, provider: context.provider, sourceSnapshot: context.sourceSnapshot, tasks,
  scores: { passed: 2, total: 2, results: tasks.map(task => ({ task: task.id, passed: true, detail: "recorded calls and independent postcondition passed" })) },
};
assert.equal(finalEvalVerified({ status: 'completed', scores: evaluation.scores }), true);
assert.equal(finalEvalVerified({ status: 'completed', scores: { ...evaluation.scores, passed: 1 } }), false, "A finished Temporal workflow must not claim all tasks passed");
assert.equal(finalEvalVerified({ status: 'failed', scores: evaluation.scores }), false);
assert.equal(finalEvalVerified({ status: 'completed', scores: { passed: 0, total: 0, results: [] } }), false);
const finalLevel = { status: 'completed', scores: evaluation.scores };
const lowBaseline = { status: 'completed', scores: { passed: 0, total: 2, results: tasks.map(task => ({ task: task.id, passed: false, failureKind: 'postcondition', detail: 'The original UI cannot perform this capability' })) } };
assert.equal(finalEvalComparisonComplete(lowBaseline, finalLevel), true, 'Low baseline scores remain a valid comparison');
assert.equal(finalEvalComparisonComplete({ ...lowBaseline, status: 'failed' }, finalLevel), false, 'A failed baseline cannot complete the comparison');
assert.equal(finalEvalComparisonComplete({ ...lowBaseline, agentError: 'Provider failed' }, finalLevel), false);
assert.equal(finalEvalComparisonComplete({ ...lowBaseline, scores: { ...lowBaseline.scores, results: lowBaseline.scores.results.map(result => ({ ...result, failureKind: 'infrastructure' })) } }, finalLevel), false);
assert.equal(matchesEvaluationContext(evaluation, context), true);
assert.equal(matchesEvaluationContext({ ...evaluation, executionVersion: undefined }, context), false, "Old report-only results must be retested");
assert.equal(matchesEvaluationContext({ ...evaluation, url: "http://localhost:3000" }, context), false);
assert.equal(matchesEvaluationContext({ ...evaluation, provider: "antigravity" }, context), false);
assert.equal(matchesEvaluationContext({ ...evaluation, mode: "baseline" }, context), false);
assert.equal(matchesEvaluationContext({ ...evaluation, sourceSnapshot: { ...context.sourceSnapshot, workingTreeHash: "changed" } }, context), false);
assert.equal(matchesEvaluationContext({ ...evaluation, sourceSnapshot: undefined }, context), false);
assert.equal(matchesEvaluationContext({ ...evaluation, scores: { ...evaluation.scores, passed: 1 } }, context), false);
assert.equal(matchesEvaluationContext({ ...evaluation, scores: { ...evaluation.scores, results: [evaluation.scores.results[0], evaluation.scores.results[0]] } }, context), false, "Duplicate IDs cannot conceal an untested approved task");
assert.equal(matchesEvaluationContext({ ...evaluation, mode: "baseline", readOnly: true, sourceSnapshot: undefined }, { ...context, mode: "baseline" }), true, "Baseline source is intentionally measured before applying the patch");
assert.equal(matchesEvaluationContext({ ...evaluation, mode: "baseline", readOnly: false }, { ...context, mode: "baseline" }), false, "A standalone mixed UI/WebMCP baseline cannot replace the UI-only final-eval level");

const workspace = await mkdtemp(path.join(os.tmpdir(), "webmcpify-final-eval-diff-"));
try {
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "main.tsx"), "export const app = true;\n");
  await initializeAgentWorkspace(workspace);
  await writeFile(path.join(workspace, "src", "main.tsx"), "import { registerGlobalTools } from './webmcp';\nexport const app = true;\n");
  await writeFile(path.join(workspace, "src", "webmcp.ts"), "export function registerGlobalTools() {}\n");
  await mkdir(path.join(workspace, ".agents"));
  await writeFile(path.join(workspace, ".agents", "mcp_config.json"), "{}\n");
  await mkdir(path.join(workspace, ".webmcpify"));
  await writeFile(path.join(workspace, ".webmcpify", "discovery.json"), "{}\n");
  await writeFile(path.join(workspace, "tasks.json"), "[]\n");
  const diff = await readAgentWorkspaceDiff(workspace);
  assert.ok(diff.includes("new file mode 100644"));
  assert.ok(diff.includes("src/webmcp.ts"));
  assert.equal(diff.includes("mcp_config"), false);
  assert.equal(diff.includes("discovery.json"), false);
  assert.equal(diff.includes("tasks.json"), false);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log("final-eval verification passed: orchestration, exact task-set guard, and new-file diff capture");
