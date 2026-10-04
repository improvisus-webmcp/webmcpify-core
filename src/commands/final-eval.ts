import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runApply } from "./apply.js";
import { runBaseline } from "./baseline.js";
import { runGenerate } from "./generate.js";
import { runRepair } from "./repair.js";
import { runReviewPrompt } from "./review.js";
import { runTest, type StoredTestEvaluation } from "./test.js";
import { loadApprovedTasks, taskFingerprint, type Task } from "../lib/tasks.js";
import { gitSourceSnapshot, readPatchMetadata } from "../lib/patches.js";
import { createTrajectoryArtifact, latestTrajectoryPath } from "../lib/trajectories.js";
import { closeScoringBrowser, isNonApplicationFailure, type TaskScoreSummary, type TaskResult } from "../lib/scoring.js";
import { withManagedChrome } from "../lib/browser.js";
import { ensureTargetReachable, normalizeTargetUrl } from "../lib/target-url.js";
import { loadTemporalClient, temporalConnectionOptions } from "../lib/temporal.js";
import { resolveProvider } from "../lib/ai-provider.js";

export interface FinalEvalOptions {
  path?: string;
  url?: string;
  provider?: string;
  reviewPort?: string;
  baseline?: boolean;
}

interface LevelResult {
  level: "baseline" | "webmcp" | "temporal";
  runId: string;
  targetProject: string;
  taskSetId: string;
  tasks: Task[];
  scores: TaskScoreSummary;
  evaluationPath?: string;
  status: "completed" | "failed";
  error?: string;
  agentError?: string;
}

type FinalEvalStage = "baseline" | "apply" | "webmcp-test" | "repair" | "temporal" | "complete";

interface FinalEvalCheckpoint {
  version: 1;
  runId: string;
  targetProject: string;
  provider: string;
  url: string;
  taskSetId: string;
  approvalRunId: string;
  stage: FinalEvalStage;
  updatedAt: string;
  includeBaseline?: boolean;
  baselineEvaluationPath?: string;
  webmcpEvaluationPath?: string;
  repair?: FinalEvalResult["repair"];
}

interface ResumableFinalEval {
  tasks: Task[];
  taskSetId: string;
  approvalRunId: string;
  checkpoint?: FinalEvalCheckpoint;
  stage: Exclude<FinalEvalStage, "complete">;
}

export interface FinalEvalResult {
  version: 1;
  runId: string;
  targetProject: string;
  taskSetId: string;
  tasks: Task[];
  levels: LevelResult[];
  finalTestRunId?: string;
  repair?: { beforeEvaluation?: string; afterEvaluation?: string; status: string };
}

export function buildFinalEvalPlan(includeBaseline = false): string[] {
  return ["prepare-and-review", ...(includeBaseline ? ["baseline"] : []), "apply-and-test", "repair-if-needed", "temporal-evaluation", "compare-and-record"];
}

/** A completed comparison is not necessarily a successful capability audit. */
export function finalEvalVerified(level: Pick<LevelResult, "status" | "scores">): boolean {
  return level.status === "completed" && level.scores.total > 0 && level.scores.results.length === level.scores.total
    && level.scores.passed === level.scores.total && level.scores.results.every(result => result.passed && !isNonApplicationFailure(result));
}

/** Low UI scores are valid; broken baseline execution is not a comparison. */
export function finalEvalComparisonComplete(baseline: Pick<LevelResult, "status" | "scores" | "agentError">,
  final: Pick<LevelResult, "status" | "scores">): boolean {
  return baseline.status === "completed" && !baseline.agentError && baseline.scores.total > 0
    && baseline.scores.results.length === baseline.scores.total
    && !baseline.scores.results.some(isNonApplicationFailure) && finalEvalVerified(final);
}

export function compareTaskSets(tasks: Task[], candidate: Task[]): void {
  if (taskFingerprint(tasks) !== taskFingerprint(candidate)) {
    throw new Error("Final evaluation levels do not use the exact same task definitions.");
  }
}

