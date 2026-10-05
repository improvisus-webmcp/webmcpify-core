import assert from "node:assert/strict";
import { createTrajectoryArtifact, latestTrajectoryPath } from "../dist/lib/trajectories.js";
import { taskFingerprint } from "../dist/lib/tasks.js";
import { readFile } from "node:fs/promises";
import { matchesFinalComparison, runEval, showSavedEvaluation } from "../dist/commands/eval.js";

const projectA = "/tmp/webmcpify-evaluation-project-a";
const projectB = "/tmp/webmcpify-evaluation-project-b";
const tasks = Array.from({ length: 5 }, (_, index) => ({
  id: `task_${index + 1}`,
  description: `Check result ${index + 1}`,
  verify: `document.querySelector("#result-${index + 1}") !== null`,
}));
const taskSetId = taskFingerprint(tasks);
const baselineScores = {
  passed: 2,
  total: tasks.length,
  results: tasks.map((task, index) => ({ task: task.id, passed: index < 2, detail: index < 2 ? "verify → true" : "verify → false" })),
};
const webmcpScores = {
  passed: 4,
  total: tasks.length,
  results: tasks.map((task, index) => ({ task: task.id, passed: index < 4, detail: index < 4 ? "verify → true" : "verify → false" })),
};

await createTrajectoryArtifact("baseline-eval", { version: 1, mode: "baseline", runId: "baseline-fixture", targetProject: projectA, taskSetId, tasks, scores: baselineScores }, { sitePath: projectA, targetProject: projectA, runId: "baseline-fixture", taskSetId, mode: "baseline" }, "phase5-fixture");
await createTrajectoryArtifact("test-eval", { version: 1, mode: "webmcp", runId: "webmcp-fixture", targetProject: projectA, taskSetId, tasks, scores: webmcpScores }, { sitePath: projectA, targetProject: projectA, runId: "webmcp-fixture", taskSetId, mode: "webmcp" }, "phase5-fixture");
await createTrajectoryArtifact("test-eval", { version: 1, mode: "webmcp", runId: "other-project", targetProject: projectB, taskSetId, tasks, scores: baselineScores }, { sitePath: projectB, targetProject: projectB, runId: "other-project", taskSetId, mode: "webmcp" }, "phase5-fixture");

const scopedWebmcpPath = await latestTrajectoryPath("test-eval", projectA);
assert.ok(scopedWebmcpPath?.includes("phase5-fixture"));
const scopedWebmcp = JSON.parse(await readFile(scopedWebmcpPath, "utf8"));
assert.equal(scopedWebmcp.targetProject, projectA);
assert.equal(scopedWebmcp.taskSetId, taskSetId);
assert.deepEqual(scopedWebmcp.tasks, tasks);
assert.deepEqual(scopedWebmcp.scores.results.map((result) => result.task), tasks.map((task) => task.id));
assert.equal((scopedWebmcp.scores.passed - baselineScores.passed) / tasks.length, 0.4);
const comparison = { version: 1, finalTestRunId: scopedWebmcp.runId, targetProject: projectA, taskSetId, tasks };
assert.equal(matchesFinalComparison(comparison, scopedWebmcp), true);
assert.equal(matchesFinalComparison({ ...comparison, finalTestRunId: "unrelated-run" }, scopedWebmcp), false);
assert.equal(matchesFinalComparison({ ...comparison, targetProject: projectB }, scopedWebmcp), false);
assert.equal(matchesFinalComparison({ ...comparison, tasks: tasks.slice(1) }, scopedWebmcp), false);
const linkedEvaluation = { ...scopedWebmcp, baseline: { runId: "baseline-fixture", evaluationPath: "linked-baseline.json", scores: baselineScores } };
await createTrajectoryArtifact("test-eval", linkedEvaluation, { sitePath: projectA }, "linked-baseline-fixture");
const output = [];
const log = console.log;
try {
  console.log = (...args) => output.push(args.join(" "));
  await runEval(projectA);
} finally { console.log = log; }
assert.ok(output.some(line => line.includes("UI baseline 2/5; WebMCP 4/5")));
const table = output.find(line => line.includes("Verification") && line.includes("UI baseline"));
assert.ok(table, "Linked baseline results must appear in the task table");
for (const task of tasks) assert.ok(table.includes(task.id), "Every approved task must appear in the table");
assert.ok(table.includes("FAIL"), "Failed checks must remain visible alongside passes");
await assert.rejects(runEval(projectA, { runId: "different-workflow" }), /does not belong/);
await assert.rejects(runEval(projectB, { evaluationPath: scopedWebmcpPath }), /does not belong/);
const olderOutput = [];
try {
  console.log = (...args) => olderOutput.push(args.join(" "));
  await showSavedEvaluation(projectA, "run", { evaluationPath: scopedWebmcpPath });
} finally { console.log = log; }
assert.ok(olderOutput.join("\n").includes("webmcp-fixture"), "A resumed durable result must display its exact saved artifact");
console.log("evaluation verification passed: shared tasks, per-task comparison, run identity, and project-scoped lookup");
