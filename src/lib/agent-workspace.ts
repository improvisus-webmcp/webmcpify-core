import { appendFile, cp, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, symlink, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { currentOperationSignal } from "./operation-context.js";

const execFileAsync = promisify(execFile);

/**
 * Agents always run against a disposable copy. The target checkout is only
 * changed later by WebMCPify's explicit review/apply boundary.
 */
export async function createAgentWorkspace(sitePath: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "webmcpify-agent-"));
  try {
    const sourceRoot = await realpath(sitePath);
    await cp(sourceRoot, workspace, {
      recursive: true,
      // Node otherwise resolves even relative links back into the owner tree.
      verbatimSymlinks: true,
      // Reflinks share storage only until a write, never an editable inode.
      // Unlike FICLONE_FORCE, this transparently falls back to a normal copy
      // on unsupported filesystems/platforms or cross-device copies.
      mode: constants.COPYFILE_FICLONE,
      filter: (source) => {
        currentOperationSignal()?.throwIfAborted();
        return !path.relative(sourceRoot, source).split(path.sep)
          .some((component) => [".git", ".webmcpify", ".serena", "node_modules", ".pnpm-store"].includes(component));
      },
    });
    await confineWorkspaceLinks(sourceRoot, workspace);
    return workspace;
  } catch (error) {
    await removeAgentWorkspace(workspace);
    throw error;
  }
}

async function confineWorkspaceLinks(sourceRoot: string, workspace: string, directory = workspace): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    currentOperationSignal()?.throwIfAborted();
    const copiedPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await confineWorkspaceLinks(sourceRoot, workspace, copiedPath);
    else if (entry.isSymbolicLink()) {
      const relative = path.relative(workspace, copiedPath);
      const link = await readlink(copiedPath);
      const sourceTarget = path.resolve(path.dirname(path.join(sourceRoot, relative)), link);
      const targetRelative = path.relative(sourceRoot, sourceTarget);
      if (path.isAbsolute(targetRelative) || targetRelative.split(path.sep)[0] === "..") {
        throw new Error(`Cannot isolate symbolic link outside the selected target: ${relative}. Select a common project root containing its source, or replace the external link with a local source copy.`);
      }
      if (path.isAbsolute(link)) {
        const copiedTarget = path.join(workspace, targetRelative);
        // Junctions need a directory type on Windows; relative and dangling
        // links keep their original type/text because they already stay local.
        const isDirectory = await stat(copiedPath).then(info => info.isDirectory(), () => false);
        await unlink(copiedPath);
        await symlink(copiedTarget, copiedPath, process.platform === "win32" && isDirectory ? "junction" : isDirectory ? "dir" : "file");
      }
    }
  }
}

/** Browser evaluation needs no copy of the target's source or private files. */
export async function createBrowserAgentWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "webmcpify-browser-agent-"));
}

/** Create a baseline so edits made by the agent can become a real git diff. */
export async function initializeAgentWorkspace(workspace: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "webmcpify@localhost"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "WebMCPify"], { cwd: workspace });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
  await execFileAsync("git", ["config", "core.hooksPath", path.join(workspace, ".git", "disabled-hooks")], { cwd: workspace });
  // Discovery is provided as a local workspace-only artifact. Keep it out of
  // the source diff even if the provider reads or updates it.
  await mkdir(path.join(workspace, ".git", "info"), { recursive: true });
  await appendFile(
    path.join(workspace, ".git", "info", "exclude"),
    ".webmcpify/\n.agents/\n.serena\nnode_modules/\n.pnpm-store/\n",
    "utf8",
  );
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "agent workspace baseline"], { cwd: workspace });
}

export async function readAgentWorkspaceDiff(workspace: string): Promise<string> {
  // `git diff HEAD` omits untracked files. Stage the disposable workspace
  // first so newly-created source files become proper additions in the patch.
  // Runtime artifacts remain excluded by .git/info/exclude and the pathspec.
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  const result = await execFileAsync(
    "git",
    [
      "diff",
      "--cached",
      "--binary",
      "HEAD",
      "--",
      ".",
      ":(exclude).webmcpify/**",
      ":(exclude).agents/**",
      ":(exclude,glob)**/.serena",
      ":(exclude,glob)**/.serena/**",
      ":(exclude).gemini/settings.json",
      ":(exclude,glob)**/node_modules",
      ":(exclude,glob)**/node_modules/**",
      ":(exclude,glob)**/.pnpm-store",
      ":(exclude,glob)**/.pnpm-store/**",
      ":(exclude)tasks.json",
    ],
    { cwd: workspace, maxBuffer: 50 * 1024 * 1024 },
  );
  return result.stdout;
}

export async function removeAgentWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}
