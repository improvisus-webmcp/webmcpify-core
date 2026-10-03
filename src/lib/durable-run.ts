import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { RunOptions } from "../commands/run.js";
import type { CoreProgress, CoreWorkflowOptions, CoreWorkflowResult } from "../temporal/contracts.js";
import type { WorkflowHandle } from "@temporalio/client";
import { resolveProvider } from "./ai-provider.js";
import { publicProviderFailureGuidance } from "./agent.js";
import { resolveSecurityPolicy } from "./security-audit.js";
import { normalizeTargetUrl } from "./target-url.js";
import { loadTemporalClient, temporalConnectionOptions } from "./temporal.js";
import { withCliProgress } from "./cli-progress.js";
import { collectProductContext } from "./product-context.js";

type CoreWorkflow = (opts: CoreWorkflowOptions) => Promise<CoreWorkflowResult>;

export function durableTimeout(value: string | undefined, fallback: number, limit: number, flag: string): number {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > limit) {
    throw new Error(`${flag} must be a whole number from 1 to ${limit}.`);
  }
  return selected;
}

/** Stable per-target ID prevents two active full pipelines for the same path. */
export function coreWorkflowId(sitePath: string): string {
  return `webmcpify-core-${createHash("sha256").update(sitePath).digest("hex").slice(0, 24)}`;
}

/** Report actionable Core failures without printing arbitrary Temporal payloads. */
export function durableFailureMessage(error: unknown, phase?: string): string {
  const knownPhase = /^(discovery|generation|security|review|baseline|apply|verification|recording evaluation)(?:\s|$)/.exec(phase ?? "")?.[1];
  let hint = "";
  const seen = new Set<unknown>();
  for (let cause = error, depth = 0; cause && typeof cause === "object" && !seen.has(cause) && depth < 8; depth++) {
    seen.add(cause);
    const failure = cause as { message?: unknown; cause?: unknown; name?: unknown };
    const message = typeof failure.message === "string" ? failure.message : "";
    const providerHint = publicProviderFailureGuidance(new Error(message));
    if (providerHint) { hint = providerHint; break; }
    // Only Core's sanitized provider prefix permits classification. An SDK or
    // subprocess message can contain prompt/code/argv and must never be echoed.
    if (/^The (?:codex|claude|gemini|opencode|antigravity) [\w-]+ agent (?:failed|timed out)\./.test(message)) {
      if (message.includes("Codex reported a usage or capacity limit.")) hint = " Codex reported a usage or capacity limit; retry after it resets or use another configured provider.";
      else if (message.includes("Codex rejected the configured model.")) hint = " Codex rejected its configured model; choose one available to this CLI and account.";
      else if (message.includes("Codex authentication failed.")) hint = " Codex authentication failed; sign in to the CLI and retry.";
      else if (message.includes("Codex could not maintain its provider connection.")) hint = " Codex lost its provider connection; check connectivity and retry.";
      else hint = " The coding provider failed or timed out; check its authentication, availability and private diagnostics.";
      break;
    }
    if (failure.name === "TimeoutFailure") hint = " A durable stage exceeded its configured deadline.";
    cause = failure.cause;
  }
  return `Durable pipeline failed${knownPhase ? ` during ${knownPhase}` : ""}.${hint} Inspect the worker's private .webmcpify/trajectories diagnostics and Temporal history. No stages were automatically retried; check recorded apply/rollback state before starting a new run.`;
}

