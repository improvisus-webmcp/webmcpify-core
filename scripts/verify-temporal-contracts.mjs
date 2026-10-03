import assert from 'node:assert/strict';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coreWorkflowId, durableTimeout } from '../dist/lib/durable-run.js';
import { pipelineApplyActivity, pipelineRecordActivity, pipelineTestActivity } from '../dist/temporal/pipeline-activities.js';
import { createPendingPatch, readPatchMetadata, writePatchMetadata } from '../dist/lib/patches.js';
import { taskFingerprint, validateTasks, writeApprovedTasksAtomically } from '../dist/lib/tasks.js';

assert.equal(durableTimeout(undefined, 120, 10080, '--activity-timeout'), 120);
for (const value of ['0', '-1', '0.5', 'NaN', 'Infinity', '10081']) assert.throws(() => durableTimeout(value, 120, 10080, '--activity-timeout'), /whole number/);
assert.equal(durableTimeout('8760', 168, 8760, '--review-timeout'), 8760);
assert.equal(coreWorkflowId('/fixture/repo'), coreWorkflowId('/fixture/repo'));
assert.notEqual(coreWorkflowId('/fixture/repo'), coreWorkflowId('/fixture/other'));

const root = await mkdtemp(path.join(os.tmpdir(), 'webmcpify-temporal-contracts-'));
const previousManager = process.env.WEBMCPIFY_PACKAGE_MANAGER;
try {
  process.env.WEBMCPIFY_PACKAGE_MANAGER = 'npm';
  await writeFile(path.join(root, '.gitignore'), '.webmcpify/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'node --check source.js' } }));
  await writeFile(path.join(root, 'source.js'), 'export const selected = false;\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Temporal Contract Fixture'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.hooksPath', path.join(root, '.git/disabled-hooks')], ['add', '-A'], ['commit', '-qm', 'fixture']]) await execa('git', args, { cwd: root });
  const patch = await createPendingPatch(root, 'diff --git a/source.js b/source.js\n--- a/source.js\n+++ b/source.js\n@@ -1 +1 @@\n-export const selected = false;\n+export const selected = true;\n', 'fixture-generation.json', { securityPolicy: 'balance' });
  const tasks = validateTasks(Array.from({ length: 13 }, (_, index) => ({ id: `task-${index}`, description: 'Check an approved selection', requiredTools: ['select_item'], verify: 'document.body.dataset.selected === "true"' })));
  const taskSetId = taskFingerprint(tasks);
  const draft = { approved: true, runId: patch.runId, patchHash: patch.patchHash, taskSetId, taskIds: tasks.map(task => task.id), toolCount: 1 };
  const manifest = { version: 1, approved: true, approvalId: patch.runId, draftPath: 'fixture', tasks, tools: ['select_item'], taskSetId,
    sourceDiff: { status: 'approved', runId: patch.runId, patchHash: patch.patchHash } };
  await writeApprovedTasksAtomically(root, manifest);
  const opts = { path: root, url: 'http://127.0.0.1:1', runId: 'contract-fixture', provider: 'fixture', method: 'auto', security: 'balance' };
  await assert.rejects(pipelineApplyActivity(opts, { ...draft, runId: 'another-approved-run' }), /approved patch or task set changed/);
  await assert.rejects(pipelineApplyActivity(opts, { ...draft, taskSetId: 'another-task-set' }), /approved patch or task set changed/);
  await writePatchMetadata(root, { ...patch, securityPolicy: 'ignore' });
  await assert.rejects(pipelineApplyActivity(opts, draft), /security policy changed/);
  await writePatchMetadata(root, patch);
  assert.equal(await readFile(path.join(root, 'source.js'), 'utf8'), 'export const selected = false;\n');
  const source = await pipelineApplyActivity(opts, draft);
  const results = tasks.map(task => ({ task: task.id, passed: true, detail: 'Synthetic contract result, not a live browser claim' }));
  const output = await pipelineRecordActivity(opts, draft, source, results);
  const evaluation = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(evaluation.scores.total, 13);
  assert.deepEqual(evaluation.sourceSnapshot, source);
  await assert.rejects(pipelineRecordActivity(opts, draft, source, results.slice(0, 6)), /exactly one ordered result/);
  await assert.rejects(pipelineRecordActivity(opts, draft, source, [...results].reverse()), /exactly one ordered result/);
  await writeFile(path.join(root, 'source.js'), 'export const selected = "changed between activities";\n');
  await assert.rejects(pipelineTestActivity(opts, draft, source, tasks[0].id), /source changed between durable browser tasks/);
  await assert.rejects(pipelineRecordActivity(opts, draft, source, results), /source changed between durable browser tasks/);
  assert.equal((await readPatchMetadata(root)).patchStatus, 'applied');
  console.log('Temporal contract verification passed: timeout bounds, stable per-target IDs, exact approval/policy/task-set gates, uncapped ordered evaluation, and inter-activity source drift rejection before browser execution');
} finally {
  if (previousManager === undefined) delete process.env.WEBMCPIFY_PACKAGE_MANAGER; else process.env.WEBMCPIFY_PACKAGE_MANAGER = previousManager;
  await rm(root, { recursive: true, force: true });
}
