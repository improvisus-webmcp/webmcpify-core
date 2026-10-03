import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateVerifyExpression, verificationErrors, type VerificationContext, type VerificationIssue } from "./task-verification.js";
import { normalizeProviderOutput } from "./provider-output.js";

export interface Task {
  id: string;
  description: string;
  verify: string;
  /** Whether the primary tool call must succeed or be rejected by a known guard. */
  expectedOutcome?: "success" | "rejection";
  /** Stable error text required in the recorded WebMCP execution response. */
  expectedError?: string;
  /** Approved tools in execution order; the last tool is the primary action. */
  requiredTools?: string[];
  /** Preparation before the primary action; rejection setup must preserve the unmet guard. */
  setup?: string;
}

export interface ToolTestContract {
  name: string;
  expectedFailures?: Array<{ condition: string; error: string }>;
  behavior?: {
    expectedFailures: Array<{ condition: string; error: string }>;
  };
}

export function taskExpectedOutcome(task: Task): "success" | "rejection" {
  return task.expectedOutcome ?? "success";
}

export function taskFingerprint(tasks: Task[]): string {
  return createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 16);
}

export function approvedManifestPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "approved-tools.json");
}

export interface ApprovedTaskManifest {
  version: 1;
  approved: true;
  approvalId: string;
  draftPath: string;
  taskSetId: string;
  tasks: Task[];
  tools?: unknown[];
}

export async function loadApprovedTasks(sitePath: string): Promise<Task[]> {
  const tasks = await loadTasks(sitePath);
  const manifestPath = approvedManifestPath(sitePath);
  if (!existsSync(manifestPath)) {
    throw new Error(`No approved task manifest found at ${manifestPath}. Run "webmcpify review" first.`);
  }
  let manifest: Partial<ApprovedTaskManifest>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<ApprovedTaskManifest>;
  } catch (error) {
    throw new Error(`Could not parse approved manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.approved !== true || typeof manifest.approvalId !== "string" || typeof manifest.taskSetId !== "string") {
    throw new Error("The approved manifest is incomplete or not approved for this draft.");
  }
  if (!Array.isArray(manifest.tasks) || taskFingerprint(tasks) !== manifest.taskSetId || taskFingerprint(validateTasks(manifest.tasks, 1)) !== manifest.taskSetId) {
    throw new Error("tasks.json does not match the approved task set; refusing evaluation.");
  }
  return tasks;
}

export async function writeApprovedTasksAtomically(sitePath: string, manifest: ApprovedTaskManifest): Promise<void> {
  const validated = validateTasks(manifest.tasks, 1);
  if (taskFingerprint(validated) !== manifest.taskSetId) throw new Error("Approved task manifest fingerprint does not match its tasks.");
  const destination = approvedManifestPath(sitePath);
  const taskDestination = tasksPath(sitePath);
  const suffix = `.${process.pid}.${Date.now()}.tmp`;
  const manifestTemp = `${destination}${suffix}`;
  const tasksTemp = `${taskDestination}${suffix}`;
  try {
    await writeFile(tasksTemp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await writeFile(manifestTemp, `${JSON.stringify({ ...manifest, tasks: validated }, null, 2)}\n`, "utf8");
    const writtenTasks = validateTasks(JSON.parse(await readFile(tasksTemp, "utf8")), 1);
    const writtenManifest = JSON.parse(await readFile(manifestTemp, "utf8")) as ApprovedTaskManifest;
    if (taskFingerprint(writtenTasks) !== manifest.taskSetId || writtenManifest.approvalId !== manifest.approvalId) throw new Error("Atomic approval verification failed before commit.");
    await rename(tasksTemp, taskDestination);
    await rename(manifestTemp, destination);
    await loadApprovedTasks(sitePath);
  } finally {
    await Promise.all([rm(tasksTemp, { force: true }), rm(manifestTemp, { force: true })]);
  }
}

export function taskVerificationIssues(task: Task, context: VerificationContext = {}): VerificationIssue[] {
  return validateVerifyExpression(task.verify, task.description, context);
}

/** Accept the lower end of the requested 20–30% verification margin. */
export function minimumTaskCount(toolCount: number): number {
  if (!Number.isSafeInteger(toolCount) || toolCount < 1) throw new Error("A task proposal requires at least one WebMCP tool.");
  return Math.ceil(toolCount * 1.2);
}

export function tasksPath(sitePath: string): string {
  return path.join(sitePath, "tasks.json");
}

export function validateTasks(value: unknown, minimum = 1): Task[] {
  if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error("The minimum task count must be a positive integer.");
  if (!Array.isArray(value)) {
    throw new Error("tasks.json must contain an array of tasks.");
  }
  if (value.length < minimum) {
    throw new Error(
      `tasks.json must contain at least ${minimum} valid task(s); received ${value.length}.`
    );
  }

  const ids = new Set<string>();
  return value.map((candidate, index) => validateTask(candidate, index, ids));
}

/** Match a concrete test error against a declared message, not executable code.
 * Template placeholders may vary; their literal business-rule text may not.
 * Runtime scoring still requires the task's concrete expectedError. */
function declaredErrorMatches(declared: string, expected: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const message = normalize(declared), concrete = normalize(expected);
  if (message.includes(concrete) || concrete.includes(message)) return true;
  // Providers sometimes describe the template in prose and quote the actual
  // message. Only extract explicitly quoted templates; never infer wildcards
  // from arbitrary prose or evaluate the placeholder expression.
  const quoted = [...declared.matchAll(/`([^`]*\$\{[^{}]+\}[^`]*)`/g)].map(match => match[1]!);
  const templates = quoted.length ? quoted : [declared];
  return templates.some(template => {
    const parts = normalize(template).split(/\$\{[^{}]+\}/g);
    // Keep this compatibility rule narrow: one varying value in an otherwise
    // concrete error message. Complex templates need corrected metadata.
    if (parts.length !== 2) return false;
    // An all-variable or nearly empty template must not authorize any error.
    if ((parts.join("").match(/[a-z]/g) ?? []).length < 8) return false;
    const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${parts.map(escape).join(".{1,200}")}$`).test(concrete);
  });
}

