import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { latestTrajectoryPath } from "../lib/trajectories.js";
import type { StoredTestEvaluation } from "./test.js";
import type { FinalEvalResult } from "./final-eval.js";
import { taskFingerprint } from "../lib/tasks.js";

function displaySymbol(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

/** Only attach a final comparison to the exact test run it evaluated. */
export function matchesFinalComparison(comparison: FinalEvalResult, evaluation: StoredTestEvaluation): boolean {
  return comparison.version === 1 && comparison.finalTestRunId === evaluation.runId
    && comparison.targetProject === evaluation.targetProject && comparison.taskSetId === evaluation.taskSetId
    && taskFingerprint(comparison.tasks) === taskFingerprint(evaluation.tasks);
}

export async function runEval(sitePath?: string) {
  const resolvedSitePath = sitePath ? path.resolve(sitePath) : undefined;
  const evaluationPath = await latestTrajectoryPath("test-eval", resolvedSitePath);
  if (!evaluationPath || !existsSync(evaluationPath)) {
    throw new Error(
      `No test evaluation found for ${resolvedSitePath ?? "the latest project"}. Run "webmcpify test" first.`
    );
  }

  let evaluation: StoredTestEvaluation;
  try {
    evaluation = JSON.parse(
      await readFile(evaluationPath, "utf8")
    ) as StoredTestEvaluation;
  } catch (error) {
    throw new Error(
      `Could not read the last test evaluation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  console.log(
    `[eval] ${evaluation.scores.passed}/${evaluation.scores.total} tasks passed ` +
      `(mode: ${evaluation.mode ?? "webmcp"}, project: ${evaluation.targetProject ?? "unknown"}, run: ${evaluation.runId ?? "unknown"})`
  );
  let finalComparison: FinalEvalResult | undefined;
  const finalPath = await latestTrajectoryPath("final-eval", evaluation.targetProject);
  if (finalPath) {
    try {
      const candidate = JSON.parse(await readFile(finalPath, "utf8")) as FinalEvalResult;
      if (matchesFinalComparison(candidate, evaluation)) finalComparison = candidate;
    } catch { /* An unrelated/unreadable comparison does not hide saved test results. */ }
  }
  const baseline = finalComparison?.levels.find(level => level.level === "baseline") ?? evaluation.baseline;
  if (finalComparison) {
    console.log("[eval] final evaluation:");
    for (const level of finalComparison.levels) console.log(`  ${level.level}: ${level.scores.passed}/${level.scores.total} (${level.status})`);
    console.log(`[eval] final evaluation evidence: ${finalPath}`);
  }
  if (baseline) {
    const incomplete = baseline.agentError || ("status" in baseline && baseline.status === "failed")
      || baseline.scores.results.some(result => ["infrastructure", "evidence", "verification"].includes(result.failureKind ?? ""));
    console.log(`[eval] comparison: UI baseline ${baseline.scores.passed}/${baseline.scores.total}; WebMCP ${evaluation.scores.passed}/${evaluation.scores.total}${incomplete ? " (baseline execution failed; incomplete comparison)" : ""}`);
    console.log(`[eval] baseline evidence: ${baseline.evaluationPath}`);
  }
  for (const result of evaluation.scores.results) {
    const task = evaluation.tasks.find((candidate) => candidate.id === result.task);
    const description = task ? ` — ${task.description}` : "";
    const detail = result.detail ? ` (${result.detail})` : "";
    console.log(
      `  [${displaySymbol(result.passed)}] ${result.task}${description}${detail}`
    );
    if (baseline) {
      const baselineResult = baseline.scores.results.find(candidate => candidate.task === result.task);
      console.log(`    UI baseline: ${baselineResult ? displaySymbol(baselineResult.passed) : "NOT RUN"}; WebMCP: ${displaySymbol(result.passed)}`);
    }
  }

  return evaluation;
}
