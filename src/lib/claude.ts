import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveExecutable } from "./executables.js";
import { currentOperationSignal } from "./operation-context.js";

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  allowedTools?: string;
  mcpConfig?: string;
  saveTo: string;
  timeout?: number;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<unknown> {
  const args = ["-p", opts.prompt, "--output-format", "json"];
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  if (opts.mcpConfig) args.push("--mcp-config", opts.mcpConfig);

  const command = resolveExecutable("claude", "WEBMCPIFY_CLAUDE_BIN");
  let stdout: string;
  try {
    const signal = currentOperationSignal();
    const subprocess = execa(command, args, { cwd: opts.cwd, stdin: "ignore", detached: process.platform !== "win32", timeout: opts.timeout ?? 15 * 60_000, cancelSignal: signal });
    const terminate = (): void => {
      if (subprocess.pid && process.platform === "win32") {
        void execa("taskkill", ["/pid", String(subprocess.pid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
      } else if (subprocess.pid) {
        try { process.kill(-subprocess.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      subprocess.kill("SIGKILL");
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    signal?.addEventListener("abort", terminate, { once: true });
    try { ({ stdout } = await subprocess); }
    finally {
      terminate();
      process.removeListener("SIGINT", terminate);
      process.removeListener("SIGTERM", terminate);
      signal?.removeEventListener("abort", terminate);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        "Could not find the Claude CLI. Install it, add it to PATH, or set WEBMCPIFY_CLAUDE_BIN in .env."
      );
    }
    throw error;
  }

  await mkdir(path.dirname(opts.saveTo), { recursive: true });
  await writeFile(opts.saveTo, stdout, "utf8");

  return JSON.parse(stdout);
}
