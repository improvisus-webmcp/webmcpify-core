import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { taskExpectedOutcome, type Task } from "./tasks.js";

export interface TaskResult {
  task: string;
  passed: boolean;
  detail: string;
}

export interface TaskScoreSummary {
  passed: number;
  total: number;
  results: TaskResult[];
}

let browserCache: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserCache) {
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

async function getIsolatedPage(url: string, resetStorage = true): Promise<{ context: BrowserContext; page: Page }> {
  const browser = await getBrowser();
  const context = browser.contexts()[0];
  if (!context) throw new Error("The connected Chrome instance has no browser context.");

  await context.clearCookies();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (resetStorage) {
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.locator("body").waitFor({ timeout: 15_000 });
    return { context, page };
  } catch (error) {
    await page.close().catch(() => undefined);
    throw error;
  }
}

function agentEvidenceText(value: unknown, key?: string): string {
  if (typeof value === "string") {
    return key && ["prompt", "input", "instructions", "command", "args"].includes(key)
      ? ""
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => agentEvidenceText(entry, key)).filter(Boolean).join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([childKey, childValue]) => agentEvidenceText(childValue, childKey))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function requiredToolsObserved(task: Task, agentOutput: unknown): boolean {
  if (!task.requiredTools?.length) return true;
  const evidence = agentEvidenceText(agentOutput).toLowerCase();
  return task.requiredTools.every((tool) => evidence.includes(tool.toLowerCase()));
}

export function expectedRejectionObserved(task: Task, agentOutput: unknown): boolean {
  if (taskExpectedOutcome(task) !== "rejection" || !task.expectedError || agentOutput === undefined) {
    return false;
  }
  const evidence = agentEvidenceText(agentOutput).replace(/\s+/g, " ").toLowerCase();
  const expected = task.expectedError.replace(/\s+/g, " ").trim().toLowerCase();
  return expected.length > 0
    && evidence.includes(expected)
    && requiredToolsObserved(task, agentOutput);
}

export async function scoreTask(
  url: string,
  task: Task,
  options: {
    resetStorage?: boolean;
    agentOutput?: unknown;
    requireToolEvidence?: boolean;
  } = {},
): Promise<TaskResult> {
  let page: Page | undefined;
  try {
    ({ page } = await getIsolatedPage(url, options.resetStorage ?? true));
    const stateVerified = Boolean(await page.evaluate(task.verify));
    const toolsObserved = requiredToolsObserved(task, options.agentOutput);
    if (taskExpectedOutcome(task) === "rejection") {
      const rejectionObserved = expectedRejectionObserved(task, options.agentOutput);
      return {
        task: task.id,
        passed: stateVerified && rejectionObserved,
        detail: `expected rejection → ${rejectionObserved ? "observed" : "not observed"}; postcondition → ${stateVerified}`,
      };
    }
    const evidencePassed = !options.requireToolEvidence || toolsObserved;
    return {
      task: task.id,
      passed: stateVerified && evidencePassed,
      detail: options.requireToolEvidence
        ? `tools → ${toolsObserved ? "observed" : "not observed"}; verify → ${String(stateVerified)}`
        : `verify → ${String(stateVerified)}`,
    };
  } catch (error) {
    return {
      task: task.id,
      passed: false,
      detail: `verify threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Reset the isolated browser state before a task agent runs. */
export async function resetScoringState(url: string): Promise<void> {
  const { page } = await getIsolatedPage(url, true);
  await page.close();
}

/** Ensure the connected browser exposes the runtime required by WebMCP. */
export async function assertWebMcpRuntime(url: string): Promise<void> {
  let page: Page | undefined;
  try {
    ({ page } = await getIsolatedPage(url, false));
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
    await page?.close().catch(() => undefined);
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
