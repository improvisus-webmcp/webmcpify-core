import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Client, Connection } from '@temporalio/client';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { coreActivityContext, reportTemporalReviewUrl } from '../dist/temporal/activity-context.js';
import { currentOperationSignal } from '../dist/lib/operation-context.js';

// Explicit opt-in, credential-free integration test. Owns an isolated local
// service/database and queues, never an existing Temporal server or namespace.
const temporal = process.env.WEBMCPIFY_TEMPORAL_CLI ?? 'temporal';
const root = await mkdtemp(path.join(os.tmpdir(), 'webmcpify-temporal-live-'));
const workflowsPath = fileURLToPath(new URL('../dist/temporal/workflows.js', import.meta.url));
const workers = [];
let service, connection, native;
let passed = false;
const calls = new Map();
let cleaned = false;
let restartWorker;

async function port() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const value = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return value;
}
async function until(operation, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch { /* startup/replay */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function record(opts, stage) {
  const log = calls.get(opts.runId) ?? [];
  log.push(stage); calls.set(opts.runId, log);
}
const identity = { runId: 'generated-draft', patchHash: 'fixture-patch' };
const reviewed = { ...identity, approved: true, taskSetId: 'frozen-task-set', toolCount: 10,
  taskIds: Array.from({ length: 13 }, (_, index) => `task-${index}`) };
const activities = {
  async pipelineDiscoverActivity(opts) { record(opts, 'discover'); },
  async pipelineGenerateActivity(opts) { record(opts, 'generate'); return identity; },
  async pipelineSecurityActivity(opts) {
    record(opts, 'security');
    if (opts.productContext === 'security-block') throw new Error('Synthetic security block');
    if (opts.productContext === 'restart') restartWorker.shutdown();
  },
  async pipelineReviewActivity(opts, draft) {
    record(opts, 'review'); assert.deepEqual(draft, identity);
    if (opts.productContext === 'cancel-review') {
      await reportTemporalReviewUrl('http://127.0.0.1:4399');
      try { await new Promise((resolve, reject) => currentOperationSignal().addEventListener('abort', () => reject(new Error('cancelled local review')), { once: true })); }
      finally { cleaned = true; }
    }
    if (opts.productContext === 'long-review') {
      await reportTemporalReviewUrl('http://127.0.0.1:4398');
      // Exceeds the 30-second heartbeat timeout; only real heartbeats keep it alive.
      await new Promise(resolve => setTimeout(resolve, 36_000));
    }
    return opts.productContext === 'reject' ? { ...reviewed, approved: false } : reviewed;
  },
  async pipelineBaselineActivity(opts, draft) { record(opts, 'baseline'); assert.deepEqual(draft, reviewed); return 'private-baseline.json'; },
  async pipelineApplyActivity(opts, draft) { record(opts, 'apply'); assert.deepEqual(draft, reviewed); return { sourceVersion: 'commit', workingTreeHash: 'tree' }; },
  async pipelineTestActivity(opts, draft, source, task) {
    record(opts, task); assert.deepEqual(draft, reviewed); assert.equal(source.workingTreeHash, 'tree');
    if (opts.productContext === 'infrastructure') throw new Error('Synthetic provider failure');
    return { task, passed: opts.productContext !== 'failed-check', detail: 'Independent fixture check' };
  },
  async pipelineRecordActivity(opts, draft, source, results) {
    record(opts, 'record'); assert.equal(results.length, 13);
    assert.deepEqual(results.map(result => result.task), reviewed.taskIds);
    if (opts.productContext === 'infrastructure') {
      assert.ok(results.every(result => !result.passed && result.failureKind === 'infrastructure'));
      assert.match(results[1].detail, /Not executed/);
    }
    return 'private-test-eval.json';
  },
  async testActivity(_path, _url, task) { return { task, passed: true }; },
};
Runtime.install({ logger: new DefaultLogger('ERROR') });
async function worker(taskQueue, extra = {}) {
  const value = await Worker.create({ connection: native, taskQueue, workflowsPath, activities,
    maxConcurrentActivityTaskExecutions: 1, maxHeartbeatThrottleInterval: '5 seconds', shutdownGraceTime: '1 second',
    interceptors: { activity: [coreActivityContext] }, ...extra });
  const running = value.run(); running.catch(() => {});
  const state = { value, running }; workers.push(state);
  return state;
}
const opts = (runId, productContext) => ({ path: root, url: 'http://127.0.0.1:1', runId, provider: 'fixture', method: 'auto', security: 'balance', productContext, baseline: true });
try {
  const address = `127.0.0.1:${await port()}`;
  service = execa(temporal, ['--disable-config-file', '--disable-config-env', 'server', 'start-dev', '--headless',
    '--ip', '127.0.0.1', '--port', address.split(':')[1], '--db-filename', path.join(root, 'temporal.sqlite')], { cwd: root });
  service.catch(() => {});
  connection = await until(async () => Connection.connect({ address, connectTimeout: '1 second' }), 'isolated Temporal service startup', 45_000);
  native = await NativeConnection.connect({ address });
  const client = new Client({ connection });
  const queue = `core-${path.basename(root)}`;
  await worker(queue);
  const start = (runId, mode, taskQueue = queue) => client.workflow.start('coreWorkflow', { taskQueue, workflowId: runId, args: [opts(runId, mode)] });

  for (const mode of ['normal', 'reject', 'security-block', 'infrastructure', 'failed-check']) {
    const handle = await start(`fixture-${mode}`, mode);
    if (mode === 'security-block') await assert.rejects(handle.result(), /Workflow execution failed/);
    else {
      const result = await handle.result();
      assert.equal(result.status, mode === 'reject' ? 'rejected' : ['infrastructure', 'failed-check'].includes(mode) ? 'failed' : 'passed');
      if (mode === 'normal') { assert.equal(result.passed, 13); assert.equal(result.total, 13); }
    }
    const log = calls.get(`fixture-${mode}`);
    assert.deepEqual(log.slice(0, 3), ['discover', 'generate', 'security']);
    if (mode === 'normal') assert.deepEqual(log, ['discover', 'generate', 'security', 'review', 'baseline', 'apply', ...reviewed.taskIds, 'record']);
    if (mode === 'reject' || mode === 'security-block') assert.ok(!log.includes('apply'));
    if (mode === 'infrastructure') assert.equal(log.filter(stage => stage.startsWith('task-')).length, 1);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
  }
  const invalid = await client.workflow.start('repairWorkflow', { taskQueue: queue, workflowId: 'fixture-invalid-repair', args: [{ path: root, url: 'http://127.0.0.1:1', task: 'task', maxRepairs: -1 }] });
  await assert.rejects(invalid.result(), /Workflow execution failed/);
  assert.equal((await invalid.describe()).status.name, 'FAILED', 'Invalid input must fail, not retry a workflow task forever');

  const long = await start('fixture-long-review', 'long-review');
  await until(async () => (await long.query('coreProgress')).reviewUrl === 'http://127.0.0.1:4398', 'actual bound review URL in workflow query');
  assert.equal((await long.result()).status, 'passed', 'A review exceeding heartbeatTimeout must stay alive');
  const cancel = await start('fixture-cancel-review', 'cancel-review');
  await until(async () => (await cancel.query('coreProgress')).reviewUrl, 'review activity ready for cancellation');
  await cancel.cancel();
  await assert.rejects(cancel.result(), /cancel/i);
  assert.equal(cleaned, true, 'Workflow cancellation waits for owned operation cleanup');
  assert.ok(!calls.get('fixture-cancel-review').includes('apply'));
  await Worker.runReplayHistory({ workflowsPath }, await cancel.fetchHistory());

  const restartQueue = `${queue}-restart`;
  const first = await worker(restartQueue); restartWorker = first.value;
  const restarting = await start('fixture-restart', 'restart', restartQueue);
  await first.running;
  await worker(restartQueue);
  assert.equal((await restarting.result()).status, 'passed');
  assert.equal(calls.get('fixture-restart').filter(stage => stage === 'generate').length, 1, 'Completed generation is not rerun after worker restart');
  await Worker.runReplayHistory({ workflowsPath }, await restarting.fetchHistory());

  const legacyQueue = `${queue}-legacy`;
  const legacy = await worker(legacyQueue, { workflowsPath: fileURLToPath(new URL('./fixtures/legacy-temporal-workflows.cjs', import.meta.url)) });
  const old = await client.workflow.start('repairWorkflow', { taskQueue: legacyQueue, workflowId: 'fixture-old-repair-history', args: [{ path: root, url: 'http://127.0.0.1:1', task: 'legacy-task', runId: 'legacy', taskSetId: 'legacy' }] });
  assert.equal((await old.result()).passed, true);
  legacy.value.shutdown(); await legacy.running;
  await Worker.runReplayHistory({ workflowsPath }, await old.fetchHistory());
  console.log('Live Temporal verification passed: full ordered pipeline, 13 tests/no cap, optional baseline, rejection/security gates, infrastructure stop, real heartbeats/cancellation cleanup, completed-stage restart, invalid-input failure, and current/legacy history replay');
  passed = true;
} finally {
  for (const state of workers) {
    if (state.value.getState() === 'RUNNING') state.value.shutdown();
    await state.running.catch(() => {});
  }
  await native?.close(); await connection?.close();
  if (service) { service.kill('SIGTERM'); await service.catch(() => {}); }
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`Private live Temporal fixture retained at ${root}`);
}
