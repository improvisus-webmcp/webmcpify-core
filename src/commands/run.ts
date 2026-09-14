import path from "node:path";
import { runApply } from "./apply.js";
import { runGenerate } from "./generate.js";
import { runReviewPrompt } from "./review.js";
import { runTest } from "./test.js";
import { withManagedChrome } from "../lib/browser.js";
import { closeScoringBrowser } from "../lib/scoring.js";
import { ensureTargetReachable, normalizeTargetUrl } from "../lib/target-url.js";

export interface RunOptions {
  path?: string;
  url?: string;
  provider?: string;
  method?: string;
  reviewPort?: string;
}

/** Run the normal workflow without requiring Temporal or manual stage commands. */
export async function runWorkflow(opts: RunOptions): Promise<void> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const url = normalizeTargetUrl(
    opts.url ?? process.env.WEBMCPIFY_URL ?? "http://localhost:3000",
  );

  await ensureTargetReachable(url);
  console.log(`[run] target: ${sitePath}`);
  console.log(`[run] site: ${url}`);
  console.log("[run] 1/4 discover and draft");
  await runGenerate({
    path: sitePath,
    provider: opts.provider,
    method: opts.method,
  });

  console.log("[run] 2/4 review");
  const review = await runReviewPrompt(sitePath, opts.reviewPort);
  if (!review.approved) {
    console.log("[run] stopped: the draft was rejected; the target was not changed");
    return;
  }

  console.log("[run] 3/4 apply and build");
  await runApply({ path: sitePath });

  console.log("[run] 4/4 test and independently verify");
  const evaluation = await withManagedChrome(url, async () => {
    try {
      return await runTest({ path: sitePath, url, provider: opts.provider });
    } finally {
      await closeScoringBrowser();
    }
  });

  if (evaluation.scores.passed !== evaluation.scores.total) {
    throw new Error(
      `${evaluation.scores.total - evaluation.scores.passed} of ${evaluation.scores.total} approved tasks failed verification. Run "webmcpify eval" for details.`,
    );
  }

  console.log(
    `[run] complete: ${evaluation.scores.passed}/${evaluation.scores.total} approved tasks verified`,
  );
}
