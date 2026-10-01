import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { randomUUID } from "node:crypto";
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
    page?: Page;
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
    await ownedContext?.close().catch(() => undefined);
  }
}

/** Reset the isolated browser state before a task agent runs. */
export async function resetScoringState(url: string): Promise<{
  page: Page;
  instruction: string;
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
