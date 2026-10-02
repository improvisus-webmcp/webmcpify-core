import { execa } from "execa";
import { existsSync, lstatSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTrajectoryArtifact } from "../lib/trajectories.js";
import {
  gitSourceSnapshot,
  patchArtifactPath,
  patchExists,
  patchMetadataPath,
  readPatchMetadata,
  readPendingPatch,
  sourcePatchHash,
  writePatchMetadata,
  type PatchMetadata,
} from "../lib/patches.js";
import { scoreTasks } from "../lib/scoring.js";
import { loadTasks } from "../lib/tasks.js";
import { WEBMCP_SPEC_URL } from "../lib/webmcp-spec-guidance.js";
import { currentOperationSignal } from "../lib/operation-context.js";
import { resolvePackageManager } from "../lib/package-manager.js";
import { withCliProgress } from "../lib/cli-progress.js";

interface ApplyOptions { path?: string }

interface ApprovalManifest {
  sourceDiff?: { status?: string; runId?: string; patchHash?: string };
}

function safeRelative(sitePath: string, file: string): string {
  const resolved = path.resolve(sitePath, file);
  if (resolved !== path.resolve(sitePath) && !resolved.startsWith(`${path.resolve(sitePath)}${path.sep}`)) {
    throw new Error(`Patch path escapes the target project: ${file}`);
  }
  for (let current = path.resolve(sitePath), parts = path.relative(sitePath, resolved).split(path.sep); parts.length;) {
    current = path.join(current, parts.shift()!);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Patch target paths must not follow symbolic links: ${file}`);
  }
  return resolved;
}

async function runGit(sitePath: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd: sitePath, cancelSignal: currentOperationSignal() });
}

async function availableScripts(sitePath: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(sitePath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return packageJson.scripts ?? {};
  } catch {
    return {};
  }
}

async function runBuild(sitePath: string): Promise<string[]> {
  const scripts = await availableScripts(sitePath);
  const manager = await resolvePackageManager(sitePath);
  const ran: string[] = [];
  for (const script of ["typecheck", "build"]) {
    if (!scripts[script]) continue;
    ran.push(script);
    await withCliProgress("apply", `Running target ${script}`, () => execa(manager, ["run", script], { cwd: sitePath, cancelSignal: currentOperationSignal() }));
  }
  return ran;
}

async function snapshotFiles(sitePath: string, files: string[], rollbackPath: string): Promise<void> {
  await mkdir(rollbackPath, { recursive: true });
  for (const file of files) {
    const source = safeRelative(sitePath, file);
    if (!existsSync(source)) continue;
    const destination = path.join(rollbackPath, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await writeFile(path.join(rollbackPath, "manifest.json"), `${JSON.stringify(files, null, 2)}\n`, "utf8");
}

async function rollbackFiles(sitePath: string, files: string[], rollbackPath: string): Promise<void> {
  const originalFiles = new Set(JSON.parse(await readFile(path.join(rollbackPath, "manifest.json"), "utf8")) as string[]);
  for (const file of files) {
    const target = safeRelative(sitePath, file);
    const backup = path.join(rollbackPath, file);
    if (originalFiles.has(file) && existsSync(backup)) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(backup, target);
    } else if (existsSync(target)) {
      await rm(target);
    }
  }
}

async function recordApply(sitePath: string, metadata: PatchMetadata, result: Record<string, unknown>): Promise<void> {
  await createTrajectoryArtifact("apply", result, {
    sitePath,
    runId: metadata.runId,
    patchPath: metadata.patchPath,
    sourceVersion: metadata.sourceVersion,
    changedFiles: metadata.changedFiles,
    patchStatus: metadata.patchStatus,
  });
}

async function recordRepairEvaluation(sitePath: string, metadata: PatchMetadata): Promise<string | undefined> {
  if (!metadata.repair) return undefined;
  try {
    const before = JSON.parse(await readFile(metadata.repair.sourceEvaluation, "utf8")) as {
      scores?: { results?: Array<{ task: string; passed: boolean; detail: string }> };
    };
    const tasks = (await loadTasks(sitePath)).filter((task) => metadata.repair?.failedTaskIds.includes(task.id));
    const scores = await scoreTasks(metadata.repair.url, tasks);
    const beforeResults = (before.scores?.results ?? []).filter((result) => metadata.repair?.failedTaskIds.includes(result.task));
    const beforePassed = beforeResults.filter((result) => result.passed).length;
    const delta = scores.passed - beforePassed;
    const status = delta > 0 ? "improved" : delta < 0 ? "regressed" : "unchanged";
    return createTrajectoryArtifact("repair-eval", {
      version: 1,
      mode: "repair",
      status,
      runId: metadata.runId,
      targetProject: sitePath,
      taskSetId: metadata.repair.taskSetId,
      sourceEvaluation: metadata.repair.sourceEvaluation,
      failedTaskIds: metadata.repair.failedTaskIds,
      before: { passed: beforePassed, total: beforeResults.length, results: beforeResults },
      after: scores,
      improvement: delta,
    }, {
      sitePath,
      runId: metadata.runId,
      targetProject: sitePath,
      sourceEvaluation: metadata.repair.sourceEvaluation,
      taskSetId: metadata.repair.taskSetId,
      failedTaskIds: metadata.repair.failedTaskIds,
      patchPath: metadata.patchPath,
      repairStatus: status,
    });
  } catch (error) {
    return createTrajectoryArtifact("repair-eval", {
      version: 1,
      mode: "repair",
      status: "failed",
      runId: metadata.runId,
      targetProject: sitePath,
      sourceEvaluation: metadata.repair.sourceEvaluation,
      error: error instanceof Error ? error.message : String(error),
    }, {
      status: "failed",
      sitePath,
      runId: metadata.runId,
      targetProject: sitePath,
      sourceEvaluation: metadata.repair.sourceEvaluation,
      patchPath: metadata.patchPath,
      repairStatus: "failed",
    });
  }
}

export async function runApply(opts: ApplyOptions): Promise<void> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  if (!patchExists(sitePath)) {
    throw new Error(`No pending patch found at ${patchArtifactPath(sitePath)}. Run "webmcpify generate" first.`);
  }

  const metadata = await readPatchMetadata(sitePath);
  let approval: ApprovalManifest;
  try {
    approval = JSON.parse(await readFile(path.join(sitePath, ".webmcpify", "approved-tools.json"), "utf8")) as ApprovalManifest;
  } catch {
    throw new Error("No approved source diff found. Run \"webmcpify review\" and explicitly approve the patch first.");
  }
  if (approval.sourceDiff?.status !== "approved" || approval.sourceDiff.runId !== metadata.runId) {
    throw new Error("The pending source diff is not explicitly approved for this generation run.");
  }
  if (metadata.patchStatus === "applied") {
    throw new Error("This pending patch has already been applied.");
  }
  const patchContent = await readPendingPatch(sitePath, metadata);
  if (approval.sourceDiff.patchHash !== sourcePatchHash(patchContent)) {
    throw new Error("The pending source patch does not match the exact approved patch. Run review again.");
  }

  const current = await gitSourceSnapshot(sitePath);
  if (!current.sourceVersion || !metadata.sourceVersion) {
    throw new Error("Applying a patch requires the target project to be a Git repository with a source commit.");
  }
  if (current.sourceVersion !== metadata.sourceVersion || current.workingTreeHash !== metadata.workingTreeHash) {
    throw new Error("The target project changed after generation/review; refusing to apply the patch.");
  }

  const patch = metadata.patchPath;
  if (!/^[a-zA-Z0-9_-]+$/.test(metadata.runId)) throw new Error("Invalid patch run ID.");
  const rollbackPath = path.join(sitePath, ".webmcpify", "rollback", metadata.runId);
  await withCliProgress("apply", "Preparing rollback snapshot", () => snapshotFiles(sitePath, metadata.changedFiles, rollbackPath));
  let buildScripts: string[] = [];
  try {
    console.log("[apply] validating approved patch...");
    await runGit(sitePath, ["apply", "--check", "--whitespace=nowarn", patch]);
    console.log(`[apply] WebMCP compatibility reference: ${WEBMCP_SPEC_URL}`);
    console.log("[apply] applying approved patch...");
    await runGit(sitePath, ["apply", "--whitespace=nowarn", patch]);
    buildScripts = await runBuild(sitePath);
    const repairEvaluationPath = metadata.repair
      ? await withCliProgress("apply", "Independently verifying repaired tasks", () => recordRepairEvaluation(sitePath, metadata))
      : undefined;
    const applied: PatchMetadata = {
      ...metadata,
      patchStatus: "applied",
      lastApply: { timestamp: new Date().toISOString(), status: "passed" },
    };
    await writePatchMetadata(sitePath, applied);
    await recordApply(sitePath, applied, { status: "passed", buildScripts, rollbackPath, repairEvaluationPath });
    await rm(rollbackPath, { recursive: true, force: true });
    console.log("[apply] ✓ patch applied");
    console.log(buildScripts.length ? "[apply] ✓ build/typecheck passed" : "[apply] ✓ no build/typecheck script found");
    console.log("[apply] WebMCP changes successfully applied.");
  } catch (error) {
    let rollbackError: string | undefined;
    try { await rollbackFiles(sitePath, metadata.changedFiles, rollbackPath); }
    catch (rollbackFailure) { rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure); }
    const message = error instanceof Error ? error.message : String(error);
    const failed: PatchMetadata = {
      ...metadata,
      patchStatus: "failed",
      lastApply: { timestamp: new Date().toISOString(), status: "failed", error: message },
    };
    await writePatchMetadata(sitePath, failed);
    await recordApply(sitePath, failed, { status: "failed", error: message, rollbackError, buildScripts });
    if (rollbackError) throw new Error(`Apply/build failed and rollback failed. Inspect private artifacts at ${patchMetadataPath(sitePath)} and the retained rollback directory ${rollbackPath}.`);
    throw new Error(`Apply/build failed; project restored. Private diagnostics: ${patchMetadataPath(sitePath)}.`);
  }
}
