import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runClaude } from "./claude.js";
import type { AIProvider } from "./ai-provider.js";
import {
  executableOnPath,
  findCodexExecutable,
  resolveExecutable,
} from "./executables.js";
import {
  recordTrajectoryMetadata,
  type TrajectoryMetadata,
} from "./trajectories.js";
import { resolveRecordArtifacts } from "./config.js";

export interface AgentRunOptions {
  provider: AIProvider;
  prompt: string;
  cwd: string;
  allowedTools?: string;
  mcpConfig?: string;
  saveTo: string;
  trajectoryMetadata?: Record<string, unknown>;
}

type ProviderInvocation = {
  command: string;
  args: string[];
  output: "json" | "json-lines" | "text";
};

export function getInvocation(opts: AgentRunOptions): ProviderInvocation {
  switch (opts.provider) {
    case "gemini":
      return {
        command: resolveExecutable("gemini", "WEBMCPIFY_GEMINI_BIN"),
        args: ["-p", opts.prompt, "--output-format", "json", "--yolo"],
        output: "json",
      };
    case "codex":
      return {
        command: findCodexExecutable(),
        args: [
          "exec",
          "--json",
          "--color",
          "never",
          "--ephemeral",
          // Baseline and browser-test workspaces are intentionally disposable
          // copies without the target repository's .git directory.
          "--skip-git-repo-check",
          "--approve-for-me",
          "--cd",
          opts.cwd,
          opts.prompt,
        ],
        output: "json-lines",
      };
    case "antigravity": {
      const command =
        process.env.WEBMCPIFY_ANTIGRAVITY_BIN ??
        executableOnPath("agy") ??
        "agy";
      const args = [
        "-p",
        opts.prompt,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        // Do not inherit a user-level plan mode: generation must edit the
        // disposable workspace or Core has no source patch to review.
        "--mode",
        "accept-edits",
        // AGY can retain a project context independently of the process
        // cwd. Force a fresh project rooted at the disposable workspace
        // and enforce OS-level terminal containment so it cannot discover
        // or edit the real target checkout.
        "--new-project",
        "--add-dir",
        opts.cwd,
        "--sandbox",
      ];
      // Effort is model-dependent in AGY. Do not force a value by default:
      // some installed models reject --effort entirely. Users can opt in
      // after checking their model supports it.
      const effort = process.env.WEBMCPIFY_ANTIGRAVITY_EFFORT || undefined;
      if (effort) args.push("--effort", effort);
      args.push(
        "--print-timeout",
        antigravityPrintTimeout(opts),
      );
      return {
        command,
        args,
        output: "json",
      };
    }
    case "claude":
      throw new Error("Claude is handled by runClaude().");
    case "opencode":
      return {
        command: resolveExecutable("opencode", "WEBMCPIFY_OPENCODE_BIN"),
        args: ["run", "--dangerously-skip-permissions", opts.prompt],
        output: "text",
      };
  }
}

