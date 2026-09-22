#!/usr/bin/env node
import "./lib/load-env.js";
import { Command, Option } from "commander";
import { runGenerate } from "./commands/generate.js";
import { runReview } from "./commands/review.js";
import { runTest } from "./commands/test.js";
import { runRepair } from "./commands/repair.js";
import { runEval } from "./commands/eval.js";
import { runBaseline } from "./commands/baseline.js";
import { runApply } from "./commands/apply.js";
import { runDiscover } from "./commands/discover.js";
import { runFinalEval } from "./commands/final-eval.js";
import { runWorkflow } from "./commands/run.js";
import { runSecurity } from "./commands/security.js";
import { withManagedChrome } from "./lib/browser.js";
import { packageMetadata } from "./lib/package-info.js";
import { closeScoringBrowser } from "./lib/scoring.js";
import { SECURITY_POLICIES } from "./lib/security-audit.js";

const providerHelp =
  "AI provider to use: gemini, antigravity, claude, codex, or opencode";

const program = new Command();
const metadata = packageMetadata();

program
  .name("webmcpify")
  .description("Create, review, test, and verify WebMCP capabilities.")
  .version(metadata.version);

program
  .command("run")
  .description("Run the normal discover-to-verification workflow")
  .option("-p, --path <dir>", "target codebase (defaults to the current directory)")
  .option("-u, --url <url>", "running site URL (required unless WEBMCPIFY_URL is set)")
  .option("--provider <name>", providerHelp)
  .option("--method <type>", "generation strategy: declarative, imperative, or auto", "auto")
  .addOption(new Option("--security <policy>", "security policy for generation and approval").choices([...SECURITY_POLICIES]).default("balance"))
  .option("--review-port <number>", "port for the human review page", "4173")
  .action(runWorkflow);

program
  .command("generate")
  .description("Draft WebMCP tool registrations for a site (no changes applied yet)")
  .option("-p, --path <dir>", "target codebase (defaults to the current directory)")
  .option("--provider <name>", providerHelp)
  .option(
    "--method <type>",
    "generation strategy: declarative, imperative, or auto",
    "auto"
  )
  .action(runGenerate);

program
  .command("discover")
  .description("Discover a target project's stack, routes, actions, and capabilities")
  .option(
    "-p, --path <dir>",
    "path to the site's codebase (defaults to the current directory)"
  )
  .action(runDiscover);

program
  .command("security")
  .description("Audit proposed or approved tools for Core access-control gaps")
  .option("-p, --path <dir>", "target codebase (defaults to the current directory)")
  .option("--strict", "fail when the report contains blocking findings")
  .action(async (opts) => { await runSecurity(opts); });

program
  .command("review")
  .description("Start the local approval UI for drafted tools")
  .option(
    "-p, --path <dir>",
    "path to the site's codebase (defaults to the current directory)"
  )
  .option("--port <number>", "port for the review server", "4173")
  .action(runReview);

program
  .command("apply")
  .description("Apply an explicitly approved source patch and verify the build")
  .option(
    "-p, --path <dir>",
    "path to the site's codebase (defaults to the current directory)"
  )
  .action(runApply);

program
  .command("test")
  .description("Run an isolated agent against approved tools via chrome-devtools-mcp")
  .requiredOption("-u, --url <url>", "URL of the running site")
  .option(
    "-p, --path <dir>",
    "path to the site's codebase (defaults to the current directory)"
  )
  .option("--provider <name>", providerHelp)
  .action(async (opts) => {
    await withManagedChrome(opts.url, async () => {
      try {
        await runTest(opts);
      } finally {
        await closeScoringBrowser();
      }
    });
  });

program
  .command("repair")
  .description("Patch a failed tool; use --durable for Temporal-backed repair")
  .option(
    "-p, --path <dir>",
    "path to the site's codebase (defaults to the current directory)"
  )
  .option("-u, --url <url>", "URL of the running site (required with --durable)")
  .option(
    "-t, --task <task>",
    "approved tasks.json task id (required with --durable)"
  )
  .option("--max-repairs <number>", "maximum durable repair attempts", "3")
  .option("--durable", "run the repair loop through Temporal (requires --url and --task)")
  .option("--no-durable", "force the plain repair loop for this run")
  .option("--provider <name>", providerHelp)
  .action(async (opts) => {
    if (!opts.url) {
      await runRepair(opts);
      return;
    }
    await withManagedChrome(opts.url, async () => {
      await runRepair(opts);
    });
  });

program
  .command("eval")
  .description("Print the pass/fail report for the last test run")
  .option("-p, --path <dir>", "path to the target project")
  .action(async (opts) => {
    await runEval(opts.path);
  });

program
  .command("baseline")
  .description("Run the one-shot, self-verifying baseline for comparison")
  .option("-p, --path <dir>", "target codebase (defaults to the current directory)")
  .requiredOption("-u, --url <url>", "URL of the running site")
  .option("--provider <name>", providerHelp)
  .action(async (opts) => {
    await withManagedChrome(opts.url, async () => {
      try {
        await runBaseline(opts);
      } finally {
        await closeScoringBrowser();
      }
    });
  });

program
  .command("final-eval")
  .description("Run the advanced baseline, WebMCP, and Temporal comparison")
  .option("-p, --path <dir>", "target codebase (defaults to the current directory)")
  .option("-u, --url <url>", "running target URL (required unless WEBMCPIFY_URL is set)")
  .option("--provider <name>", providerHelp)
  .option("--review-port <number>", "port for the human review checkpoint", "4173")
  .action(async (opts) => {
    const url = opts.url ?? process.env.WEBMCPIFY_URL;
    if (!url) {
      throw new Error('A running site URL is required. Pass --url <url> or set WEBMCPIFY_URL.');
    }
    await withManagedChrome(url, async () => {
      try {
        await runFinalEval({ path: opts.path, url, provider: opts.provider, reviewPort: opts.reviewPort });
      } finally {
        await closeScoringBrowser();
      }
    });
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[webmcpify] ${message}`);
  process.exitCode = 1;
});