/**
 * A proposed task must be executable through the exact tool set that review
 * will approve. Legacy approved task manifests may omit these fields, but new
 * proposals cannot; otherwise Core could score an action no generated tool can
 * perform.
 */
export function validateTaskToolBindings(
  tasks: Task[],
  approvedTools: Iterable<string | ToolTestContract>,
): Task[] {
  const contracts = [...approvedTools].map((tool) =>
    typeof tool === "string" ? { name: tool } : tool
  );
  const approved = new Set(contracts.map((tool) => tool.name.trim()).filter(Boolean));
  const referenced = new Set<string>();

  const validated = tasks.map((task) => {
    if (!task.requiredTools?.length) {
      if (/document\.modelContext/.test(task.verify)) return task;
      throw new Error(`Task "${task.id}" must declare requiredTools from the generated WebMCP proposal.`);
    }
    const unavailable = task.requiredTools.filter((tool) => !approved.has(tool));
    if (unavailable.length) {
      throw new Error(`Task "${task.id}" requires unavailable WebMCP tool(s): ${unavailable.join(", ")}.`);
    }
    task.requiredTools.forEach((tool) => referenced.add(tool));
    if (task.requiredTools.length > 1 && !task.setup) {
      throw new Error(`Task "${task.id}" uses multiple WebMCP tools and must declare self-contained setup instructions.`);
    }
    if (taskExpectedOutcome(task) === "rejection") {
      // Negative cases may need preparation (for example, clearing a cart or
      // selecting an absent item). The declared error and independent
      // postcondition still have to prove rejection of the guarded action.
      const contract = contracts.find((tool) => tool.name === task.requiredTools?.at(-1));
      const expectedFailures = contract?.expectedFailures ?? contract?.behavior?.expectedFailures ?? [];
      if (expectedFailures.length === 0) {
        throw new Error(`Rejection task "${task.id}" is not backed by a declared expected failure for tool "${contract?.name}".`);
      }
      if (
        expectedFailures.length > 0
        && !expectedFailures.some((failure) => declaredErrorMatches(failure.error, task.expectedError!))
      ) {
        throw new Error(`Rejection task "${task.id}" expectedError is not declared by tool "${contract?.name}".`);
      }
    }
    return task;
  });

  const untested = [...approved].filter((tool) => !referenced.has(tool));
  if (untested.length) {
    throw new Error(`Every proposed WebMCP tool must be tested; missing task coverage for: ${untested.join(", ")}.`);
  }
  return validated;
}

