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

  await ensureTargetReachable(url);
  console.log(`[run] target: ${sitePath}`);
  console.log(`[run] site: ${url}`);
  console.log(`[run] security: ${security}`);
  console.log("[run] 1/4 discover and draft");
  await runGenerate({
    path: sitePath,
    provider: opts.provider,
    method: opts.method,
    security,
    productContext: opts.productContext,
    productContextPrompt: opts.productContextPrompt,
  });

  console.log("[run] 2/4 review");
  const review = await runReviewPrompt(sitePath, opts.reviewPort);
  if (!review.approved) {
    console.log("[run] stopped: the draft was rejected; the target was not changed");
    return;
  }

  console.log("[run] approval received; continuing with the exact approved patch");
  if (!review.sourceDiff.runId || !review.sourceDiff.patchHash) throw new Error("Review returned no exact source patch identity; refusing apply.");
  console.log("[run] 3/4 apply and build");
  await runApply({ path: sitePath, expectedRunId: review.sourceDiff.runId, expectedPatchHash: review.sourceDiff.patchHash });

  console.log("[run] 4/4 test and independently verify");
  console.log("[run] preparing the browser; each approved task will be executed and checked independently");
  const evaluation = await withManagedChrome(url, async () => {
    try {
      return await runTest({ path: sitePath, url, provider: opts.provider });
    } finally {
      await closeScoringBrowser();
    }
  });

  if (evaluation.scores.passed !== evaluation.scores.total) {
    throw new Error(
      `${evaluation.scores.total - evaluation.scores.passed} of ${evaluation.scores.total} approved tasks failed verification. Run webmcpify eval --path ${JSON.stringify(sitePath)} for details.`,
    );
  }

  console.log(
    `[run] complete: ${evaluation.scores.passed}/${evaluation.scores.total} approved tasks verified`,
  );
  console.log(`[run] report: webmcpify eval --path ${JSON.stringify(sitePath)}`);
}
