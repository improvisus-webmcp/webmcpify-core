import { runApply } from "../commands/apply.js";
import {
  runReviewPrompt,
  type ReviewResult,
} from "../commands/review.js";
import { runApprovedTask } from "../commands/test.js";
import { runRepair } from "../commands/repair.js";
import { createTrajectoryArtifact } from "../lib/trajectories.js";
import { withManagedChrome } from "../lib/browser.js";

export interface ActivityTaskResult {
  task: string;
  passed: boolean;
  detail?: string;
}

/** Thin Temporal wrapper around the existing draft generator. */
export async function generateActivity(
  path: string,
  failureDetail?: string,
  provider?: string,
  attempt?: number,
  url?: string,
  task?: string,
): Promise<void> {
  if (!url || !task) throw new Error("Temporal targeted repair requires the task URL and task ID.");
  await runRepair({
    path,
    url,
    task,
    provider,
    durable: false,
    failureDetail,
  });
}

/** Score one approved project task through the independent browser scorer. */
export async function testActivity(
  sitePath: string,
  url: string,
  task: string,
  attempt?: number,
  runId?: string,
  taskSetId?: string,
  provider?: string,
): Promise<ActivityTaskResult> {
  const result = await withManagedChrome(url, () => runApprovedTask({ path: sitePath, url, provider, taskId: task, runId, taskSetId }));

  const taskResult = {
    task: result.task,
    passed: result.passed,
    detail: result.detail,
  };
  await createTrajectoryArtifact(
    "temporal-test",
    {
      url,
      task: taskResult,
      attempt,
    },
    {
      url,
      task,
      attempt,
      sitePath,
      tasksPath: `${sitePath}/tasks.json`,
      durable: true,
      runId,
      targetProject: sitePath,
      taskSetId,
    }
  );
  return taskResult;
}

/** Apply the explicitly reviewed patch inside a durable repair attempt. */
export async function applyActivity(sitePath: string): Promise<void> {
  await runApply({ path: sitePath });
}

/** Block on the existing localhost approval page until the owner decides. */
export async function reviewActivity(
  path: string,
  attempt?: number
): Promise<ReviewResult> {
  return runReviewPrompt(path, undefined, {
    durable: true,
    attempt,
  });
}