/** New and revised proposals share one count/coverage contract; legacy approved sets remain readable. */
export function validateToolScaledTasks(tasks: Task[], tools: Iterable<string | ToolTestContract>): Task[] {
  const contracts = [...tools];
  const validated = validateTaskToolBindings(validateTasks(tasks), contracts);
  for (const task of validated) {
    const unsafeStorage = taskVerificationIssues(task).find(issue => issue.code === "storage-null");
    if (unsafeStorage) throw new Error(`Task "${task.id}" has unsafe empty-storage verification: ${unsafeStorage.message}`);
  }
  const toolCount = new Set(contracts.map(tool => (typeof tool === "string" ? tool : tool.name).trim()).filter(Boolean)).size;
  const minimum = minimumTaskCount(toolCount);
  if (validated.length < minimum) throw new Error(`Proposed ${toolCount} tool(s) require at least ${minimum} valid verification tasks (20% extra, rounded up); received ${validated.length}.`);
  return validated;
}

function validateTask(candidate: unknown, index: number, ids = new Set<string>()): Task {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(`Task ${index + 1} must be an object.`);
  }

  const task = candidate as Partial<Task>;
  if (
    typeof task.id !== "string" ||
    !/^[a-z][a-z0-9_-]*$/i.test(task.id.trim())
  ) {
    throw new Error(
      `Task ${index + 1} has an invalid id; use letters, numbers, underscores, or hyphens.`
    );
  }
  const id = task.id.trim();
  if (ids.has(id)) {
    throw new Error(`Task id "${id}" is duplicated.`);
  }
  ids.add(id);

  if (typeof task.description !== "string" || !task.description.trim()) {
    throw new Error(`Task "${id}" must have a description.`);
  }
  if (typeof task.verify !== "string" || !task.verify.trim()) {
    throw new Error(`Task "${id}" must have a verify expression.`);
  }

  let requiredTools: string[] | undefined;
  if (task.requiredTools !== undefined) {
    if (!Array.isArray(task.requiredTools) || task.requiredTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
      throw new Error(`Task "${id}" has invalid required WebMCP tool names.`);
    }
    requiredTools = [...new Set(task.requiredTools.map((tool) => tool.trim()))];
  }
  if (task.setup !== undefined && typeof task.setup !== "string") {
    throw new Error(`Task "${id}" has an invalid setup instruction.`);
  }
  if (task.expectedOutcome !== undefined && task.expectedOutcome !== "success" && task.expectedOutcome !== "rejection") {
    throw new Error(`Task "${id}" has an invalid expectedOutcome; use "success" or "rejection".`);
  }
  if (task.expectedError !== undefined && (typeof task.expectedError !== "string" || !task.expectedError.trim())) {
    throw new Error(`Task "${id}" has an invalid expectedError.`);
  }
  const expectedOutcome = task.expectedOutcome ?? "success";
  if (expectedOutcome === "rejection" && !task.expectedError?.trim()) {
    throw new Error(`Rejection task "${id}" must declare the expected error text.`);
  }
  if (expectedOutcome === "success" && task.expectedError !== undefined) {
    throw new Error(`Success task "${id}" cannot declare expectedError.`);
  }

  const normalized: Task = {
    id,
    description: task.description.trim(),
    verify: task.verify.trim(),
    ...(requiredTools ? { requiredTools } : {}),
    ...(task.setup?.trim() ? { setup: task.setup.trim() } : {}),
    ...(expectedOutcome === "rejection" ? { expectedOutcome } : {}),
    ...(task.expectedError?.trim() ? { expectedError: task.expectedError.trim() } : {}),
  };
  const issues = verificationErrors(taskVerificationIssues(normalized));
  if (issues.length) throw new Error(`Task "${id}" has invalid verification: ${issues.map((issue) => issue.message).join(" ")}`);
  return normalized;
}

