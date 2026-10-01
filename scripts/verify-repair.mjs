import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createPendingPatch, readPatchMetadata } from "../dist/lib/patches.js";
import { runApply } from "../dist/commands/apply.js";
import { repairPrompt, selectFailedTasks } from "../dist/commands/repair.js";
import { closeScoringBrowser } from "../dist/lib/scoring.js";
import { withManagedChrome } from "../dist/lib/browser.js";
import { taskFingerprint } from "../dist/lib/tasks.js";
import { createTrajectoryArtifact, latestTrajectoryPath } from "../dist/lib/trajectories.js";

const sitePath = await mkdtemp(path.join(os.tmpdir(), "webmcpify-repair-fixture-"));
const source = path.join(sitePath, "index.html");
const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task_${index + 1}`, description: `Check repaired result ${index + 1}`, verify: 'document.body.dataset.repaired === "true"' }));
const taskSetId = taskFingerprint(tasks);
await mkdir(path.join(sitePath, ".webmcpify"), { recursive: true });
await writeFile(source, '<!doctype html><body data-repaired="false"><main>ready</main></body>\n');
await writeFile(path.join(sitePath, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
await writeFile(path.join(sitePath, "package.json"), JSON.stringify({ name: "repair-fixture", scripts: { build: "node -e \"process.exit(0)\"" } }, null, 2));
await execa("git", ["init", "-q"], { cwd: sitePath });
await execa("git", ["config", "user.email", "fixture@example.invalid"], { cwd: sitePath });
await execa("git", ["config", "user.name", "Repair Fixture"], { cwd: sitePath });
await execa("git", ["add", "-A"], { cwd: sitePath });
await execa("git", ["commit", "-qm", "fixture baseline"] , { cwd: sitePath });

const evaluationPath = await createTrajectoryArtifact("test-eval", {
  version: 1, mode: "webmcp", runId: "failed-run", targetProject: sitePath, taskSetId, tasks,
  scores: { passed: 4, total: tasks.length, results: tasks.map((task, index) => ({ task: task.id, passed: index !== 1, detail: index !== 1 ? "verify → true" : "verify → false" })) },
}, { sitePath, targetProject: sitePath, runId: "failed-run", taskSetId, mode: "webmcp" }, "repair-fixture");
const evaluation = JSON.parse(await readFile(evaluationPath, "utf8"));
const failed = selectFailedTasks(evaluation, "task_2");
assert.deepEqual(failed.map((task) => task.task), ["task_2"]);
assert.throws(() => selectFailedTasks(evaluation, "task_1"), /not a failed task/);
assert.match(repairPrompt(evaluation, evaluationPath, sitePath, failed), /verify → false/);
assert.equal(await latestTrajectoryPath("test-eval", sitePath), evaluationPath);

const runId = randomUUID();
const cdpPort = 4398;
const diff = `diff --git a/index.html b/index.html\n--- a/index.html\n+++ b/index.html\n@@ -1 +1 @@\n-<!doctype html><body data-repaired="false"><main>ready</main></body>\n+<!doctype html><body data-repaired="true"><main>ready</main></body>\n`;
const repairTrajectory = await createTrajectoryArtifact("repair", { failedTasks: ["task_2"], diff }, { sitePath, runId, sourceEvaluation: evaluationPath, taskSetId }, "repair-fixture");
const patch = await createPendingPatch(sitePath, diff, repairTrajectory, { repair: { sourceEvaluation: evaluationPath, url: "http://127.0.0.1:4399", taskSetId, failedTaskIds: ["task_2"] } });
assert.equal(patch.patchStatus, "awaiting-review");
assert.match(await readFile(patch.patchPath, "utf8"), /data-repaired="true"/);
await assert.rejects(() => runApply({ path: sitePath }), /explicitly approve/);

await writeFile(path.join(sitePath, ".webmcpify", "approved-tools.json"), `${JSON.stringify({ sourceDiff: { status: "approved", runId: patch.runId, patchHash: patch.patchHash } }, null, 2)}\n`);
const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(readFileSync(source)); });
await new Promise((resolve) => server.listen(4399, "127.0.0.1", resolve));
const originalCdp = process.env.WEBMCPIFY_CDP_URL;
const originalManager = process.env.WEBMCPIFY_PACKAGE_MANAGER;
process.env.WEBMCPIFY_CDP_URL = `http://127.0.0.1:${cdpPort}`;
process.env.WEBMCPIFY_PACKAGE_MANAGER = "npm";
try {
  await withManagedChrome("http://127.0.0.1:4399", async () => {
  try {
  await runApply({ path: sitePath });
  const repairEvalPath = await latestTrajectoryPath("repair-eval", sitePath);
  assert.ok(repairEvalPath);
  const repairEval = JSON.parse(await readFile(repairEvalPath, "utf8"));
  assert.equal(repairEval.status, "improved");
  assert.equal(repairEval.before.passed, 0);
  assert.equal(repairEval.after.passed, 1);
  } finally { await closeScoringBrowser(); }
  });
} finally {
  await closeScoringBrowser();
  if (originalCdp === undefined) delete process.env.WEBMCPIFY_CDP_URL; else process.env.WEBMCPIFY_CDP_URL = originalCdp;
  if (originalManager === undefined) delete process.env.WEBMCPIFY_PACKAGE_MANAGER; else process.env.WEBMCPIFY_PACKAGE_MANAGER = originalManager;
  await new Promise((resolve) => server.close(resolve));
}

const regressionPath = await createTrajectoryArtifact("repair-eval", { version: 1, mode: "repair", status: "regressed", runId, targetProject: sitePath, before: { passed: 4 }, after: { passed: 3 }, improvement: -1 }, { sitePath, runId, targetProject: sitePath, repairStatus: "regressed" }, "repair-regression-fixture");
assert.equal(JSON.parse(await readFile(regressionPath, "utf8")).status, "regressed");
await readPatchMetadata(sitePath);
await rm(sitePath, { recursive: true, force: true });
console.log("repair verification passed: failed-task context, real diff, approval boundary, apply/retest, and regression evidence");
