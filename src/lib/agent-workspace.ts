import { appendFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Agents always run against a disposable copy. The target checkout is only
 * changed later by WebMCPify's explicit review/apply boundary.
 */
export async function createAgentWorkspace(sitePath: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "webmcpify-agent-"));
  try {
    await cp(sitePath, workspace, {
      recursive: true,
      filter: (source) => !path.relative(sitePath, source).split(path.sep)
        .some((component) => [".git", ".webmcpify", "node_modules"].includes(component)),
    });
    return workspace;
  } catch (error) {
    await removeAgentWorkspace(workspace);
    throw error;
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
    ".webmcpify/\n.agents/\nnode_modules/\n",
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
      ":(exclude).gemini/settings.json",
      ":(exclude)node_modules/**",
      ":(exclude)tasks.json",
    ],
    { cwd: workspace, maxBuffer: 50 * 1024 * 1024 },
  );
  return result.stdout;
}

export async function removeAgentWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}
