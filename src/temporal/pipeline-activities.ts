import { readFile } from "node:fs/promises";
import path from "node:path";
import { runDiscover } from "../commands/discover.js";
import { runGenerate } from "../commands/generate.js";
import { runSecurity } from "../commands/security.js";
import { runReviewPrompt } from "../commands/review.js";
import { runApply } from "../commands/apply.js";
import { runBaseline } from "../commands/baseline.js";
import { runApprovedTask, type StoredTestEvaluation } from "../commands/test.js";
import { withManagedChrome } from "../lib/browser.js";
import { closeScoringBrowser, type TaskResult } from "../lib/scoring.js";
import { gitSourceSnapshot, readPatchMetadata, readPendingPatch, sourcePatchHash } from "../lib/patches.js";
import { approvedManifestPath, loadApprovedTasks, taskFingerprint } from "../lib/tasks.js";
import { createTrajectoryArtifact } from "../lib/trajectories.js";
import { ensureTargetReachable } from "../lib/target-url.js";
import { reportTemporalReviewUrl } from "./activity-context.js";
import type { CoreWorkflowOptions, DraftIdentity, ReviewedDraft, SourceIdentity } from "./contracts.js";

async function assertDraft(sitePath: string, expected: DraftIdentity): Promise<void> {
  const metadata = await readPatchMetadata(sitePath);
  const hash = sourcePatchHash(await readPendingPatch(sitePath, metadata));
  if (metadata.runId !== expected.runId || hash !== expected.patchHash) {
    throw new Error("The pending draft changed during the durable pipeline. Restart with a fresh review; no other run may be applied.");
  }
}

async function assertApproval(sitePath: string, expected: ReviewedDraft): Promise<void> {
  const tasks = await loadApprovedTasks(sitePath);
  const approval = JSON.parse(await readFile(approvedManifestPath(sitePath), "utf8")) as {
    sourceDiff?: { runId?: string; patchHash?: string; status?: string };
  };
  if (!expected.approved || taskFingerprint(tasks) !== expected.taskSetId
    || approval.sourceDiff?.status !== "approved" || approval.sourceDiff.runId !== expected.runId
    || approval.sourceDiff.patchHash !== expected.patchHash) {
    throw new Error("The approved patch or task set changed during the durable pipeline. Refusing to use another run's approval.");
  }
}

async function assertSource(sitePath: string, expected: SourceIdentity): Promise<void> {
  const actual = await gitSourceSnapshot(sitePath);
  if (!expected.sourceVersion || !expected.workingTreeHash || actual.sourceVersion !== expected.sourceVersion
    || actual.workingTreeHash !== expected.workingTreeHash) {
    throw new Error("Target source changed between durable browser tasks. Earlier passes cannot count; review and rerun.");
  }
}

/** Activity results contain identities/counts, never the generated code or prompt. */
export async function pipelineDiscoverActivity(opts: CoreWorkflowOptions): Promise<void> {
  await ensureTargetReachable(opts.url);
  await runDiscover({ path: opts.path });
}

export async function pipelineGenerateActivity(opts: CoreWorkflowOptions): Promise<DraftIdentity> {
  await runGenerate({ path: opts.path, provider: opts.provider, method: opts.method, security: opts.security,
    productContext: opts.productContext, productContextPrompt: false });
  const metadata = await readPatchMetadata(opts.path);
  return { runId: metadata.runId, patchHash: sourcePatchHash(await readPendingPatch(opts.path, metadata)) };
}

export async function pipelineSecurityActivity(opts: CoreWorkflowOptions, draft: DraftIdentity): Promise<void> {
  await assertDraft(opts.path, draft);
  const report = await runSecurity({ path: opts.path, policy: opts.security });
  if (report.status === "block") throw new Error("Security blocked the durable draft. Inspect the local security report; no approval was created.");
}