export async function loadTasks(sitePath: string): Promise<Task[]> {
  const filePath = tasksPath(sitePath);
  if (!existsSync(filePath)) {
    throw new Error(
      `No tasks.json found at ${filePath}. Run "webmcpify generate" and approve the task list with "webmcpify review" first.`
    );
  }

  try {
    return validateTasks(JSON.parse(await readFile(filePath, "utf8")), 1);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function loadTasksIfPresent(
  sitePath: string
): Promise<Task[] | undefined> {
  const filePath = tasksPath(sitePath);
  if (!existsSync(filePath)) return undefined;
  return loadTasks(sitePath);
}

export async function writeTasks(
  sitePath: string,
  tasks: Task[]
): Promise<string> {
  const validated = validateTasks(tasks, 1);
  const filePath = tasksPath(sitePath);
  await writeFile(filePath, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return filePath;
}

export function parseTasksJson(raw: string): Task[] {
  try {
    return validateTasks(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`The approved task list is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

function taskArray(value: unknown, minimum: number): Task[] | undefined {
  try {
    return validateTasks(value, minimum);
  } catch {
    return undefined;
  }
}

function recoverValidTaskArray(value: unknown, minimum: number): Task[] | undefined {
  if (!Array.isArray(value) || value.length < minimum) return undefined;

  const ids = new Set<string>();
  const valid: Task[] = [];
  for (const [index, candidate] of value.entries()) {
    try {
      // Only commit an ID after its entire task passes validation, so one
      // malformed provider entry cannot invalidate a later valid task.
      const candidateIds = new Set(ids);
      const task = validateTask(candidate, index, candidateIds);
      ids.add(task.id);
      valid.push(task);
    } catch {
      // A provider can emit TypeScript-only syntax in one verification
      // expression. Keep independently valid tasks only when the resulting
      // set still satisfies the selected generation/revision count contract.
    }
  }
  try {
    return validateTasks(valid, minimum);
  } catch {
    return undefined;
  }
}

/** Extract syntax-valid tasks; enforce the tool-scaled proposal contract at the review/generation boundary. */
export function extractTasksFromText(raw: string, minimum = 1): Task[] | undefined {
  const candidates: string[] = [];
  const text = normalizeProviderOutput(raw);
  const sources = text === raw ? [text] : [text, raw];
  // A labelled task block wins over incidental examples or tool metadata.
  const labelled = sources.flatMap(source => [...source.matchAll(/\bTASKS_JSON\s*```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]!));
  if (labelled.length) {
    for (const candidate of labelled) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        const tasks = taskArray(parsed, minimum) ?? recoverValidTaskArray(parsed, minimum);
        if (tasks) return tasks;
      }
      catch { /* Invalid explicit task metadata must not fall back to unrelated examples. */ }
    }
    return undefined;
  }
  for (const source of sources) {
    for (const match of source.matchAll(/```(?:[^\n]*\n)?([\s\S]*?)```/gi)) {
      if (match[1]) {
        const trimmed = match[1].trim();
        candidates.push(trimmed);
        const arrStart = trimmed.indexOf("[");
        const arrEnd = trimmed.lastIndexOf("]");
        if (arrStart >= 0 && arrEnd > arrStart) {
          candidates.push(trimmed.slice(arrStart, arrEnd + 1));
        }
      }
    }
    for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      if (match[1]) {
        const trimmed = match[1].trim();
        candidates.push(trimmed);
        const arrStart = trimmed.indexOf("[");
        const arrEnd = trimmed.lastIndexOf("]");
        if (arrStart >= 0 && arrEnd > arrStart) {
          candidates.push(trimmed.slice(arrStart, arrEnd + 1));
        }
      }
    }
    candidates.push(source.trim());
    const firstArray = source.indexOf("[");
    const lastArray = source.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) {
      candidates.push(source.slice(firstArray, lastArray + 1));
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const tasks = taskArray(parsed, minimum) ?? recoverValidTaskArray(parsed, minimum);
      if (tasks) return tasks;
    } catch {
      // Continue through the possible fenced or embedded JSON candidates.
    }
  }
  return undefined;
}
