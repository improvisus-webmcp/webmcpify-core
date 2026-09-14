import path from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { execa } from "execa";
import { runAgent } from "../lib/agent.js";
import { resolveProvider } from "../lib/ai-provider.js";
import { resolveDurable } from "../lib/config.js";
import { writeChromeDevtoolsMcpConfig } from "../lib/mcp-config.js";
import {
  DISCOVERY_GUIDANCE,
  TOOL_PLACEMENT_GUIDANCE,
  WEBMCP_SPEC_GUIDANCE,
} from "../lib/prompts.js";
import {
  createTrajectoryArtifact,
  createTrajectoryPath,
  latestTrajectoryPath,
} from "../lib/trajectories.js";
import { createPendingPatch } from "../lib/patches.js";
import { runGenerationPreflight } from "../lib/preflight.js";
import { normalizeTargetUrl } from "../lib/target-url.js";
import { loadTemporalClient } from "../lib/temporal.js";
import type { TaskResult } from "../lib/scoring.js";
import type { StoredTestEvaluation } from "./test.js";

export interface RepairOptions {
  provider?: string;
  path?: string;
  url?: string;
  task?: string;
  evaluationPath?: string;
  failureDetail?: string;
  durable?: boolean;
  maxRepairs?: number | string;
}

async function readLastEvaluation(sitePath: string, explicitPath?: string): Promise<{
  evaluation: StoredTestEvaluation;
  path: string;
}> {
  const candidates = explicitPath
    ? [explicitPath]
    : (await Promise.all([
        latestTrajectoryPath("test-eval", sitePath),
        latestTrajectoryPath("baseline-eval", sitePath),
      ])).filter((candidate): candidate is string => Boolean(candidate));
  const evaluationPath = candidates.sort().at(-1);
  if (!evaluationPath || !existsSync(evaluationPath)) {
    throw new Error(
      `No test evaluation found in trajectories. Run "webmcpify test" first.`
    );
  }

  try {
    return {
      evaluation: JSON.parse(
        await readFile(evaluationPath, "utf8")
      ) as StoredTestEvaluation,
      path: evaluationPath,
    };
  } catch (error) {
    throw new Error(
      `Could not read the last test evaluation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function selectFailedTasks(evaluation: StoredTestEvaluation, requestedTask?: string): TaskResult[] {
  const failed = evaluation.scores.results.filter((result) => !result.passed);
  if (!requestedTask) return failed;
  const selected = failed.filter((result) => result.task === requestedTask);
  if (!selected.length) throw new Error(`Task "${requestedTask}" is not a failed task in the selected evaluation.`);
  return selected;
}

export function repairPrompt(
  evaluation: StoredTestEvaluation,
  evaluationPath: string,
  sitePath: string,
  failedTasks: TaskResult[],
): string {
  const taskEvidence = failedTasks.map((result) => ({
    task: evaluation.tasks.find((candidate) => candidate.id === result.task),
    result,
  }));
  return `Repair only the failed WebMCP behavior in the current disposable
workspace. The current working directory is the only project you may access.
Do not use absolute paths, inspect parent directories, or access the original
checkout. WebMCPify will capture the workspace diff and send it through human
review before applying anything.

Evaluation mode: ${evaluation.mode ?? "unknown"}
Evaluation run ID: ${evaluation.runId ?? "unknown"}
Task set fingerprint: ${evaluation.taskSetId ?? "unknown"}
Evaluation artifact name: ${path.basename(evaluationPath)}

Failed task evidence (use the exact task definitions and observed details):
${JSON.stringify(taskEvidence, null, 2)}

Inspect the relevant source and existing WebMCP registrations. Patch only the
cause of these failures, preserve approved tool names and schemas, and avoid
unrelated refactors. Do not edit tasks.json or approval manifests.

Before patching, perform focused discovery rather than scanning the entire
repository:

${DISCOVERY_GUIDANCE}

${TOOL_PLACEMENT_GUIDANCE}

${WEBMCP_SPEC_GUIDANCE}

After editing, report files changed, placement and wiring for each affected
tool, and the verification result. The repair will be reviewed and applied by
WebMCPify after this session; do not claim approval or deployment.`;
}

async function createRepairWorkspace(sitePath: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "webmcpify-repair-"));
  await cp(sitePath, workspace, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}.webmcpify${path.sep}`) && !source.includes(`${path.sep}node_modules${path.sep}`),
  });
  await execa("git", ["init", "-q"], { cwd: workspace });
  await execa("git", ["config", "user.email", "webmcpify@example.invalid"], { cwd: workspace });
  await execa("git", ["config", "user.name", "WebMCPify Repair"], { cwd: workspace });
  await execa("git", ["add", "-A"], { cwd: workspace });
  await execa("git", ["commit", "-qm", "repair baseline"], { cwd: workspace });
  return workspace;
}

