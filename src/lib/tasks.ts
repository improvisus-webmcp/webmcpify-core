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
  /** Approved WebMCP tools needed to complete this task. */
  requiredTools?: string[];
  /** Explicit setup the browser agent must complete before the primary action. */
  setup?: string;
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
  if (!Array.isArray(manifest.tasks) || taskFingerprint(tasks) !== manifest.taskSetId || taskFingerprint(validateTasks(manifest.tasks)) !== manifest.taskSetId) {
    throw new Error("tasks.json does not match the approved task set; refusing evaluation.");
  }
  return tasks;
}

export async function writeApprovedTasksAtomically(sitePath: string, manifest: ApprovedTaskManifest): Promise<void> {
  const validated = validateTasks(manifest.tasks);
  if (taskFingerprint(validated) !== manifest.taskSetId) throw new Error("Approved task manifest fingerprint does not match its tasks.");
  const destination = approvedManifestPath(sitePath);
  const taskDestination = tasksPath(sitePath);
  const suffix = `.${process.pid}.${Date.now()}.tmp`;
  const manifestTemp = `${destination}${suffix}`;
  const tasksTemp = `${taskDestination}${suffix}`;
  try {
    await writeFile(tasksTemp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await writeFile(manifestTemp, `${JSON.stringify({ ...manifest, tasks: validated }, null, 2)}\n`, "utf8");
    const writtenTasks = validateTasks(JSON.parse(await readFile(tasksTemp, "utf8")));
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

const MIN_TASKS = 5;
const MAX_TASKS = 6;

export function tasksPath(sitePath: string): string {
  return path.join(sitePath, "tasks.json");
}

export function validateTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) {
    throw new Error("tasks.json must contain an array of tasks.");
  }
  if (value.length < MIN_TASKS || value.length > MAX_TASKS) {
    throw new Error(
      `tasks.json must contain ${MIN_TASKS}-${MAX_TASKS} tasks; received ${value.length}.`
    );
  }

  const ids = new Set<string>();
  return value.map((candidate, index) => validateTask(candidate, index, ids));
}

/**
 * A proposed task must be executable through the exact tool set that review
 * will approve. Legacy approved task manifests may omit these fields, but new
 * proposals cannot; otherwise Core could score an action no generated tool can
 * perform.
 */
export function validateTaskToolBindings(tasks: Task[], approvedToolNames: Iterable<string>): Task[] {
  const approved = new Set([...approvedToolNames].map((name) => name.trim()).filter(Boolean));
  return tasks.map((task) => {
    if (!task.requiredTools?.length) {
      if (/document\.modelContext/.test(task.verify)) return task;
      throw new Error(`Task "${task.id}" must declare requiredTools from the generated WebMCP proposal.`);
    }
    const unavailable = task.requiredTools.filter((tool) => !approved.has(tool));
    if (unavailable.length) {
      throw new Error(`Task "${task.id}" requires unavailable WebMCP tool(s): ${unavailable.join(", ")}.`);
    }
    if (task.requiredTools.length > 1 && !task.setup) {
      throw new Error(`Task "${task.id}" uses multiple WebMCP tools and must declare self-contained setup instructions.`);
    }
    return task;
  });
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

  const normalized = {
    id,
    description: task.description.trim(),
    verify: task.verify.trim(),
    ...(requiredTools ? { requiredTools } : {}),
    ...(task.setup?.trim() ? { setup: task.setup.trim() } : {}),
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
    return validateTasks(JSON.parse(await readFile(filePath, "utf8")));
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
  const validated = validateTasks(tasks);
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

function taskArray(value: unknown): Task[] | undefined {
  try {
    return validateTasks(value);
  } catch {
    return undefined;
  }
}

function recoverValidTaskArray(value: unknown): Task[] | undefined {
  if (!Array.isArray(value) || value.length < MIN_TASKS || value.length > MAX_TASKS) return undefined;

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
      // set still satisfies the normal 5-6 task approval contract.
    }
  }
  try {
    return validateTasks(valid);
  } catch {
    return undefined;
  }
}

/** Extract a 5-6 task proposal from an agent's draft without executing it. */
export function extractTasksFromText(raw: string): Task[] | undefined {
  const candidates: string[] = [];
  const text = normalizeProviderOutput(raw);
  const sources = text === raw ? [text] : [text, raw];
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
      const tasks = taskArray(parsed) ?? recoverValidTaskArray(parsed);
      if (tasks) return tasks;
    } catch {
      // Continue through the possible fenced or embedded JSON candidates.
    }
  }
  return undefined;
}