function parseOutput(stdout: string, output: ProviderInvocation["output"]): unknown {
  if (output === "text") return stdout;
  if (output === "json") return JSON.parse(stdout);

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function codexMcpArgs(mcpConfig?: string): Promise<string[]> {
  if (!mcpConfig || !existsSync(mcpConfig)) return [];

  let config: {
    mcpServers?: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string> }
    >;
  };

  try {
    config = JSON.parse(await readFile(mcpConfig, "utf8")) as typeof config;
  } catch (error) {
    throw new Error(
      `Could not read MCP config at ${mcpConfig}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const args: string[] = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (!server.command) continue;
    const key = `mcp_servers.${name}`;
    args.push("-c", `${key}.command=${JSON.stringify(server.command)}`);
    if (server.args) {
      args.push("-c", `${key}.args=${JSON.stringify(server.args)}`);
    }
    if (server.env) {
      args.push("-c", `${key}.env=${JSON.stringify(server.env)}`);
    }
  }
  return args;
}

async function prepareAntigravityMcpConfig(opts: AgentRunOptions): Promise<void> {
  if (!opts.mcpConfig || !existsSync(opts.mcpConfig)) return;

  const workspaceConfig = path.join(opts.cwd, ".agents", "mcp_config.json");
  await mkdir(path.dirname(workspaceConfig), { recursive: true });
  await writeFile(workspaceConfig, await readFile(opts.mcpConfig, "utf8"), "utf8");
}

async function prepareOpenCodeMcpConfig(opts: AgentRunOptions): Promise<void> {
  if (!opts.mcpConfig || !existsSync(opts.mcpConfig)) return;

  let config: {
    mcpServers?: Record<string, {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }>;
  };
  try {
    config = JSON.parse(await readFile(opts.mcpConfig, "utf8")) as typeof config;
  } catch (error) {
    throw new Error(
      `Could not read MCP config at ${opts.mcpConfig}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const servers = Object.fromEntries(
    Object.entries(config.mcpServers ?? {})
      .filter(([, server]) => server.command)
      .map(([name, server]) => [name, {
        type: "local",
        command: [server.command as string, ...(server.args ?? [])],
        ...(server.env ? { environment: server.env } : {}),
      }])
  );
  await writeFile(
    path.join(opts.cwd, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers } }, null, 2)}\n`,
    "utf8"
  );
}

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return property in error ? error[property as keyof typeof error] : undefined;
}

function inferredRole(saveTo: string): string {
  return path.basename(saveTo).split("-")[0]?.replace(/\.json$/, "") || "agent";
}

function antigravityPrintTimeout(opts: AgentRunOptions): string {
  const role = typeof opts.trajectoryMetadata?.role === "string"
    ? opts.trajectoryMetadata.role
    : inferredRole(opts.saveTo);
  // Browser-only levels have an independent evaluator fallback, so a stalled
  // session must not hold the whole pipeline for the patch-generation limit.
  const roleTimeout = role === "baseline"
    ? process.env.WEBMCPIFY_ANTIGRAVITY_BASELINE_TIMEOUT
    : role === "test"
      ? process.env.WEBMCPIFY_ANTIGRAVITY_TEST_TIMEOUT
      : undefined;
  return roleTimeout
    ?? process.env.WEBMCPIFY_ANTIGRAVITY_TIMEOUT
    ?? ((role === "baseline" || role === "test") ? "5m" : "15m");
}

function parseTimeoutMs(value: string, fallbackMs: number): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.max(1_000, Math.round(amount * multiplier));
}

function codexTimeoutMs(opts: AgentRunOptions): number {
  const role = typeof opts.trajectoryMetadata?.role === "string"
    ? opts.trajectoryMetadata.role
    : inferredRole(opts.saveTo);
  const fallback = role === "baseline" || role === "test" ? 5 * 60_000 : 15 * 60_000;
  return parseTimeoutMs(process.env.WEBMCPIFY_CODEX_TIMEOUT ?? "", fallback);
}

function startAgentProgress(opts: AgentRunOptions, startedMs: number): () => void {
  const role = typeof opts.trajectoryMetadata?.role === "string"
    ? opts.trajectoryMetadata.role
    : inferredRole(opts.saveTo);
  const elapsed = (): string => `${Math.round((Date.now() - startedMs) / 1000)}s`;
  console.error(`[${opts.provider}] ${role} agent started...`);
  const interactive = Boolean(process.stderr.isTTY);
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const render = (): void => {
    if (!interactive) return;
    process.stderr.write(`\r\x1b[2K[${opts.provider}] ${role} agent working ${elapsed()} ${spinner[frame++ % spinner.length]}`);
  };
  render();
  const timer = setInterval(render, 250);
  return () => {
    clearInterval(timer);
    if (interactive) process.stderr.write("\r\x1b[2K");
    console.error(`[${opts.provider}] ${role} agent finished (${elapsed()} elapsed).`);
  };
}

function trajectoryMetadata(
  opts: AgentRunOptions,
  status: TrajectoryMetadata["status"],
  startedAt: string,
  startedMs: number,
  finishedAt: string
): TrajectoryMetadata {
  const extra = opts.trajectoryMetadata ?? {};
  return {
    ...extra,
    role:
      typeof extra.role === "string" ? extra.role : inferredRole(opts.saveTo),
    status,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    provider: opts.provider,
    cwd: opts.cwd,
    prompt: opts.prompt,
    allowedTools: opts.allowedTools,
    mcpConfig: opts.mcpConfig,
  };
}

async function recordAgentMetadata(
  opts: AgentRunOptions,
  status: TrajectoryMetadata["status"],
  startedAt: string,
  startedMs: number,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!(await resolveRecordArtifacts())) return;
  try {
    await recordTrajectoryMetadata(
      opts.saveTo,
      trajectoryMetadata(
        { ...opts, trajectoryMetadata: { ...opts.trajectoryMetadata, ...extra } },
        status,
        startedAt,
        startedMs,
        new Date().toISOString()
      )
    );
  } catch (metadataError) {
    console.error(
      `[trajectory] could not record metadata: ${
        metadataError instanceof Error ? metadataError.message : String(metadataError)
      }`
    );
  }
}

async function preserveFailedOutput(
  opts: AgentRunOptions,
  error: unknown
): Promise<void> {
  if (existsSync(opts.saveTo)) return;

  const stdout = errorProperty(error, "stdout");
  const output =
    typeof stdout === "string"
      ? stdout
      : JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2
        ) + "\n";

  try {
    await mkdir(path.dirname(opts.saveTo), { recursive: true });
    await writeFile(opts.saveTo, output, "utf8");
  } catch (writeError) {
    console.error(
      `[trajectory] could not preserve failed output: ${
        writeError instanceof Error ? writeError.message : String(writeError)
      }`
    );
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<unknown> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const stopProgress = startAgentProgress(opts, startedMs);

  try {
    if (opts.provider === "claude") {
      const result = await runClaude({
        prompt: opts.prompt,
        cwd: opts.cwd,
        allowedTools: opts.allowedTools,
        mcpConfig: opts.mcpConfig,
        saveTo: opts.saveTo,
      });
      await recordAgentMetadata(opts, "completed", startedAt, startedMs);
      return result;
    }

    if (opts.provider === "antigravity") {
      await prepareAntigravityMcpConfig(opts);
    }
    if (opts.provider === "opencode") {
      await prepareOpenCodeMcpConfig(opts);
    }

    const invocation = getInvocation(opts);
    if (opts.provider === "codex") {
      const mcpArgs = await codexMcpArgs(opts.mcpConfig);
      invocation.args.splice(1, 0, ...mcpArgs);
    }
    let stdout: string;
    // Keep the provider in its own process group. If the user interrupts the
    // WebMCPify command, AGY (and any child shell it started) must stop before
    // the parent exits; otherwise an old direct-target run can keep editing.
    const subprocess = execa(invocation.command, invocation.args, {
      cwd: opts.cwd,
      detached: true,
      // Prompts are passed as command arguments. Leaving stdin open makes
      // Codex assume that more prompt text is coming and wait indefinitely
      // with "Reading additional input from stdin...".
      stdin: "ignore",
      timeout: opts.provider === "codex" ? codexTimeoutMs(opts) : undefined,
    });
    const terminateProvider = (signal: NodeJS.Signals): void => {
      if (subprocess.pid) {
        try {
          process.kill(-subprocess.pid, signal);
        } catch {
          // The process may already have exited.
        }
      }
      subprocess.kill(signal);
    };
    const onInterrupt = (): void => {
      console.error(`[${opts.provider}] interrupted; terminating provider process...`);
      terminateProvider("SIGTERM");
    };
    const onTerminate = (): void => terminateProvider("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);

    let pendingJsonLine = "";
    subprocess.stdout?.on("data", (chunk: Buffer | string) => {
      if (invocation.output !== "json-lines") return;

      pendingJsonLine += chunk.toString();
      const lines = pendingJsonLine.split(/\r?\n/);
      pendingJsonLine = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {
            type?: string;
            item?: { type?: string };
          };
          // Codex emits one JSONL event for every internal item. Keep the
          // trajectory complete, but show only lifecycle events in the CLI;
          // the shared spinner already communicates that work is ongoing.
          if (event.type === "turn.started") {
            console.log("[codex] turn started");
          } else if (event.type === "turn.completed") {
            console.log("[codex] turn completed");
          } else if (event.type === "error" || event.item?.type === "error") {
            console.error("[codex] agent reported an error");
          }
        } catch {
          // Keep the raw output for the trajectory; progress logging is best effort.
        }
      }
    });

    subprocess.stderr?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      // Codex prints this informational notice even when stdin is explicitly
      // ignored. It is not an error and only makes the normal CLI look stuck.
      if (message && message !== "Reading additional input from stdin...") {
        console.error(`[${opts.provider}] ${message}`);
      }
    });

    try {
      ({ stdout } = await subprocess);
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    }

    await mkdir(path.dirname(opts.saveTo), { recursive: true });
    await writeFile(opts.saveTo, stdout, "utf8");

    const result = parseOutput(stdout, invocation.output);
    await recordAgentMetadata(opts, "completed", startedAt, startedMs);
    return result;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      const missingCliError = new Error(
        `Could not find the ${opts.provider} CLI. Install it or set WEBMCPIFY_${opts.provider.toUpperCase()}_BIN to its executable path.`
      );
      await preserveFailedOutput(opts, missingCliError);
      await recordAgentMetadata(opts, "failed", startedAt, startedMs, {
        error: missingCliError.message,
      });
      throw missingCliError;
    }

    await preserveFailedOutput(opts, error);
    await recordAgentMetadata(opts, "failed", startedAt, startedMs, {
      error: error instanceof Error ? error.message : String(error),
      stderr: errorProperty(error, "stderr"),
    });
    throw error;
  } finally {
    stopProgress();
  }
}
