import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { randomUUID } from "node:crypto";
import { taskExpectedOutcome, type Task } from "./tasks.js";
import type { WebMcpEvidence } from "./webmcp-evidence.js";
import { currentOperationSignal } from "./operation-context.js";

export interface TaskResult {
  task: string;
  passed: boolean;
  detail: string;
  failureKind?: "infrastructure" | "evidence" | "rejection" | "postcondition" | "verification";
}

export interface TaskScoreSummary {
  passed: number;
  total: number;
  results: TaskResult[];
}

export function isNonApplicationFailure(result: TaskResult): boolean {
  return result.failureKind === "infrastructure" || result.failureKind === "evidence" || result.failureKind === "verification";
}

let browserCache: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserCache?.isConnected()) {
    const cdpUrl = process.env.WEBMCPIFY_CDP_URL ?? "http://127.0.0.1:9222";
    try {
      browserCache = await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      throw new Error(
        `Could not connect to Chrome at ${cdpUrl}. Start Chrome with remote debugging enabled: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return browserCache;
}

async function getIsolatedPage(url: string): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await getBrowser();
  // Never reset the user's existing CDP context or authentication cookies.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("body").waitFor({ timeout: 15_000 });
    return { context, page };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

function validEvidence(value: unknown): value is WebMcpEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<WebMcpEvidence>;
  return evidence.source === "chrome-devtools-mcp" && Number.isInteger(evidence.pageId)
    && evidence.discovered === true && Array.isArray(evidence.calls)
    && Array.isArray(evidence.policyViolations) && evidence.policyViolations.length === 0
    && !evidence.infrastructureError;
}

export function requiredToolsObserved(task: Task, evidence: unknown): boolean {
  if (!validEvidence(evidence)) return false;
  if (!task.requiredTools?.length) {
    // Availability-only tests must actually discover tools. Legacy effect
    // tests without requiredTools still need at least one real successful call.
    return /document\.modelContext/.test(task.verify) || evidence.calls.some(call => call.status === "success");
  }
  let position = 0;
  for (const name of task.requiredTools) {
    const next = evidence.calls.findIndex((call, index) => index >= position && call.toolName === name
      && (taskExpectedOutcome(task) === "rejection" || call.status === "success"));
    if (next < 0) return false;
    position = next + 1;
  }
  return true;
}

export function expectedRejectionObserved(task: Task, evidence: unknown): boolean {
  if (taskExpectedOutcome(task) !== "rejection" || !task.expectedError || !validEvidence(evidence)) return false;
  const expected = task.expectedError.replace(/\s+/g, " ").trim().toLowerCase();
  const calls = evidence.calls.filter(call => call.toolName === task.requiredTools?.[0]);
  const rejection = calls.at(-1);
  return expected.length > 0 && requiredToolsObserved(task, evidence)
    && calls.filter(call => call.status === "error").length === 1
    && rejection?.status === "error"
    && Boolean(rejection.error?.replace(/\s+/g, " ").toLowerCase().includes(expected));
}

/** page.evaluate can await an unresolved promise; bound every read, not just polling. */
async function boundedRead<T>(read: () => Promise<T>, deadline: number): Promise<T> {
  const signal = currentOperationSignal();
  if (signal?.aborted) throw new Error("Browser verification was cancelled.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Browser verification timed out.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser verification timed out.")), remaining);
        onAbort = () => reject(new Error("Browser verification was cancelled."));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function scoreTask(
  url: string,
  task: Task,
  options: {
    resetStorage?: boolean;
    agentOutput?: unknown;
    toolEvidence?: WebMcpEvidence;
    requireToolEvidence?: boolean;
    page?: Page;
    verificationTimeoutMs?: number;
  } = {},
): Promise<TaskResult> {
  let page: Page | undefined;
  let ownedContext: BrowserContext | undefined;
  try {
    if (options.page) page = options.page;
    else if (options.resetStorage === false) {
      throw new Error("Live-state verification requires the exact task page; refusing to score a fresh page.");
    } else {
      ({ page, context: ownedContext } = await getIsolatedPage(url));
    }
    if (options.requireToolEvidence && options.toolEvidence?.infrastructureError) return {
      task: task.id, passed: false, failureKind: "infrastructure", detail: options.toolEvidence.infrastructureError,
    };
    const toolsObserved = requiredToolsObserved(task, options.toolEvidence);
    if (options.requireToolEvidence && !toolsObserved) return {
      task: task.id, passed: false, failureKind: "evidence",
      detail: "No valid recorded Chrome DevTools WebMCP execution/discovery evidence for this task. Agent reports, tool-name mentions, clicks and other browser bridges do not count.",
    };
    const timeout = options.verificationTimeoutMs ?? 2_000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Verification timeout must be a positive finite number.");
    const deadline = Date.now() + timeout;
    let stateVerified = Boolean(await boundedRead(() => page!.evaluate(task.verify), deadline));
    while (!stateVerified && Date.now() < deadline) {
      await boundedRead(() => new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())))), deadline + 100);
      if (Date.now() >= deadline) break;
      stateVerified = Boolean(await boundedRead(() => page!.evaluate(task.verify), deadline));
    }
    if (taskExpectedOutcome(task) === "rejection") {
      // A guard can reject yet accidentally schedule a later mutation. Require
      // the approved unchanged-state check to stay true for a short settle window.
      if (stateVerified) {
        const stableUntil = Date.now() + 500;
        const stableDeadline = stableUntil + timeout;
        while (stateVerified && Date.now() < stableUntil) {
          await boundedRead(() => new Promise(resolve => setTimeout(resolve, Math.min(50, stableUntil - Date.now()))), stableDeadline);
          stateVerified = Boolean(await boundedRead(() => page!.evaluate(task.verify), stableDeadline));
        }
      }
      // UI baseline is deliberately not a WebMCP audit. Its error evidence
      // comes from the real page's visible feedback, not an agent's report.
      const rejectionObserved = options.requireToolEvidence
        ? expectedRejectionObserved(task, options.toolEvidence)
        : Boolean(task.expectedError && (await boundedRead(() => page!.locator("body").innerText(), Date.now() + timeout)).replace(/\s+/g, " ").toLowerCase().includes(task.expectedError.replace(/\s+/g, " ").toLowerCase()));
      return {
        task: task.id,
        passed: stateVerified && rejectionObserved,
        ...(!rejectionObserved ? { failureKind: "rejection" as const } : !stateVerified ? { failureKind: "postcondition" as const } : {}),
        detail: `expected rejection → ${rejectionObserved ? "observed" : "not observed"}; postcondition → ${stateVerified}`,
      };
    }
    const evidencePassed = !options.requireToolEvidence || toolsObserved;
    return {
      task: task.id,
      passed: stateVerified && evidencePassed,
      ...(!stateVerified ? { failureKind: "postcondition" as const } : {}),
      detail: options.requireToolEvidence
        ? `tools → ${toolsObserved ? "observed" : "not observed"}; verify → ${String(stateVerified)}`
        : `verify → ${String(stateVerified)}`,
    };
  } catch (error) {
    return {
      task: task.id,
      passed: false,
      failureKind: currentOperationSignal()?.aborted ? "infrastructure" : "verification",
      detail: `verify threw: ${error instanceof Error ? error.message : String(error)}${/JSON\.parse\s*\(\s*(?:localStorage|sessionStorage)\.getItem/.test(task.verify) ? " Approved storage checks must handle a missing key without manufacturing persisted state; regenerate/review a null-safe check." : ""}`,
    };
  } finally {
    await ownedContext?.close().catch(() => undefined);
  }
}

/** Reset the isolated browser state before a task agent runs. */
export async function resetScoringState(url: string): Promise<{
  page: Page;
  instruction: string;
  marker: string;
  close: () => Promise<void>;
}> {
  const { context, page } = await getIsolatedPage(url);
  const marker = `webmcpify-task-${randomUUID()}`;
  try {
    await page.evaluate((value) => { window.name = value; }, marker);
    await page.bringToFront();
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  return {
    page,
    marker,
    instruction: `Use the existing task tab at ${url}. Select it with list_pages/select_page and confirm window.name is ${JSON.stringify(marker)} using evaluate_script. Do not create another tab, reload it to reset state, or use other browser contexts. Perform setup and actions in this same tab and leave it open for verification, including after navigation.`,
    close: () => context.close(),
  };
}

/** Ensure the connected browser exposes the runtime required by WebMCP. */
export async function assertWebMcpRuntime(url: string, taskPage?: Page): Promise<void> {
  let page: Page | undefined;
  let ownedContext: BrowserContext | undefined;
  try {
    if (taskPage) page = taskPage;
    else ({ page, context: ownedContext } = await getIsolatedPage(url));
    try {
      await page.waitForFunction(
        () => Boolean((document as Document & { modelContext?: unknown }).modelContext),
        undefined,
        { timeout: 3_000 },
      );
    } catch {
      throw new Error(
        "Chrome does not expose document.modelContext. Restart the dedicated test browser with " +
        "--enable-features=DevToolsWebMCPSupport,WebMCP and retry."
      );
    }
  } finally {
    await ownedContext?.close().catch(() => undefined);
  }
}

export async function scoreTasks(
  url: string,
  tasks: Task[],
  options: { agentOutput?: unknown } = {},
): Promise<TaskScoreSummary> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await scoreTask(url, task, { agentOutput: options.agentOutput }));
  }

  return {
    passed: results.filter((result) => result.passed).length,
    total: tasks.length,
    results,
  };
}

/** Disconnect from CDP without closing the user's Chrome instance. */
export async function closeScoringBrowser(): Promise<void> {
  if (!browserCache) return;
  await browserCache.close();
  browserCache = null;
}
