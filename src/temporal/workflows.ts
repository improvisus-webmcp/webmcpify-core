import { ActivityCancellationType, ApplicationFailure, defineQuery, defineSignal, isCancellation, patched, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type * as pipelineActivities from "./pipeline-activities.js";
import type { CoreProgress, CoreWorkflowOptions, CoreWorkflowResult } from "./contracts.js";

const { generateActivity, testActivity, applyActivity } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "30 minutes",
    heartbeatTimeout: "30 seconds",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    // Generation and apply mutate pending artifacts/source. Retrying without
    // an idempotency contract can race an operation that is still running.
    retry: { maximumAttempts: 1 },
  });
const { reviewActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "30 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});

export interface RepairWorkflowOptions {
  path: string;
  url: string;
  task: string;
  maxRepairs?: number;
  provider?: string;
  runId?: string;
  taskSetId?: string;
}

export interface RepairWorkflowResult {
  passed: boolean;
  attempts: number;
  task: string;
  reason?: string;
}

export async function repairWorkflow(
  opts: RepairWorkflowOptions
): Promise<RepairWorkflowResult> {
  // Preserve the commands/timeouts of histories started by older Core workers.
  const current = patched("core-repair-long-running-v2");
  const repair = current ? proxyActivities<typeof activities>({
    startToCloseTimeout: "2 hours", heartbeatTimeout: "30 seconds",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED, retry: { maximumAttempts: 1 },
  }) : { generateActivity, testActivity, applyActivity };
  const reviewRepair = current ? proxyActivities<typeof activities>({
    startToCloseTimeout: "7 days", heartbeatTimeout: "30 seconds",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED, retry: { maximumAttempts: 1 },
  }).reviewActivity : reviewActivity;
  const maxRepairs = opts.maxRepairs ?? 3;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0) {
    if (current) throw ApplicationFailure.nonRetryable("maxRepairs must be a non-negative safe integer", "InvalidRepairOptions");
    throw new Error("maxRepairs must be a non-negative integer");
  }

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const result = await repair.testActivity(opts.path, opts.url, opts.task, attempt, opts.runId, opts.taskSetId, opts.provider);
    if (result.passed) {
      return { passed: true, attempts: attempt, task: opts.task };
    }

    if (attempt === maxRepairs) {
      return {
        passed: false,
        attempts: attempt,
        task: opts.task,
        reason: result.detail ?? "The task still failed after the repair budget.",
      };
    }

    await repair.generateActivity(opts.path, result.detail, opts.provider, attempt, opts.url, opts.task);
    const review = await reviewRepair(opts.path, attempt);
    if (!review.approved) {
      return {
        passed: false,
        attempts: attempt,
        task: opts.task,
        reason: "The owner rejected the proposed repair.",
      };
    }
    if (current) {
      if (!review.sourceDiff.runId || !review.sourceDiff.patchHash) throw ApplicationFailure.nonRetryable("Review returned no exact patch identity", "InvalidReviewIdentity");
      if (opts.taskSetId && review.taskSetId !== opts.taskSetId) throw ApplicationFailure.nonRetryable("The approved task set changed during repair review", "ChangedRepairTaskSet");
      await repair.applyActivity(opts.path, { runId: review.sourceDiff.runId, patchHash: review.sourceDiff.patchHash });
    } else await repair.applyActivity(opts.path);
  }

  // The loop always returns, but keeping an explicit fallback makes future
  // changes to the loop bounds type-safe and obvious.
  return {
    passed: false,
    attempts: maxRepairs,
    task: opts.task,
    reason: "The repair workflow ended without a result.",
  };
}

export const coreProgress = defineQuery<CoreProgress>("coreProgress");
export const coreReviewReady = defineSignal<[string]>("coreReviewReady");