export async function pipelineReviewActivity(opts: CoreWorkflowOptions, draft: DraftIdentity): Promise<ReviewedDraft> {
  await assertDraft(opts.path, draft);
  if ((await readPatchMetadata(opts.path)).securityPolicy !== opts.security) throw new Error("The durable draft's security policy changed before review.");
  const review = await runReviewPrompt(opts.path, opts.reviewPort, { durable: true, workflowRunId: opts.runId }, {
    onReady: reportTemporalReviewUrl,
  });
  if (!review.approved) return { ...draft, approved: false, taskSetId: "", taskIds: [], toolCount: 0 };
  if (!review.sourceDiff.runId || !review.sourceDiff.patchHash) throw new Error("Durable review returned no exact patch identity.");
  // Subset revision legitimately replaces the initial draft ID and test set.
  return { approved: true, runId: review.sourceDiff.runId, patchHash: review.sourceDiff.patchHash,
    taskSetId: taskFingerprint(review.tasks), taskIds: review.tasks.map(task => task.id), toolCount: review.tools.length };
}

export async function pipelineBaselineActivity(opts: CoreWorkflowOptions, draft: ReviewedDraft): Promise<string> {
  await assertApproval(opts.path, draft);
  const source = await gitSourceSnapshot(opts.path);
  const result = await withManagedChrome(opts.url, async () => {
    try { return await runBaseline({ path: opts.path, url: opts.url, provider: opts.provider, readOnly: true }); }
    finally { await closeScoringBrowser(); }
  });
  await assertApproval(opts.path, draft);
  await assertSource(opts.path, source);
  // Low UI baseline scores are valid measurements, but a broken provider isn't.
  if (result.agentError) throw new Error("The baseline browser/provider session failed. Inspect its private evaluation; the approved source was not applied.");
  return result.evaluationPath;
}

export async function pipelineApplyActivity(opts: CoreWorkflowOptions, draft: ReviewedDraft): Promise<SourceIdentity> {
  await assertApproval(opts.path, draft);
  if ((await readPatchMetadata(opts.path)).securityPolicy !== opts.security) throw new Error("The durable draft's security policy changed after review; refusing apply.");
  await runApply({ path: opts.path, expectedRunId: draft.runId, expectedPatchHash: draft.patchHash });
  return gitSourceSnapshot(opts.path);
}

export async function pipelineTestActivity(opts: CoreWorkflowOptions, draft: ReviewedDraft, source: SourceIdentity, task: string): Promise<TaskResult> {
  await assertApproval(opts.path, draft);
  await assertSource(opts.path, source);
  const result = await withManagedChrome(opts.url, async () => {
    try { return await runApprovedTask({ path: opts.path, url: opts.url, provider: opts.provider, taskId: task,
      runId: opts.runId, taskSetId: draft.taskSetId }); }
    finally { await closeScoringBrowser(); }
  });
  await assertApproval(opts.path, draft);
  await assertSource(opts.path, source);
  // Preserve useful independent scoring detail without unbounded history payloads.
  return { ...result, detail: result.detail.slice(0, 4000) };
}

export async function pipelineRecordActivity(opts: CoreWorkflowOptions, draft: ReviewedDraft, source: SourceIdentity, results: TaskResult[]): Promise<string> {
  await assertApproval(opts.path, draft);
  await assertSource(opts.path, source);
  const tasks = await loadApprovedTasks(opts.path);
  if (results.length !== tasks.length || results.some((result, index) => result.task !== tasks[index]?.id || typeof result.passed !== "boolean")) {
    throw new Error("Durable evaluation must contain exactly one ordered result for every approved task.");
  }
  const evaluation: StoredTestEvaluation = { version: 1, executionVersion: 1, mode: "webmcp", runId: opts.runId,
    targetProject: opts.path, taskSetId: draft.taskSetId, provider: opts.provider, url: opts.url,
    sourceSnapshot: source, recordedAt: new Date().toISOString(), tasks,
    scores: { passed: results.filter(result => result.passed).length, total: results.length, results } };
  const output = await createTrajectoryArtifact("test-eval", evaluation, { sitePath: opts.path, durable: true,
    runId: opts.runId, taskSetId: draft.taskSetId, approvalPath: path.join(opts.path, ".webmcpify", "approved-tools.json") });
  console.log(`[temporal] independent evaluation saved to ${output}`);
  return output;
}
