import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { runOperationCommand } from "./operation-command.js";
import { resolvePackageManager } from "./package-manager.js";
import { createTrajectoryArtifact } from "./trajectories.js";

export class GenerationPreflightError extends Error {
  constructor(readonly diagnostics: string, artifact: string, readonly check = "project validation") {
    super(`Generated source did not pass ${check} pre-approval validation. No source patch was applied and no approval was created. Private build diagnostics: ${artifact}`);
  }
}

export class PreflightEnvironmentError extends Error {
  constructor(artifact: string, reason = "Could not launch the project validation executable. Install the project's package manager/check tools, verify executable permissions, or set WEBMCPIFY_PACKAGE_MANAGER to an executable path.") {
    super(`${reason} No source patch was applied. Private diagnostics: ${artifact}`);
  }
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readProjectPackage(sitePath: string): Promise<PackageJson> {
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(sitePath, "package.json"), "utf8")
    );
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
      throw new Error("Target package.json must contain a JSON object.");
    }
    for (const field of ["scripts", "dependencies", "devDependencies"] as const) {
      const entries = packageJson[field];
      if (entries !== undefined && (!entries || typeof entries !== "object" || Array.isArray(entries)
        || Object.values(entries).some(value => typeof value !== "string"))) {
        throw new Error(`Target package.json ${field} must be an object of strings.`);
      }
    }
    return packageJson as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const artifact = await createTrajectoryArtifact("preflight-failure", { error: outputFromError(error) }, { sitePath, status: "failed" });
    throw new PreflightEnvironmentError(artifact, "Target package.json is unreadable or malformed. Fix its JSON object and scripts/dependency maps before retrying; validation was not skipped.");
  }
}

/**
 * Give the disposable workspace access to already-installed dependencies
 * without copying hundreds of megabytes or writing anything into the target's
 * node_modules. Build caches are kept local to the disposable workspace.
 */
async function linkDependencies(sitePath: string, workspace: string): Promise<boolean> {
  const targetNodeModules = path.join(sitePath, "node_modules");
  if (!existsSync(targetNodeModules)) return false;

  const workspaceNodeModules = path.join(workspace, "node_modules");
  await mkdir(path.join(workspaceNodeModules, ".tmp"), { recursive: true });
  for (const entry of await readdir(targetNodeModules, { withFileTypes: true })) {
    if (entry.name === ".tmp" || entry.name === ".cache") continue;
    const targetEntry = path.join(targetNodeModules, entry.name);
    const workspaceEntry = path.join(workspaceNodeModules, entry.name);
    // The provider or package manager may already have created this entry in
    // the disposable workspace (most commonly node_modules/.bin). Reusing it
    // makes preflight safe to retry after a generated-source repair.
    try {
      await lstat(workspaceEntry);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let isDirectory: boolean;
    try { isDirectory = (await stat(targetEntry)).isDirectory(); }
    catch (error) {
      // A stale optional-dependency link must not break unrelated build checks.
      // Real missing imports will still fail the actual check below.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (process.platform === "win32" && !isDirectory) await copyFile(targetEntry, workspaceEntry);
    else await symlink(targetEntry, workspaceEntry, process.platform === "win32" ? "junction" : isDirectory ? "dir" : "file");
  }
  return true;
}

function outputFromError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const output = [record.stdout, record.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  return output || (typeof record.message === "string" ? record.message : String(error));
}

/** Run the real project check before a generated patch can reach review. */
export async function runGenerationPreflight(
  sitePath: string,
  workspace: string,
): Promise<void> {
  const project = await readProjectPackage(sitePath);
  const scripts = project.scripts ?? {};
  const tscBinary = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const hasTypeScript = existsSync(path.join(sitePath, "tsconfig.json"));
  if (!scripts.typecheck && !hasTypeScript && !scripts.build) {
    console.log("[generate] preflight skipped; no typecheck, TypeScript, or build check found");
    return;
  }
  const hasDependencies = Object.keys(project.dependencies ?? {}).length + Object.keys(project.devDependencies ?? {}).length > 0;
  if (!(await linkDependencies(sitePath, workspace)) && hasDependencies) {
    const artifact = await createTrajectoryArtifact("preflight-failure", { reason: "target-dependencies-missing" }, { sitePath, status: "failed" });
    throw new PreflightEnvironmentError(artifact, "Target project dependencies are not installed. Install them in the target project with its package manager, then rerun generation. Core will not ask the agent to install packages or skip the declared build/typecheck validation.");
  }
  if (!scripts.typecheck && hasTypeScript && !existsSync(path.join(sitePath, "node_modules", ".bin", tscBinary))) {
    const artifact = await createTrajectoryArtifact("preflight-failure", { reason: "target-typescript-compiler-missing" }, { sitePath, status: "failed" });
    throw new PreflightEnvironmentError(artifact, "The target has tsconfig.json but its local TypeScript compiler is missing. Install the target project's TypeScript/build dependencies, then rerun generation; TypeScript validation was not skipped.");
  }
  const manager = scripts.typecheck || scripts.build ? await resolvePackageManager(sitePath) : "";
  const checks: Array<{ label: string; command: string; args: string[] }> = [];
  if (scripts.typecheck) {
    checks.push({ label: "typecheck", command: manager, args: ["run", "typecheck"] });
  } else if (hasTypeScript) {
    checks.push({ label: "TypeScript build", command: path.join(workspace, "node_modules", ".bin", tscBinary), args: ["-b", "--pretty", "false"] });
  }
  // A typecheck does not prove that the framework bundler can resolve imports
  // or produce the deployable client/server output. Run an explicit build too
  // when the target provides one.
  if (scripts.build) {
    checks.push({ label: "build", command: manager, args: ["run", "build"] });
  }
  const startedMs = Date.now();
  console.log(`[generate] preflight running ${checks.map((check) => check.label).join(" + ")} in disposable workspace...`);

  let activeCheck = "project validation";
  try {
    for (const check of checks) {
      activeCheck = check.label;
      await runOperationCommand(check.command, check.args, {
        cwd: workspace,
        // We intentionally reuse installed dependency links. pnpm 11's
        // auto-install before `run` must not purge or mutate that linked tree.
        // Boolean false also works on versions predating the string-mode fix.
        env: { PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false" },
        maxBuffer: 20 * 1024 * 1024,
      });
      console.log(`[generate] preflight ${check.label} passed`);
    }
    console.log(`[generate] preflight passed (${Math.round((Date.now() - startedMs) / 1000)}s elapsed)`);
  } catch (error) {
    const details = outputFromError(error).slice(-4_000);
    const artifact = await createTrajectoryArtifact("preflight-failure", { error: outputFromError(error) }, { sitePath, status: "failed" });
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new PreflightEnvironmentError(artifact);
    if (details.includes("ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY")) throw new PreflightEnvironmentError(artifact, "The project's validation attempted an interactive pnpm dependency install and stopped because no terminal was available. Use already-installed dependencies for build checks; do not force a purge of the linked dependency tree.");
    throw new GenerationPreflightError(details, artifact, activeCheck);
  }
}