/** Full opt-in pipeline; no filesystem/browser/provider code runs in the sandbox. */
export async function coreWorkflow(opts: CoreWorkflowOptions): Promise<CoreWorkflowResult> {
  const minutes = opts.activityTimeoutMinutes ?? 120;
  const hours = opts.reviewTimeoutHours ?? 168;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080
    || !Number.isSafeInteger(hours) || hours < 1 || hours > 8760
    || !opts.path || !opts.url || !opts.runId || !opts.provider || !opts.method
    || !["balance", "strict", "ignore"].includes(opts.security)) {
    throw ApplicationFailure.nonRetryable("Invalid durable run options or timeout bounds", "InvalidCoreOptions");
  }
  const progress: CoreProgress = { path: opts.path, url: opts.url, phase: "discovery", completedTasks: 0, totalTasks: 0 };
  setHandler(coreProgress, () => ({ ...progress }));
  setHandler(coreReviewReady, url => {
    if (progress.phase === "review" && /^http:\/\/127\.0\.0\.1:\d+$/.test(url)) progress.reviewUrl = url;
  });
  const common = { heartbeatTimeout: "30 seconds", cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 } };
  const steps = proxyActivities<typeof pipelineActivities>({ ...common, startToCloseTimeout: minutes * 60_000 });
  await steps.pipelineDiscoverActivity(opts);
  progress.phase = "generation";
  const draft = await steps.pipelineGenerateActivity(opts);
  progress.phase = "security";
  await steps.pipelineSecurityActivity(opts, draft);
  progress.phase = "review";
  const reviewed = await proxyActivities<typeof pipelineActivities>({ ...common, startToCloseTimeout: hours * 3_600_000 })
    .pipelineReviewActivity(opts, draft);
  delete progress.reviewUrl;
  if (!reviewed.approved) {
    progress.phase = "rejected";
    return { status: "rejected", passed: 0, total: 0 };
  }
  if (!reviewed.taskSetId || !reviewed.runId || !reviewed.patchHash || !reviewed.taskIds.length
    || new Set(reviewed.taskIds).size !== reviewed.taskIds.length) {
    throw ApplicationFailure.nonRetryable("Review returned an incomplete approved task set", "InvalidReviewIdentity");
  }
  progress.totalTasks = reviewed.taskIds.length;
  let baselinePath: string | undefined;
  if (opts.baseline) {
    progress.phase = "baseline";
    // UI comparison covers all tasks; its budget scales with the approved set.
    baselinePath = await proxyActivities<typeof pipelineActivities>({ ...common,
      startToCloseTimeout: minutes * 60_000 * Math.max(1, reviewed.taskIds.length) }).pipelineBaselineActivity(opts, reviewed);
  }
  progress.phase = "apply";
  const source = await steps.pipelineApplyActivity(opts, reviewed);
  progress.phase = "verification";
  const results = [];
  for (const task of reviewed.taskIds) {
    try { results.push(await steps.pipelineTestActivity(opts, reviewed, source, task)); }
    catch (error) {
      if (isCancellation(error)) throw error;
      const attempted = results.length + 1;
      // Broken provider/browser infrastructure is not an application repair
      // opportunity and must not leave remaining tasks looking executed.
      for (const pending of reviewed.taskIds.slice(results.length)) results.push({ task: pending, passed: false,
        failureKind: "infrastructure" as const, detail: pending === task
          ? "Durable task activity failed. Inspect Temporal history and private task diagnostics; this is not an expected business rejection."
          : "Not executed because the durable browser/provider activity failed." });
      progress.completedTasks = attempted;
      break;
    }
    progress.completedTasks = results.length;
  }
  progress.phase = "recording evaluation";
  const evaluationPath = await steps.pipelineRecordActivity(opts, reviewed, source, results);
  const passed = results.filter(result => result.passed).length;
  const status = passed === results.length ? "passed" : "failed";
  progress.phase = status;
  return { status, passed, total: results.length, evaluationPath, ...(baselinePath ? { baselinePath } : {}) };
}
