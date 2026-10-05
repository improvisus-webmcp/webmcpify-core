import path from "node:path";
import { runApply } from "./apply.js";
import { runGenerate } from "./generate.js";
import { runReviewPrompt } from "./review.js";
import { runTest } from "./test.js";
import { withManagedChrome } from "../lib/browser.js";
import { closeScoringBrowser } from "../lib/scoring.js";
import { ensureTargetReachable, normalizeTargetUrl } from "../lib/target-url.js";
import { resolveSecurityPolicy } from "../lib/security-audit.js";
import { resolveDurable } from "../lib/config.js";
import { printCliLine, printStage, printWorkflowBanner } from "../lib/cli-output.js";
import { showSavedEvaluation } from "./eval.js";

export interface RunOptions {
  path?: string;
  url?: string;
  provider?: string;
  method?: string;
  reviewPort?: string;
  security?: string;
  productContext?: string;
  productContextPrompt?: boolean;
  durable?: boolean;
  resume?: string;
  executionId?: string;
  baseline?: boolean;
  activityTimeout?: string;
  reviewTimeout?: string;
}

/** Run the normal workflow without requiring Temporal or manual stage commands. */
export async function runWorkflow(opts: RunOptions): Promise<void> {
  if (opts.executionId && !opts.resume) throw new Error("--execution-id requires --resume.");
  if (opts.resume && opts.durable === false) throw new Error("--resume is a durable operation; omit --no-durable.");
  if (await resolveDurable(opts.durable) || opts.resume) {
    printWorkflowBanner("run", { durable: true, baseline: opts.baseline, resume: Boolean(opts.resume) });
    const { runDurableWorkflow } = await import("../lib/durable-run.js");
    return runDurableWorkflow(opts);
  }
  if (opts.baseline || opts.activityTimeout || opts.reviewTimeout) {
    throw new Error("--baseline, --activity-timeout and --review-timeout require run --durable.");
  }
  const security = resolveSecurityPolicy(opts.security, "balance");
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const targetUrl = opts.url ?? process.env.WEBMCPIFY_URL;
  if (!targetUrl) {
    throw new Error('A running site URL is required. Pass --url <url> or set WEBMCPIFY_URL.');
  }
  const url = normalizeTargetUrl(targetUrl);

  printWorkflowBanner("run");
  await ensureTargetReachable(url);
  printCliLine("run", `Target: ${sitePath}`);
  printCliLine("run", `Site: ${url}`);
  printCliLine("run", `Security: ${security}`);
  printStage("run", "1/4 | Discover, generate and validate the draft");
  await runGenerate({
    path: sitePath,
    provider: opts.provider,
    method: opts.method,
    security,
    productContext: opts.productContext,
    productContextPrompt: opts.productContextPrompt,
  });

  printStage("run", "2/4 | Human review and exact patch approval");
  const review = await runReviewPrompt(sitePath, opts.reviewPort);
  if (!review.approved) {
    printCliLine("run", "stopped: the draft was rejected; the target was not changed");
    return;
  }

  printCliLine("run", "approval received; continuing with the exact approved patch");
  if (!review.sourceDiff.runId || !review.sourceDiff.patchHash) throw new Error("Review returned no exact source patch identity; refusing apply.");
  printStage("run", "3/4 | Apply approved patch and check the build");
  await runApply({ path: sitePath, expectedRunId: review.sourceDiff.runId, expectedPatchHash: review.sourceDiff.patchHash });

  printStage("run", "4/4 | Real agent browser tests and independent verification");
  printCliLine("run", "preparing the browser; each approved task will be executed and checked independently");
  const evaluation = await withManagedChrome(url, async () => {
    try {
      return await runTest({ path: sitePath, url, provider: opts.provider });
    } finally {
      await closeScoringBrowser();
    }
  });

  await showSavedEvaluation(sitePath, "run", { runId: evaluation.runId });
  if (evaluation.scores.passed !== evaluation.scores.total) {
    throw new Error(
      `${evaluation.scores.total - evaluation.scores.passed} of ${evaluation.scores.total} approved tasks failed verification. Run webmcpify eval --path ${JSON.stringify(sitePath)} for details.`,
    );
  }

  console.log(
    `[run] complete: ${evaluation.scores.passed}/${evaluation.scores.total} approved tasks verified`,
  );
}
