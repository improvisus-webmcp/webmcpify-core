import { randomUUID } from "node:crypto";
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
import type { TaskScoreSummary, TaskResult } from "../lib/scoring.js";
import { ensureTargetReachable, normalizeTargetUrl } from "../lib/target-url.js";
import { loadTemporalClient } from "../lib/temporal.js";
import { resolveProvider } from "../lib/ai-provider.js";

export interface FinalEvalOptions {
  path?: string;
  url?: string;
  provider?: string;
  reviewPort?: string;
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
  repair?: { beforeEvaluation?: string; afterEvaluation?: string; status: string };
}

export function buildFinalEvalPlan(): string[] {
  return ["prepare-and-review", "baseline", "apply-and-test", "repair-if-needed", "temporal-evaluation", "compare-and-record"];
}

export function compareTaskSets(tasks: Task[], candidate: Task[]): void {
  if (taskFingerprint(tasks) !== taskFingerprint(candidate)) {
    throw new Error("Final evaluation levels do not use the exact same task definitions.");
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

async function readMatchingEvaluation(
  sitePath: string,
  role: "baseline-eval" | "test-eval",
  taskSetId: string,
  explicitPath?: string,
): Promise<{ path: string; value: StoredTestEvaluation } | undefined> {
  try {
    const evaluationPath = explicitPath ?? (await latestTrajectoryPath(role, sitePath));
    if (!evaluationPath || !existsSync(evaluationPath)) return undefined;
    const value = JSON.parse(await readFile(evaluationPath, "utf8")) as StoredTestEvaluation;
    if (typeof value.targetProject !== "string" || path.resolve(value.targetProject) !== path.resolve(sitePath)) return undefined;
    if (value.taskSetId !== taskSetId || taskFingerprint(value.tasks) !== taskSetId) return undefined;
    return { path: evaluationPath, value };
  } catch {
    return undefined;
  }
}

function evaluationHasAvailabilityFailure(value: StoredTestEvaluation): boolean {
  return value.scores.results.length > 0
    && value.scores.results.every((result) =>
      /ERR_CONNECTION_REFUSED|ECONNREFUSED|Could not connect to Chrome|target URL is not reachable/i.test(result.detail)
    );
}

async function findResumableFinalEval(sitePath: string): Promise<ResumableFinalEval | undefined> {
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

    let stage: Exclude<FinalEvalStage, "complete"> = checkpoint?.stage ?? "baseline";
    if (!checkpoint) {
      const baseline = await readMatchingEvaluation(sitePath, "baseline-eval", taskSetId);
      stage = baseline ? "apply" : "baseline";
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
  const connection = await Connection.connect({ address: process.env.WEBMCPIFY_TEMPORAL_ADDRESS ?? "localhost:7233" });
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
      const workflowId = `final-eval-${runId}-${task.id}`;
      const handle = await client.workflow.start("repairWorkflow", {
        taskQueue: process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify",
        workflowId,
        args: [{ path: sitePath, url, task: task.id, maxRepairs: 1, provider, runId, taskSetId }],
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
  console.log(`[final-eval] target: ${sitePath}`);
  console.log(`[final-eval] URL: ${url}`);
  await ensureTargetReachable(url);
  const resumable = await findResumableFinalEval(sitePath);
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
    stage = "baseline";
    console.log(`[final-eval] approval confirmed: ${tasks.length} task(s), task set ${taskSetId}`);
    console.log("[final-eval] continuing automatically with:");
    console.log("[final-eval]   1. baseline check (read-only, before applying source changes)");
    console.log("[final-eval]   2. apply the approved patch and build the target project");
    console.log("[final-eval]   3. run WebMCP browser tests");
    console.log("[final-eval]   4. repair failed tasks if needed, with a second approval");
    console.log("[final-eval]   5. run the durable Temporal evaluation");
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
      baselineEvaluationPath,
      webmcpEvaluationPath,
      repair,
    });
  };

  let baselineLevel: LevelResult;
  if (stage === "baseline") {
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
      baselineLevel = { level: "baseline", runId: baseline.runId, targetProject: sitePath, taskSetId, tasks, scores: baseline.scores, evaluationPath: baseline.evaluationPath, status: "completed", agentError: baseline.agentError };
    } else {
      baselineEvaluationPath = await createTrajectoryArtifact(
        "baseline-eval",
        { version: 1, mode: "baseline", runId: randomUUID(), targetProject: sitePath, taskSetId, tasks, scores: failedSummary(tasks, baselineError ?? "Baseline did not complete.") },
        { sitePath, targetProject: sitePath, taskSetId, provider, url, status: "failed", error: baselineError },
      );
      baselineLevel = { level: "baseline", runId, targetProject: sitePath, taskSetId, tasks, scores: failedSummary(tasks, baselineError ?? "Baseline did not complete."), evaluationPath: baselineEvaluationPath, status: "failed", error: baselineError ?? "Baseline did not complete." };
    }
    stage = "apply";
    await saveCheckpoint(stage);
  } else {
    const baselineArtifact = await readMatchingEvaluation(sitePath, "baseline-eval", taskSetId, baselineEvaluationPath);
    if (!baselineArtifact) throw new Error(`[final-eval] Cannot resume from ${stage}: the matching project-scoped baseline evaluation is missing.`);
    baselineEvaluationPath = baselineArtifact.path;
    const baseline = baselineArtifact.value;
    compareTaskSets(tasks, baseline.tasks);
    baselineLevel = { level: "baseline", runId: baseline.runId, targetProject: sitePath, taskSetId, tasks, scores: baseline.scores, evaluationPath: baselineArtifact.path, status: "completed", agentError: baseline.agentError };
  }

  if (stage === "apply") {
    console.log("[final-eval] Level 2 — applying approved WebMCP change...");
    const patch = await readPatchMetadata(sitePath);
    if (patch.patchStatus === "applied") {
      console.log("[final-eval] approved patch is already applied; skipping duplicate application");
    } else {
      await runApply({ path: sitePath });
    }
    stage = "webmcp-test";
    await saveCheckpoint(stage);
    console.log("[final-eval] approved patch applied; next: run the WebMCP browser tests");
  }

  let webmcpLevel: LevelResult;
  if (stage === "webmcp-test") {
    const existingWebmcp = await readMatchingEvaluation(sitePath, "test-eval", taskSetId, webmcpEvaluationPath);
    const webmcpEvaluation = existingWebmcp?.value ?? await runTest({ path: sitePath, url, provider });
    compareTaskSets(tasks, webmcpEvaluation.tasks);
    const webmcpArtifact = existingWebmcp ?? await readMatchingEvaluation(sitePath, "test-eval", taskSetId);
    if (!webmcpArtifact) throw new Error("WebMCP test completed but its project-scoped evaluation artifact could not be found.");
    webmcpEvaluationPath = webmcpArtifact.path;
    webmcpLevel = { level: "webmcp", runId: webmcpEvaluation.runId, targetProject: sitePath, taskSetId, tasks, scores: webmcpEvaluation.scores, evaluationPath: webmcpArtifact.path, status: "completed", agentError: webmcpEvaluation.agentError };
    stage = webmcpLevel.scores.results.some((result) => !result.passed) ? "repair" : "temporal";
    await saveCheckpoint(stage);
  } else {
    let webmcpArtifact = await readMatchingEvaluation(sitePath, "test-eval", taskSetId, webmcpEvaluationPath);
    if (!webmcpArtifact) throw new Error(`[final-eval] Cannot resume from ${stage}: the matching project-scoped WebMCP evaluation is missing.`);
    if (evaluationHasAvailabilityFailure(webmcpArtifact.value)) {
      console.log("[final-eval] previous WebMCP evaluation failed because the target was unavailable; refreshing it now that the target is reachable...");
      await runTest({ path: sitePath, url, provider });
      webmcpArtifact = await readMatchingEvaluation(sitePath, "test-eval", taskSetId);
      if (!webmcpArtifact) throw new Error("Refreshed WebMCP test completed but its project-scoped evaluation artifact could not be found.");
    }
    webmcpEvaluationPath = webmcpArtifact.path;
    const webmcpEvaluation = webmcpArtifact.value;
    compareTaskSets(tasks, webmcpEvaluation.tasks);
    webmcpLevel = { level: "webmcp", runId: webmcpEvaluation.runId, targetProject: sitePath, taskSetId, tasks, scores: webmcpEvaluation.scores, evaluationPath: webmcpArtifact.path, status: "completed", agentError: webmcpEvaluation.agentError };
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
          await runApply({ path: sitePath });
          repairedEvaluation = await runTest({ path: sitePath, url, provider });
        }
        if (!repairReview.approved) {
          repair = { beforeEvaluation, status: "rejected" };
        }
      }
      if (repairedEvaluation) {
        compareTaskSets(tasks, repairedEvaluation.tasks);
        const afterArtifact = await readMatchingEvaluation(sitePath, "test-eval", taskSetId);
        if (!afterArtifact) throw new Error("Repair retest completed but its project-scoped evaluation artifact could not be found.");
        const status = repairedEvaluation.scores.passed > webmcpLevel.scores.passed
          ? "improved"
          : repairedEvaluation.scores.passed < webmcpLevel.scores.passed ? "regressed" : "unchanged";
        repair = { beforeEvaluation, afterEvaluation: afterArtifact.path, status };
        webmcpEvaluationPath = afterArtifact.path;
        webmcpLevel = { ...webmcpLevel, runId: repairedEvaluation.runId, scores: repairedEvaluation.scores, evaluationPath: afterArtifact.path, agentError: repairedEvaluation.agentError };
        console.log(`[final-eval] repair result: ${status} (${repairedEvaluation.scores.passed}/${repairedEvaluation.scores.total})`);
      }
      stage = "temporal";
      await saveCheckpoint(stage);
    }
  }

  console.log("[final-eval] Level 3 — durable Temporal evaluation...");
  console.log(`[final-eval] connecting to Temporal at ${process.env.WEBMCPIFY_TEMPORAL_ADDRESS ?? "localhost:7233"}; worker task queue: ${process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify"}`);
  let temporalLevel: LevelResult;
  try {
    temporalLevel = await runTemporalLevel(sitePath, url, provider, tasks, runId, taskSetId, webmcpLevel.scores);
  } catch (error) {
    console.error(`[final-eval] Temporal level failed: ${error instanceof Error ? error.message : String(error)}`);
    temporalLevel = { level: "temporal", runId, targetProject: sitePath, taskSetId, tasks, scores: failedSummary(tasks, error), status: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  const result: FinalEvalResult = { version: 1, runId, targetProject: sitePath, taskSetId, tasks, levels: [baselineLevel, webmcpLevel, temporalLevel], repair };
  const artifact = await createTrajectoryArtifact("final-eval", result, { sitePath, targetProject: sitePath, runId, taskSetId, provider, url, levels: result.levels.map((level) => ({ level: level.level, status: level.status, passed: level.scores.passed, total: level.scores.total })), repair });
  if (temporalLevel.status === "completed") await saveCheckpoint("complete");
  else await saveCheckpoint("temporal");
  console.log("\n[final-eval] comparison");
  for (const level of result.levels) console.log(`  ${level.level}: ${level.scores.passed}/${level.scores.total} (${level.status})`);
  console.log(`[final-eval] trajectory: ${artifact}`);
  if (temporalLevel.status === "failed") throw new Error(`Temporal level failed: ${temporalLevel.error}`);
  console.log("[final-eval] ✅ COMPLETE — WebMCP evaluation passed");
  console.log(`[final-eval] next: webmcpify eval --path ${sitePath}`);
  return result;
}