export async function runDurableWorkflow(opts: RunOptions): Promise<void> {
  const { Client, Connection } = await loadTemporalClient();
  const sitePath = await realpath(path.resolve(opts.path ?? process.cwd()));
  const targetUrl = opts.url ?? process.env.WEBMCPIFY_URL;
  if (!opts.resume && !targetUrl) throw new Error("A running site URL is required for a new durable run. Pass --url or set WEBMCPIFY_URL.");
  const workflowId = opts.resume ?? coreWorkflowId(sitePath);
  let workflowOptions: CoreWorkflowOptions | undefined;
  if (!opts.resume) {
    const method = opts.method ?? "auto";
    if (!["auto", "declarative", "imperative"].includes(method)) throw new Error("Unknown generation method. Choose auto, declarative, or imperative.");
    if (opts.reviewPort !== undefined) durableTimeout(opts.reviewPort, 4173, 65535, "--review-port");
    workflowOptions = { path: sitePath, url: normalizeTargetUrl(targetUrl!), provider: resolveProvider(opts.provider),
      method, security: resolveSecurityPolicy(opts.security, "balance"), runId: randomUUID(), reviewPort: opts.reviewPort,
      productContext: await collectProductContext(opts.productContext, opts.productContextPrompt), baseline: opts.baseline,
      activityTimeoutMinutes: durableTimeout(opts.activityTimeout, 120, 10080, "--activity-timeout"),
      reviewTimeoutHours: durableTimeout(opts.reviewTimeout, 168, 8760, "--review-timeout") };
  }
  const connection = await Connection.connect(temporalConnectionOptions());
  try {
    const client = new Client({ connection, namespace: process.env.WEBMCPIFY_TEMPORAL_NAMESPACE ?? "default" });
    let handle: WorkflowHandle<CoreWorkflow>;
    let executionId: string;
    let historicalResult = false;
    if (opts.resume) {
      const description = await client.workflow.getHandle(workflowId, opts.executionId).describe();
      // Pin to one execution, not a subsequent reuse of this per-target ID.
      handle = client.workflow.getHandle<CoreWorkflow>(workflowId, description.runId);
      executionId = description.runId;
      historicalResult = description.status.name !== "RUNNING";
      const progress = await handle.query<CoreProgress>("coreProgress");
      // An old WEBMCPIFY_URL in the client environment must not override the
      // recorded URL of an explicitly resumed execution.
      if (progress.path !== sitePath || (opts.url && progress.url !== normalizeTargetUrl(opts.url))) {
        throw new Error("The resumed workflow belongs to another target path or URL. Use the original target; nothing was started.");
      }
      console.log(`[run] attached to durable workflow: ${workflowId}`);
      if (historicalResult) console.log("[run] reading the saved result of a finished execution; this does not run a fresh audit of the current source");
    } else {
      try {
        const started = await client.workflow.start<CoreWorkflow>("coreWorkflow", { workflowId,
          taskQueue: process.env.WEBMCPIFY_TEMPORAL_TASK_QUEUE ?? "webmcpify", args: [workflowOptions!] });
        handle = started;
        executionId = started.firstExecutionRunId;
      } catch (error) {
        if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError") {
          throw new Error(`A durable pipeline is already running for this target. Reattach with webmcpify run --durable --resume ${workflowId}.`);
        }
        throw error;
      }
      console.log(`[run] durable workflow started: ${workflowId}`);
    }
    console.log(`[run] execution: ${executionId}`);
    console.log(`[run] reattach after a client disconnect: webmcpify run --durable --resume ${workflowId} --execution-id ${executionId} --path ${JSON.stringify(sitePath)}`);
    if (!historicalResult) console.log("[run] worker and target server must remain available. Ctrl+C disconnects this client; it does not cancel the workflow.");
    let polling = false;
    let ended = false;
    let lastPhase = "";
    let lastReviewUrl = "";
    const report = async () => {
      if (polling || ended) return;
      polling = true;
      try {
        const progress = await connection.withDeadline(Date.now() + 3000, () => handle.query<CoreProgress>("coreProgress"));
        if (ended) return;
        const phase = `${progress.phase}${progress.totalTasks ? ` (${progress.completedTasks}/${progress.totalTasks} tasks)` : ""}`;
        if (phase !== lastPhase) { console.log(`[run] ${phase}`); lastPhase = phase; }
        if (progress.reviewUrl && progress.reviewUrl !== lastReviewUrl) {
          console.log(`[run] ACTION REQUIRED: review ${progress.reviewUrl} on the worker machine`);
          lastReviewUrl = progress.reviewUrl;
        }
      } catch { /* A queued workflow or brief service outage is not a new run. */ }
      finally { polling = false; }
    };
    const timer = setInterval(() => { void report(); }, 5000);
    timer.unref();
    let result: CoreWorkflowResult;
    try {
      void report();
      result = await withCliProgress("run", "Durable pipeline (waiting for worker/owner as needed)", () => handle.result());
    } catch (error) {
      // The SDK's top-level "Workflow execution failed" hides useful nested
      // provider failures. Query the final phase, but never echo raw causes.
      try {
        const progress = await connection.withDeadline(Date.now() + 3000, () => handle.query<CoreProgress>("coreProgress"));
        lastPhase = progress.phase;
      } catch { /* Saved phase remains useful if the service is unavailable. */ }
      throw new Error(durableFailureMessage(error, lastPhase));
    } finally { ended = true; clearInterval(timer); }
    if (result.status === "rejected") { console.log("[run] stopped: draft rejected; no patch was applied"); return; }
    if (result.baselinePath) console.log(`[run] UI baseline: ${result.baselinePath}`);
    if (result.evaluationPath) console.log(`[run] evaluation: ${result.evaluationPath}`);
    if (result.status !== "passed") throw new Error(`${result.total - result.passed} of ${result.total} approved tasks failed independent verification. Inspect the saved evaluation.`);
    console.log(`[run] complete: ${result.passed}/${result.total} approved tasks verified through Temporal`);
  } finally { await connection.close(); }
}