async function workspaceDiff(workspace: string): Promise<string> {
  // Include newly-created source files in repair patches. Plain `git diff`
  // omits untracked files, which can leave imports without their new module.
  await execa("git", ["add", "-A"], { cwd: workspace });
  const result = await execa(
    "git",
    [
      "diff",
      "--cached",
      "--binary",
      "HEAD",
      "--",
      ".",
      ":(exclude).webmcpify/**",
      ":(exclude).agents/**",
      ":(exclude)node_modules/**",
      ":(exclude)tasks.json",
    ],
    { cwd: workspace },
  );
  if (!result.stdout.trim()) throw new Error("Repair agent produced no source changes.");
  return result.stdout;
}

async function runPlainRepair(opts: RepairOptions): Promise<void> {
  const provider = resolveProvider(opts.provider);
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const {
    evaluation,
    path: evaluationPath,
  } = await readLastEvaluation(sitePath, opts.evaluationPath);
  let failedTasks: TaskResult[];
  const selectedResult = opts.task
    ? evaluation.scores.results.find((result) => result.task === opts.task)
    : undefined;
  if (selectedResult && !selectedResult.passed) {
    failedTasks = selectFailedTasks(evaluation, opts.task);
  } else if (selectedResult && opts.failureDetail) {
    // Temporal may catch a failure from its isolated per-task run even when
    // the earlier full WebMCP evaluation passed that task. Keep the approved
    // task definition, but carry the durable run's actual failure evidence.
    failedTasks = [{
      ...selectedResult,
      passed: false,
      detail: opts.failureDetail,
    }];
  } else {
    failedTasks = selectFailedTasks(evaluation, opts.task);
  }

  if (failedTasks.length === 0) {
    throw new Error("The last test passed every task; there is nothing to repair.");
  }

  const mcpConfigPath = await writeChromeDevtoolsMcpConfig(sitePath);
  const repairTrajectory = createTrajectoryPath("repair", undefined, sitePath);
  const workspace = await createRepairWorkspace(sitePath);
  const prompt = repairPrompt(evaluation, evaluationPath, sitePath, failedTasks);

  console.log(`[repair] starting repair for ${failedTasks.length} failed task(s) via ${provider}...`);
  console.log(`[repair] scope: ${failedTasks.map((task) => task.task).join(", ")}`);

  try {
    await runAgent({
      provider,
      prompt,
      cwd: workspace,
      allowedTools: "Read,Edit,Bash,mcp__chrome-devtools__*",
      mcpConfig: existsSync(mcpConfigPath) ? mcpConfigPath : undefined,
      saveTo: repairTrajectory,
      trajectoryMetadata: {
        role: "repair",
        sitePath,
        url: evaluation.url,
        sourceEvaluation: evaluationPath,
        failures: failedTasks,
        runId: evaluation.runId,
        taskSetId: evaluation.taskSetId,
        repairWorkspace: workspace,
      },
    });
  } catch (error) {
    await createTrajectoryArtifact("repair-result", {
      status: "failed",
      sourceEvaluation: evaluationPath,
      failedTasks,
      error: error instanceof Error ? error.message : String(error),
    }, {
      status: "failed",
      sitePath,
      runId: evaluation.runId,
      taskSetId: evaluation.taskSetId,
      sourceEvaluation: evaluationPath,
      repairTrajectory,
    });
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }

  try {
    const diff = await workspaceDiff(workspace);
    await runGenerationPreflight(sitePath, workspace);
    const patchMetadata = await createPendingPatch(sitePath, diff, repairTrajectory, {
      repair: {
        sourceEvaluation: evaluationPath,
        url: evaluation.url,
        taskSetId: evaluation.taskSetId,
        failedTaskIds: failedTasks.map((task) => task.task),
      },
    });
    const repairResult = await createTrajectoryArtifact("repair-result", {
      status: "awaiting-review",
      sourceEvaluation: evaluationPath,
      failedTasks,
      patch: patchMetadata,
    }, {
      sitePath,
      runId: evaluation.runId,
      taskSetId: evaluation.taskSetId,
      sourceEvaluation: evaluationPath,
      repairTrajectory,
      patchPath: patchMetadata.patchPath,
      patchStatus: patchMetadata.patchStatus,
    });
    console.log(`[repair] real patch saved to ${patchMetadata.patchPath}`);
    console.log(`[repair] repair result saved to ${repairResult}`);
  } catch (error) {
    await createTrajectoryArtifact("repair-result", {
      status: "failed",
      sourceEvaluation: evaluationPath,
      failedTasks,
      error: error instanceof Error ? error.message : String(error),
    }, {
      status: "failed",
      sitePath,
      runId: evaluation.runId,
      taskSetId: evaluation.taskSetId,
      sourceEvaluation: evaluationPath,
      repairTrajectory,
    });
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  console.log(`[repair] repair trajectory saved to ${repairTrajectory}`);
  console.log('[repair] review the patch, then run "webmcpify apply" to apply and retest affected tasks');
}

function workflowSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "task"
  );
}

