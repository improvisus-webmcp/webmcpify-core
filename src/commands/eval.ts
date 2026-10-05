import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { latestTrajectoryPath } from "../lib/trajectories.js";
import type { StoredTestEvaluation } from "./test.js";
import type { FinalEvalResult } from "./final-eval.js";
import { taskFingerprint } from "../lib/tasks.js";
import { printCliBlock, printCliLine, renderBox, renderTable } from "../lib/cli-output.js";

function displaySymbol(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

/** Only attach a final comparison to the exact test run it evaluated. */
export function matchesFinalComparison(comparison: FinalEvalResult, evaluation: StoredTestEvaluation): boolean {
  return comparison.version === 1 && comparison.finalTestRunId === evaluation.runId
    && comparison.targetProject === evaluation.targetProject && comparison.taskSetId === evaluation.taskSetId
    && taskFingerprint(comparison.tasks) === taskFingerprint(evaluation.tasks);
}

/** Presentation only: scores and identities are always taken from saved evidence. */
export function printEvaluationReport(evaluation: StoredTestEvaluation, finalComparison?: FinalEvalResult,
  evidence: { evaluationPath?: string; finalPath?: string } = {}): void {
  const baseline = finalComparison?.levels.find(level => level.level === "baseline") ?? evaluation.baseline;
  const temporal = finalComparison?.levels.find(level => level.level === "temporal");
  printCliBlock("\n" + renderBox("WEBMCPIFY | EVALUATION", [
    `${evaluation.scores.passed}/${evaluation.scores.total} tasks passed | ${evaluation.scores.total - evaluation.scores.passed} failed | Mode: ${evaluation.mode ?? "webmcp"}`,
  ]));
  printCliBlock(renderTable(["Context", "Value"], [
    ["Project", evaluation.targetProject ?? "unknown"],
    ["Run", evaluation.runId ?? "unknown"],
  ]));
  if (finalComparison) {
    printCliBlock(renderTable(["Evaluation stage", "Passed / total", "Execution"], finalComparison.levels.map(level =>
      [level.level, `${level.scores.passed}/${level.scores.total}`, level.status])));
  }
  if (baseline) {
    const incomplete = baseline.agentError || ("status" in baseline && baseline.status === "failed")
      || baseline.scores.results.some(result => ["infrastructure", "evidence", "verification"].includes(result.failureKind ?? ""));
    printCliLine("eval", `comparison: UI baseline ${baseline.scores.passed}/${baseline.scores.total}; WebMCP ${evaluation.scores.passed}/${evaluation.scores.total}${incomplete ? " (baseline execution failed; incomplete comparison)" : ""}`);
  }
  const headers = ["#", "WebMCP", ...(baseline ? ["UI baseline"] : []), ...(temporal ? ["Temporal"] : []), "Task", "Verification"];
  const rows = evaluation.scores.results.map((result, index) => {
    const compared = (scores: typeof evaluation.scores) => {
      const found = scores.results.find(candidate => candidate.task === result.task);
      return found ? displaySymbol(found.passed) : "NOT RUN";
    };
    return [String(index + 1), displaySymbol(result.passed), ...(baseline ? [compared(baseline.scores)] : []),
      ...(temporal ? [compared(temporal.scores)] : []), result.task, result.detail || "No verification detail recorded"];
  });
  printCliBlock(renderTable(headers, rows));
  for (const result of evaluation.scores.results.filter(result => !result.passed)) {
    const task = evaluation.tasks.find(candidate => candidate.id === result.task);
    if (task) printCliBlock(renderBox(`FAILED | ${result.task}`, [task.description,
      ...(result.failureKind ? [`Failure category: ${result.failureKind}`] : [])]));
  }
  const paths = [
    ...(evidence.evaluationPath ? [["Browser evaluation", evidence.evaluationPath]] : []),
    ...(baseline?.evaluationPath ? [["UI baseline", baseline.evaluationPath]] : []),
    ...(evidence.finalPath && finalComparison ? [["Final comparison", evidence.finalPath]] : []),
  ];
  if (paths.length) printCliBlock(renderTable(["Saved evidence", "Path"], paths));
  printCliBlock(renderBox("HELP AI AGENTS DISCOVER YOUR SITE", [
    "Site owners are encouraged to submit their public sites to Improvisus Search:",
    "https://improvisus.tech/search",
    "Help AI agents across the web discover what your site can do and learn how to use and call its capabilities. Grow your site's visibility to AI agents.",
  ]));
}

/** Automatic report display must not alter the workflow's verification outcome. */
export async function showSavedEvaluation(sitePath: string, scope: string, expected: { runId?: string; evaluationPath?: string } = {}): Promise<void> {
  try { await runEval(sitePath, expected); }
  catch { printCliLine(scope, "The saved evaluation is unavailable from this process. Display it on the target host with the eval command below."); }
  printCliLine(scope, `View again: webmcpify eval --path ${JSON.stringify(sitePath)}`);
}

export async function runEval(sitePath?: string, expected: { runId?: string; evaluationPath?: string } = {}) {
  const resolvedSitePath = sitePath ? path.resolve(sitePath) : undefined;
  const evaluationPath = expected.evaluationPath ?? await latestTrajectoryPath("test-eval", resolvedSitePath);
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

  if ((expected.runId && evaluation.runId !== expected.runId)
    || (expected.evaluationPath && resolvedSitePath && path.resolve(evaluation.targetProject) !== resolvedSitePath)) {
    throw new Error("The saved evaluation does not belong to this workflow result.");
  }

  let finalComparison: FinalEvalResult | undefined;
  const finalPath = await latestTrajectoryPath("final-eval", evaluation.targetProject);
  if (finalPath) {
    try {
      const candidate = JSON.parse(await readFile(finalPath, "utf8")) as FinalEvalResult;
      if (matchesFinalComparison(candidate, evaluation)) finalComparison = candidate;
    } catch { /* An unrelated/unreadable comparison does not hide saved test results. */ }
  }
  printEvaluationReport(evaluation, finalComparison, { evaluationPath, finalPath });

  return evaluation;
}