export function assertRepairableWebMcpResults(scores: TaskScoreSummary): void {
  if (scores.results.some(isNonApplicationFailure)) {
    throw new Error("[final-eval] WebMCP execution infrastructure/evidence or the verification expression failed, not a proven application defect. No source repair or durable evaluation will be started from these results. Fix the Chrome DevTools/provider connection or regenerate/review an invalid task check, then retry.");
  }
}

function failedSummary(tasks: Task[], error: unknown): TaskScoreSummary {
  const detail = error instanceof Error ? error.message : String(error);
  return { passed: 0, total: tasks.length, results: tasks.map((task) => ({ task: task.id, passed: false, detail })) };
}

function finalEvalCheckpointPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "final-eval-state.json");
}

async function writeFinalEvalCheckpoint(
  sitePath: string,
  checkpoint: FinalEvalCheckpoint,
): Promise<void> {
  await writeFile(
    finalEvalCheckpointPath(sitePath),
    `${JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function readFinalEvalCheckpoint(sitePath: string): Promise<FinalEvalCheckpoint | undefined> {
  try {
    return JSON.parse(await readFile(finalEvalCheckpointPath(sitePath), "utf8")) as FinalEvalCheckpoint;
  } catch {
    return undefined;
  }
}

export function matchesEvaluationContext(value: unknown, expected: {
  sitePath: string; taskSetId: string; mode: "baseline" | "webmcp"; url: string; provider: string;
  sourceSnapshot?: Awaited<ReturnType<typeof gitSourceSnapshot>>;
}): value is StoredTestEvaluation {
  try {
    if (!value || typeof value !== "object") return false;
    const evaluation = value as StoredTestEvaluation;
    if (evaluation.version !== 1 || evaluation.executionVersion !== 1 || evaluation.mode !== expected.mode
      || evaluation.provider !== expected.provider || evaluation.url !== expected.url
      || typeof evaluation.targetProject !== "string" || path.resolve(evaluation.targetProject) !== path.resolve(expected.sitePath)
      || evaluation.taskSetId !== expected.taskSetId || taskFingerprint(evaluation.tasks) !== expected.taskSetId) return false;
    const { scores } = evaluation;
    if (!scores || !Array.isArray(scores.results) || scores.total !== evaluation.tasks.length || scores.total < 1
      || scores.results.length !== scores.total || scores.passed !== scores.results.filter(result => result.passed === true).length) return false;
    const ids = new Set(evaluation.tasks.map(task => task.id));
    if (ids.size !== evaluation.tasks.length || new Set(scores.results.map(result => result.task)).size !== ids.size
      || scores.results.some(result => !ids.has(result.task) || typeof result.passed !== "boolean" || typeof result.detail !== "string")) return false;
    if (expected.mode === "webmcp") {
      const recorded = evaluation.sourceSnapshot;
      const current = expected.sourceSnapshot;
      if (!recorded?.sourceVersion || !recorded.workingTreeHash || !current?.sourceVersion || !current.workingTreeHash
        || recorded.sourceVersion !== current.sourceVersion || recorded.workingTreeHash !== current.workingTreeHash) return false;
    }
    if (expected.mode === "baseline" && evaluation.readOnly !== true) return false;
    return true;
  } catch { return false; }
}

async function readMatchingEvaluation(
  sitePath: string,
  role: "baseline-eval" | "test-eval",
  taskSetId: string,
  context: { url: string; provider: string },
  explicitPath?: string,
): Promise<{ path: string; value: StoredTestEvaluation } | undefined> {
  try {
    const evaluationPath = explicitPath ?? (await latestTrajectoryPath(role, sitePath));
    if (!evaluationPath || !existsSync(evaluationPath)) return undefined;
    const value = JSON.parse(await readFile(evaluationPath, "utf8")) as StoredTestEvaluation;
    if (!matchesEvaluationContext(value, {
      sitePath, taskSetId, mode: role === "test-eval" ? "webmcp" : "baseline", ...context,
      sourceSnapshot: role === "test-eval" ? await gitSourceSnapshot(sitePath) : undefined,
    })) return undefined;
    return { path: evaluationPath, value };
  } catch {
    return undefined;
  }
}

function evaluationHasAvailabilityFailure(value: StoredTestEvaluation): boolean {
  return value.scores.results.some(result => result.failureKind === "infrastructure" || result.failureKind === "evidence")
    || (value.scores.results.length > 0 && value.scores.results.every((result) =>
      /ERR_CONNECTION_REFUSED|ECONNREFUSED|Could not connect to Chrome|target URL is not reachable/i.test(result.detail)
    ));
}

async function findResumableFinalEval(sitePath: string, context: { url: string; provider: string; includeBaseline: boolean }): Promise<ResumableFinalEval | undefined> {
  const approvalPath = path.join(sitePath, ".webmcpify", "approved-tools.json");
  const metadataPath = path.join(sitePath, ".webmcpify", "pending-diff.meta.json");
  if (!existsSync(approvalPath) || !existsSync(metadataPath)) return undefined;

  try {
    const approval = JSON.parse(await readFile(approvalPath, "utf8")) as {
      approved?: boolean;
      approvalId?: string;
      sourceDiff?: { status?: string; runId?: string };
    };
    const patch = await readPatchMetadata(sitePath);
    const approvalRunId = approval.sourceDiff?.runId ?? approval.approvalId;
    const tasks = await loadApprovedTasks(sitePath);
    const taskSetId = taskFingerprint(tasks);
    const checkpoint = await readFinalEvalCheckpoint(sitePath);
    if (
      checkpoint &&
      (checkpoint.version !== 1 || path.resolve(checkpoint.targetProject) !== path.resolve(sitePath) || checkpoint.taskSetId !== taskSetId)
    ) return undefined;
    if (checkpoint?.stage === "complete") return undefined;

    const standardPatchState = approval.approved === true
      && approval.sourceDiff?.status === "approved"
      && Boolean(approvalRunId)
      && approvalRunId === patch.runId
      // A failed apply must be regenerated after the cause is fixed. Reusing
      // the same failed patch would only repeat the failure on every retry.
      && ["approved", "applied"].includes(patch.patchStatus);
    const repairPatchMatchesEvaluation = Boolean(
      checkpoint?.webmcpEvaluationPath
      && patch.repair?.sourceEvaluation === checkpoint.webmcpEvaluationPath
        && ["awaiting-review", "approved", "applied"].includes(patch.patchStatus),
    );
    const rejectedRepairAfterEvaluation = Boolean(
      checkpoint?.stage === "temporal"
      && checkpoint.webmcpEvaluationPath
      && patch.repair?.sourceEvaluation === checkpoint.webmcpEvaluationPath
      && patch.patchStatus === "rejected",
    );
    if (!standardPatchState && !repairPatchMatchesEvaluation && !rejectedRepairAfterEvaluation) return undefined;
    if (checkpoint && checkpoint.approvalRunId !== approvalRunId && checkpoint.stage !== "repair") return undefined;
    const resumableApprovalRunId = approvalRunId ?? patch.runId;
    if (!resumableApprovalRunId) return undefined;

    let stage: Exclude<FinalEvalStage, "complete"> = checkpoint?.stage ?? (context.includeBaseline ? "baseline" : "apply");
    if (!checkpoint) {
      // A newly requested baseline must execute before this run's browser test;
      // do not silently reuse an unrelated older baseline artifact.
      stage = context.includeBaseline ? "baseline" : "apply";
    }
    return { tasks, taskSetId, approvalRunId: resumableApprovalRunId, checkpoint, stage };
  } catch {
    return undefined;
  }
}

async function confirmResume(resumable: ResumableFinalEval): Promise<boolean> {
  const description = resumable.checkpoint
    ? `stage ${resumable.checkpoint.stage} (updated ${resumable.checkpoint.updatedAt})`
    : `stage ${resumable.stage} (approved artifacts found)`;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`[final-eval] resumable state found at ${description}; non-interactive run will start fresh.`);
    return false;
  }

  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      `[final-eval] resumable approved state found at ${description}. Continue from there? [y/N] `,
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function runTemporalLevel(sitePath: string, url: string, provider: string, tasks: Task[], runId: string, taskSetId: string, seedScores?: TaskScoreSummary): Promise<LevelResult> {
  const { Client, Connection } = await loadTemporalClient();
  const connection = await Connection.connect(temporalConnectionOptions());
  try {
    const client = new Client({ connection, namespace: process.env.WEBMCPIFY_TEMPORAL_NAMESPACE ?? "default" });
    const results: TaskResult[] = [];
    for (const [index, task] of tasks.entries()) {
      const existing = seedScores?.results.find((result) => result.task === task.id);
      if (existing?.passed) {
        results.push({
          task: task.id,
          passed: true,
          detail: "reused independently verified WebMCP result; no Temporal repair required",
        });
        console.log(`[temporal] task ${index + 1}/${tasks.length} passed: ${task.id} (reused WebMCP result)`);
        continue;
      }
      console.log(`[temporal] task ${index + 1}/${tasks.length} started: ${task.id}`);
      const source = await gitSourceSnapshot(sitePath);
      const sourceId = createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 12);
      const workflowId = `final-eval-${runId}-${task.id}-${sourceId}`;
      const startOptions = {
        taskQueue: process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify",
        workflowId,
        workflowIdConflictPolicy: "USE_EXISTING" as const,
        workflowIdReusePolicy: "REJECT_DUPLICATE" as const,
        args: [{ path: sitePath, url, task: task.id, maxRepairs: 1, provider, runId, taskSetId }],
      };
      const handle = await client.workflow.start("repairWorkflow", startOptions).catch(error => {
        if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError") {
          // REJECT_DUPLICATE also returns this error for a closed execution.
          // It cannot be replaced by another run using this private run ID.
          return client.workflow.getHandle(workflowId);
        }
        throw error;
      });
      const result = await handle.result();
      results.push({ task: task.id, passed: result.passed, detail: result.reason ?? `durable workflow completed after ${result.attempts} repair attempt(s)` });
      console.log(`[temporal] task ${index + 1}/${tasks.length} ${result.passed ? "passed" : "failed"}: ${task.id}`);
    }
    const scores = { passed: results.filter((result) => result.passed).length, total: tasks.length, results };
    return { level: "temporal", runId, targetProject: sitePath, taskSetId, tasks, scores, status: "completed" };
  } finally {
    await connection.close();
  }
}

export async function runFinalEval(opts: FinalEvalOptions): Promise<FinalEvalResult> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const targetUrl = opts.url ?? process.env.WEBMCPIFY_URL;
  if (!targetUrl) {
    throw new Error('A running site URL is required. Pass --url <url> or set WEBMCPIFY_URL.');
  }
  const url = normalizeTargetUrl(targetUrl);
  const provider = resolveProvider(opts.provider);
  // This comparison always includes Temporal. Fail before launching Chrome or
  // spending a provider run on a draft that cannot complete the chosen flow.
  await loadTemporalClient();
  temporalConnectionOptions();
  await ensureTargetReachable(url);
  return withManagedChrome(url, async () => {
    try {
      return await runFinalEvalWithBrowser(opts, sitePath, url, provider);
    } finally {
      await closeScoringBrowser();
    }
  });
}

async function runFinalEvalWithBrowser(opts: FinalEvalOptions, sitePath: string, url: string, provider: string): Promise<FinalEvalResult> {
  console.log(`[final-eval] target: ${sitePath}`);
  console.log(`[final-eval] URL: ${url}`);
  const includeBaseline = opts.baseline === true;
  const evaluationContext = { url, provider, includeBaseline };
  const resumable = await findResumableFinalEval(sitePath, evaluationContext);
  const canResume = resumable
    && (!resumable.checkpoint || (resumable.checkpoint.provider === provider && resumable.checkpoint.url === url))
    && await confirmResume(resumable);

  let runId: string;
  let tasks: Task[];
  let taskSetId: string;
  let approvalRunId: string;
  let stage: FinalEvalStage;
  let baselineEvaluationPath: string | undefined;
  let webmcpEvaluationPath: string | undefined;
  let repair: FinalEvalResult["repair"];

  if (canResume && resumable) {
    if (resumable.checkpoint?.includeBaseline !== undefined && resumable.checkpoint.includeBaseline !== includeBaseline) {
      throw new Error(`[final-eval] This checkpoint was started ${resumable.checkpoint.includeBaseline ? "with --baseline" : "without --baseline"}. Resume with the same option, or decline resume to start a new run. No approved source changes were made.`);
    }
    runId = resumable.checkpoint?.runId ?? randomUUID();
    tasks = resumable.tasks;
    taskSetId = resumable.taskSetId;
    approvalRunId = resumable.approvalRunId;
    stage = resumable.stage;
    baselineEvaluationPath = resumable.checkpoint?.baselineEvaluationPath;
    webmcpEvaluationPath = resumable.checkpoint?.webmcpEvaluationPath;
    repair = resumable.checkpoint?.repair;
    console.log(`[final-eval] resuming run ${runId} from ${stage}; reusing approved task set ${taskSetId}`);
  } else {
    runId = randomUUID();
    console.log("[final-eval] preparing discovery, structured proposals, and human review...");
    await runGenerate({ path: sitePath, provider, trajectoryMetadata: { finalEvalRunId: runId, level: "preparation" } });
    const review = await runReviewPrompt(sitePath, opts.reviewPort ?? "4173", { finalEvalRunId: runId, level: "preparation" });
    console.log(`[final-eval] review decision: ${review.approved ? "APPROVED" : "REJECTED"}`);
    if (!review.approved) throw new Error("Final evaluation stopped because the WebMCP proposal was rejected.");

    tasks = await loadApprovedTasks(sitePath);
    taskSetId = taskFingerprint(tasks);
    approvalRunId = review.sourceDiff.runId ?? "";
    if (!approvalRunId) throw new Error("Approved review did not identify the approved source-diff run.");
    stage = includeBaseline ? "baseline" : "apply";
    console.log(`[final-eval] approval confirmed: ${tasks.length} task(s), task set ${taskSetId}`);
    console.log("[final-eval] continuing automatically with:");
    if (includeBaseline) console.log("[final-eval]   UI-only baseline for every task (before applying source changes)");
    console.log("[final-eval]   apply the approved patch and build the target project");
    console.log("[final-eval]   run WebMCP browser tests");
    console.log("[final-eval]   repair failed tasks if needed, with a second approval");
    console.log("[final-eval]   run the durable Temporal evaluation");
  }

  const saveCheckpoint = async (nextStage: FinalEvalStage): Promise<void> => {
    await writeFinalEvalCheckpoint(sitePath, {
      version: 1,
      runId,
      targetProject: sitePath,
      provider,
      url,
      taskSetId,
      approvalRunId,
      stage: nextStage,
      updatedAt: new Date().toISOString(),
      includeBaseline,
      baselineEvaluationPath,
      webmcpEvaluationPath,
      repair,
    });
  };

  let baselineLevel: LevelResult | undefined;
  if (!includeBaseline) {
    baselineEvaluationPath = undefined;
    if (stage === "baseline") stage = "apply";
    console.log("[final-eval] UI baseline skipped (add --baseline to include the full comparison)");
  } else if (stage === "baseline") {
    // Retain the reviewed identity even if baseline execution is interrupted.
    await saveCheckpoint(stage);
    console.log("[final-eval] Level 1 — baseline (plain, read-only)...");
    const baselineSource = await gitSourceSnapshot(sitePath);
    let baseline: Awaited<ReturnType<typeof runBaseline>> | undefined;
    let baselineError: string | undefined;
    try {
      baseline = await runBaseline({ path: sitePath, url, provider, readOnly: true });
    } catch (error) {
      baselineError = error instanceof Error ? error.message : String(error);
      console.error(`[final-eval] baseline failed; preserving the approved patch flow: ${baselineError}`);
    }
    const afterBaselineSource = await gitSourceSnapshot(sitePath);
    if (baselineSource.sourceVersion !== afterBaselineSource.sourceVersion || baselineSource.workingTreeHash !== afterBaselineSource.workingTreeHash) {
      throw new Error("The read-only baseline changed target source; refusing to continue to WebMCP application.");
    }
    if (baseline) {
      compareTaskSets(tasks, baseline.tasks);
      baselineEvaluationPath = baseline.evaluationPath;
      baselineLevel = { level: "baseline", runId: baseline.runId, targetProject: sitePath, taskSetId, tasks, scores: baseline.scores, evaluationPath: baseline.evaluationPath, status: baseline.agentError ? "failed" : "completed", agentError: baseline.agentError };
    } else {
      baselineEvaluationPath = await createTrajectoryArtifact(
        "baseline-eval",
        { version: 1, executionVersion: 1, mode: "baseline", readOnly: true, provider, url, runId: randomUUID(), targetProject: sitePath, taskSetId, tasks, agentError: baselineError ?? "Baseline did not complete.", scores: failedSummary(tasks, baselineError ?? "Baseline did not complete.") },
        { sitePath, targetProject: sitePath, taskSetId, provider, url, status: "failed", error: baselineError },
      );
      baselineLevel = { level: "baseline", runId, targetProject: sitePath, taskSetId, tasks, scores: failedSummary(tasks, baselineError ?? "Baseline did not complete."), evaluationPath: baselineEvaluationPath, status: "failed", error: baselineError ?? "Baseline did not complete." };
    }
    stage = "apply";
    await saveCheckpoint(stage);
  } else {
    const baselineArtifact = await readMatchingEvaluation(sitePath, "baseline-eval", taskSetId, evaluationContext, baselineEvaluationPath);
    if (!baselineArtifact) throw new Error(`[final-eval] Cannot resume from ${stage}: a current, matching UI-only baseline evaluation is missing or outdated. URL/provider/task set must match; restart final-eval for a new comparison.`);
    baselineEvaluationPath = baselineArtifact.path;
    const baseline = baselineArtifact.value;
    compareTaskSets(tasks, baseline.tasks);
    baselineLevel = { level: "baseline", runId: baseline.runId, targetProject: sitePath, taskSetId, tasks, scores: baseline.scores, evaluationPath: baselineArtifact.path, status: baseline.agentError ? "failed" : "completed", agentError: baseline.agentError };
  }

  if (stage === "apply") {
    console.log("[final-eval] Level 2 — applying approved WebMCP change...");
    const patch = await readPatchMetadata(sitePath);
    if (patch.runId !== approvalRunId) throw new Error("The pending patch changed after this final-eval run's review; refusing another run's patch.");
    if (patch.patchStatus === "applied") {
      console.log("[final-eval] approved patch is already applied; skipping duplicate application");
    } else {
      await runApply({ path: sitePath, expectedRunId: approvalRunId });
    }
    stage = "webmcp-test";
    await saveCheckpoint(stage);
    console.log("[final-eval] approved patch applied; next: run the WebMCP browser tests");
  }

  let webmcpLevel: LevelResult;
  if (stage === "webmcp-test") {
    const existingWebmcp = includeBaseline && !webmcpEvaluationPath ? undefined
      : await readMatchingEvaluation(sitePath, "test-eval", taskSetId, evaluationContext, webmcpEvaluationPath);
    const webmcpEvaluation = existingWebmcp?.value ?? await runTest({ path: sitePath, url, provider });
    compareTaskSets(tasks, webmcpEvaluation.tasks);
    const webmcpArtifact = existingWebmcp ?? await readMatchingEvaluation(sitePath, "test-eval", taskSetId, evaluationContext);
    if (!webmcpArtifact) throw new Error("WebMCP test completed but its project-scoped evaluation artifact could not be found.");
    webmcpEvaluationPath = webmcpArtifact.path;
    webmcpLevel = { level: "webmcp", runId: webmcpEvaluation.runId, targetProject: sitePath, taskSetId, tasks, scores: webmcpEvaluation.scores, evaluationPath: webmcpArtifact.path, status: "completed", agentError: webmcpEvaluation.agentError };
    stage = webmcpLevel.scores.results.some((result) => !result.passed) ? "repair" : "temporal";
    await saveCheckpoint(stage);
  } else {
    let webmcpArtifact = await readMatchingEvaluation(sitePath, "test-eval", taskSetId, evaluationContext, webmcpEvaluationPath);
    if (!webmcpArtifact || evaluationHasAvailabilityFailure(webmcpArtifact.value)) {
      console.log("[final-eval] previous WebMCP evaluation is stale or had a target/browser/provider or execution-evidence failure; refreshing it before considering application repair...");
      await runTest({ path: sitePath, url, provider });
      webmcpArtifact = await readMatchingEvaluation(sitePath, "test-eval", taskSetId, evaluationContext);
      if (!webmcpArtifact) throw new Error("Refreshed WebMCP test completed but its project-scoped evaluation artifact could not be found.");
    }
    webmcpEvaluationPath = webmcpArtifact.path;
    const webmcpEvaluation = webmcpArtifact.value;
    compareTaskSets(tasks, webmcpEvaluation.tasks);
    webmcpLevel = { level: "webmcp", runId: webmcpEvaluation.runId, targetProject: sitePath, taskSetId, tasks, scores: webmcpEvaluation.scores, evaluationPath: webmcpArtifact.path, status: "completed", agentError: webmcpEvaluation.agentError };
  }

  if (webmcpLevel.scores.results.some(isNonApplicationFailure)) {
    await saveCheckpoint("repair");
    assertRepairableWebMcpResults(webmcpLevel.scores);
  }

  if (stage === "repair") {
    if (!webmcpLevel.scores.results.some((result) => !result.passed)) {
      stage = "temporal";
      await saveCheckpoint(stage);
      console.log("[final-eval] repair stage complete; next: run the durable Temporal evaluation");
    } else {
      console.log("[final-eval] WebMCP failures found; starting approved repair flow...");
      const beforeEvaluation = webmcpEvaluationPath;
      const pendingRepair = await readPatchMetadata(sitePath).catch(() => undefined);
      const repairPatchAlreadyApplied = Boolean(
        beforeEvaluation
        && pendingRepair?.repair?.sourceEvaluation === beforeEvaluation
        && pendingRepair.patchStatus === "applied",
      );
      const canReviewExistingRepair = Boolean(
        beforeEvaluation
        && pendingRepair?.repair?.sourceEvaluation === beforeEvaluation
        && ["awaiting-review", "approved"].includes(pendingRepair.patchStatus),
      );
      let repairedEvaluation: Awaited<ReturnType<typeof runTest>> | undefined;
      if (repairPatchAlreadyApplied) {
        console.log("[final-eval] existing approved repair patch is already applied; resuming its retest");
        repairedEvaluation = await runTest({ path: sitePath, url, provider });
      } else {
        if (!canReviewExistingRepair) {
          await runRepair({ path: sitePath, url, provider, durable: false, evaluationPath: beforeEvaluation });
        } else {
          console.log(`[final-eval] found an existing repair patch for ${path.basename(beforeEvaluation ?? "the failed evaluation")}; resuming its review`);
        }
        const repairReview = await runReviewPrompt(sitePath, process.env.WEBMCPIFY_REPAIR_REVIEW_PORT ?? "4174", { finalEvalRunId: runId, level: "repair", sourceEvaluation: beforeEvaluation });
        console.log(`[final-eval] repair review decision: ${repairReview.approved ? "APPROVED" : "REJECTED"}`);
        if (repairReview.approved) {
          approvalRunId = repairReview.sourceDiff.runId ?? approvalRunId;
          if (!repairReview.sourceDiff.runId || !repairReview.sourceDiff.patchHash) throw new Error("Repair review returned no exact patch identity.");
          await runApply({ path: sitePath, expectedRunId: repairReview.sourceDiff.runId, expectedPatchHash: repairReview.sourceDiff.patchHash });
          repairedEvaluation = await runTest({ path: sitePath, url, provider });
        }
        if (!repairReview.approved) {
          repair = { beforeEvaluation, status: "rejected" };
        }
      }
      if (repairedEvaluation) {
        compareTaskSets(tasks, repairedEvaluation.tasks);
        const afterArtifact = await readMatchingEvaluation(sitePath, "test-eval", taskSetId, evaluationContext);
        if (!afterArtifact) throw new Error("Repair retest completed but its project-scoped evaluation artifact could not be found.");
        const status = repairedEvaluation.scores.passed > webmcpLevel.scores.passed
          ? "improved"
          : repairedEvaluation.scores.passed < webmcpLevel.scores.passed ? "regressed" : "unchanged";
        repair = { beforeEvaluation, afterEvaluation: afterArtifact.path, status };
        webmcpEvaluationPath = afterArtifact.path;
        webmcpLevel = { ...webmcpLevel, runId: repairedEvaluation.runId, scores: repairedEvaluation.scores, evaluationPath: afterArtifact.path, agentError: repairedEvaluation.agentError };
        await saveCheckpoint("repair");
        assertRepairableWebMcpResults(webmcpLevel.scores);
        console.log(`[final-eval] repair result: ${status} (${repairedEvaluation.scores.passed}/${repairedEvaluation.scores.total})`);
      }
      stage = "temporal";
      await saveCheckpoint(stage);
    }
  }

  console.log("[final-eval] Level 3 — durable Temporal evaluation...");
  console.log(`[final-eval] connecting to Temporal at ${process.env.WEBMCPIFY_TEMPORAL_ADDRESS ?? "localhost:7233"}; worker task queue: ${process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify"}`);
  let temporalLevel: LevelResult;
  let finalTestRunId = webmcpLevel.runId;
  try {
    const beforeTemporal = await gitSourceSnapshot(sitePath);
    temporalLevel = await runTemporalLevel(sitePath, url, provider, tasks, runId, taskSetId, webmcpLevel.scores);
    const afterTemporal = await gitSourceSnapshot(sitePath);
    if (beforeTemporal.sourceVersion !== afterTemporal.sourceVersion || beforeTemporal.workingTreeHash !== afterTemporal.workingTreeHash) {
      console.log("[final-eval] Temporal changed source; retesting every approved task against the final source instead of retaining earlier passes...");
      const verified = await runTest({ path: sitePath, url, provider });
      compareTaskSets(tasks, verified.tasks);
      finalTestRunId = verified.runId;
      temporalLevel = { ...temporalLevel, scores: verified.scores, agentError: verified.agentError };
    }
  } catch (error) {
    console.error(`[final-eval] Temporal level failed: ${error instanceof Error ? error.message : String(error)}`);
    temporalLevel = { level: "temporal", runId, targetProject: sitePath, taskSetId, tasks, scores: failedSummary(tasks, error), status: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  const result: FinalEvalResult = { version: 1, runId, targetProject: sitePath, taskSetId, tasks, finalTestRunId, levels: [...(baselineLevel ? [baselineLevel] : []), webmcpLevel, temporalLevel], repair };
  const artifact = await createTrajectoryArtifact("final-eval", result, { sitePath, targetProject: sitePath, runId, taskSetId, provider, url, levels: result.levels.map((level) => ({ level: level.level, status: level.status, passed: level.scores.passed, total: level.scores.total })), repair });
  const comparisonComplete = baselineLevel ? finalEvalComparisonComplete(baselineLevel, temporalLevel) : finalEvalVerified(temporalLevel);
  if (comparisonComplete) await saveCheckpoint("complete");
  else await saveCheckpoint("temporal");
  console.log(includeBaseline ? "\n[final-eval] UI baseline / WebMCP / Temporal comparison" : "\n[final-eval] WebMCP / Temporal results (UI baseline not requested)");
  for (const level of result.levels) console.log(`  ${level.level}: ${level.scores.passed}/${level.scores.total} (${level.status})`);
  console.log(`[final-eval] trajectory: ${artifact}`);
  if (temporalLevel.status === "failed") throw new Error(`Temporal level failed: ${temporalLevel.error}`);
  if (!finalEvalVerified(temporalLevel)) throw new Error("Final evaluation recorded, but not every approved task passed final-source verification. Inspect the comparison and task diagnostics; the run is not complete.");
  if (!comparisonComplete) throw new Error("Final-source WebMCP tasks passed, but the UI baseline failed to execute reliably. The saved comparison is incomplete; inspect baseline diagnostics and prepare a new original-source comparison. Low UI scores alone do not cause this failure.");
  console.log("[final-eval] ✅ COMPLETE — WebMCP evaluation passed");
  console.log(`[final-eval] next: webmcpify eval --path ${sitePath}`);
  return result;
}