async function runDurableRepair(opts: RepairOptions): Promise<void> {
  if (!opts.url) {
    throw new Error('Durable repair requires "--url <url>".');
  }
  if (!opts.task) {
    throw new Error('Durable repair requires "--task <task>".');
  }
  const url = normalizeTargetUrl(opts.url);

  const maxRepairs =
    opts.maxRepairs === undefined ? 3 : Number(opts.maxRepairs);
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
    throw new Error("--max-repairs must be a non-negative integer.");
  }

  const { Client, Connection } = await loadTemporalClient();
  const connection = await Connection.connect({
    address: process.env.WEBMCPIFY_TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  try {
    const client = new Client({
      connection,
      namespace: process.env.WEBMCPIFY_TEMPORAL_NAMESPACE ?? "default",
    });
    const workflowId = `repair-${workflowSlug(opts.task)}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const workflowOptions = {
      path: path.resolve(opts.path ?? process.cwd()),
      url,
      task: opts.task,
      maxRepairs,
      provider: opts.provider,
    };
    const handle = await client.workflow.start("repairWorkflow", {
      taskQueue: process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify",
      workflowId,
      args: [workflowOptions],
    });

    console.log(`[repair] durable workflow started: ${handle.workflowId}`);
    try {
      const result = await handle.result();
      const trajectory = await createTrajectoryArtifact(
        "temporal-repair",
        result,
        {
          workflowId,
          task: opts.task,
          url: opts.url,
          sitePath: workflowOptions.path,
          provider: opts.provider,
          maxRepairs,
          startedAt,
          finishedAt: new Date().toISOString(),
        }
      );
      console.log(`[repair] result: ${JSON.stringify(result)}`);
      console.log(`[repair] workflow artifact saved to ${trajectory}`);
    } catch (error) {
      const trajectory = await createTrajectoryArtifact(
        "temporal-repair",
        {
          error: error instanceof Error ? error.message : String(error),
          workflowId,
        },
        {
          status: "failed",
          workflowId,
          task: opts.task,
          url: opts.url,
          sitePath: workflowOptions.path,
          provider: opts.provider,
          maxRepairs,
          startedAt,
          finishedAt: new Date().toISOString(),
        }
      );
      console.log(`[repair] failed workflow artifact saved to ${trajectory}`);
      throw error;
    }
  } finally {
    await connection.close();
  }
}

export async function runRepair(opts: RepairOptions): Promise<void> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const useDurable = await resolveDurable(opts.durable, sitePath);

  if (useDurable) {
    await runDurableRepair(opts);
    return;
  }

  await runPlainRepair(opts);
}
