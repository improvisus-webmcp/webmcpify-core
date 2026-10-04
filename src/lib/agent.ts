import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runClaude } from "./claude.js";
import type { AIProvider } from "./ai-provider.js";
import {
  findCodexExecutable,
  resolveExecutable,
  assertProviderCwd,
  classifyProviderLaunchError,
  ProviderLaunchError,
  providerLaunchDiagnostics,
} from "./executables.js";
import {
  recordTrajectoryMetadata,
  type TrajectoryMetadata,
} from "./trajectories.js";
import { resolveRecordArtifacts } from "./config.js";
import { currentOperationSignal, currentOperationDeadline } from "./operation-context.js";
import { logProviderMcpToolEvent } from "./mcp-tool-log.js";

export interface AgentRunOptions {
  provider: AIProvider;
  prompt: string;
  cwd: string;
  allowedTools?: string;
  mcpConfig?: string;
  saveTo: string;
  /** Core-owned final-response schema; used only by Codex generation. */
  outputSchema?: string;
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
          ...(opts.outputSchema ? ["--output-schema", opts.outputSchema] : []),
          opts.prompt,
        ],
        output: "json-lines",
      };
    case "antigravity": {
      const command = resolveExecutable("agy", "WEBMCPIFY_ANTIGRAVITY_BIN");
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
        args: ["run", "--auto", "--format", "json", opts.prompt],
        output: "json-lines",
      };
  }
}

function parseOutput(stdout: string, output: ProviderInvocation["output"]): unknown {
  if (output === "text") return stdout;
  if (output === "json") {
    try { return JSON.parse(stdout); } catch { return stdout; }
  }

  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  return events.length ? events : stdout;
}

function assertProviderCompletion(provider: AIProvider, result: unknown, stdout?: string): void {
  let failed = false;
  if (provider === "codex" && Array.isArray(result)) {
    // Retrying/warning/tool events are not a terminal failure. Honor the last
    // completed/failed turn, so recovered executions keep working.
    const terminal = [...result].reverse().find(event => event?.type === "turn.failed" || event?.type === "turn.completed");
    failed = terminal?.type === "turn.failed";
  } else if (provider === "claude" && result && typeof result === "object") {
    const envelope = result as { type?: unknown; is_error?: unknown; subtype?: unknown };
    failed = envelope.type === "result" && (envelope.is_error === true || (typeof envelope.subtype === "string" && envelope.subtype.startsWith("error_")));
  }
  if (failed) {
    // Preserve the private transcript even with exit code zero; never attach
    // provider response text as a public Error.message or cause.
    const error = new Error("The provider reported a terminal failure despite a zero process exit.") as Error & { stdout?: string };
    if (stdout) error.stdout = stdout;
    throw error;
  }
}

async function codexMcpArgs(mcpConfig?: string): Promise<string[]> {
  if (!mcpConfig || !existsSync(mcpConfig)) return [];

  let config: {
    mcpServers?: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean; required?: boolean; startup_timeout_sec?: number; enabled_tools?: string[]; disabled_tools?: string[] }
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
    // Codex splits override keys on dots; quotes become literal key characters.
    const key = `mcp_servers.${name}`;
    args.push("-c", `${key}.command=${JSON.stringify(server.command)}`);
    if (server.args) {
      args.push("-c", `${key}.args=${JSON.stringify(server.args)}`);
    }
    for (const field of ["enabled", "required", "startup_timeout_sec", "enabled_tools", "disabled_tools"] as const) {
      if (server[field] !== undefined) args.push("-c", `${key}.${field}=${JSON.stringify(server[field])}`);
    }
    for (const [name, value] of Object.entries(server.env ?? {})) {
      args.push("-c", `${key}.env.${name}=${JSON.stringify(value)}`);
    }
  }
  if (Object.values(config.mcpServers ?? {}).some(server => server.required)) {
    args.push("-c", "mcp_optional_startup_grace_ms=0");
  }
  return args;
}

async function prepareAntigravityMcpConfig(opts: AgentRunOptions): Promise<void> {
  if (!opts.mcpConfig || !existsSync(opts.mcpConfig)) return;

  const workspaceConfig = path.join(opts.cwd, ".agents", "mcp_config.json");
  await mkdir(path.dirname(workspaceConfig), { recursive: true });
  await writeFile(workspaceConfig, await readFile(opts.mcpConfig, "utf8"), "utf8");
}

async function prepareOpenCodeMcpConfig(opts: AgentRunOptions): Promise<Record<string, string>> {
  if (!opts.mcpConfig || !existsSync(opts.mcpConfig)) return {};

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
  const inherited = process.env.OPENCODE_CONFIG_CONTENT
    ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) as { mcp?: Record<string, unknown> }
    : {};
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inherited, mcp: { ...inherited.mcp, ...servers } }) };
}

async function prepareGeminiMcpConfig(opts: AgentRunOptions): Promise<void> {
  if (!opts.mcpConfig) return;
  const config = JSON.parse(await readFile(opts.mcpConfig, "utf8")) as { mcpServers?: Record<string, unknown> };
  const filename = path.join(opts.cwd, ".gemini", "settings.json");
  const existing = existsSync(filename)
    ? JSON.parse(await readFile(filename, "utf8")) as { mcpServers?: Record<string, unknown> }
    : {};
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers, ...config.mcpServers } }, null, 2)}\n`, "utf8");
}

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return property in error ? error[property as keyof typeof error] : undefined;
}

function providerFailureHint(opts: AgentRunOptions, error: unknown): string {
  // Do not classify the subprocess Error.message: it contains argv, including
  // the private prompt. Only examine provider error events, never echo them.
  if (opts.provider !== "codex") return "";
  const stdout = errorProperty(error, "stdout");
  if (typeof stdout !== "string") return "";
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown; error?: { message?: unknown } };
      const message = event?.type === "error" ? event.message
        : event?.type === "turn.failed" ? event.error?.message ?? event.message : undefined;
      if (typeof message === "string") messages.push(message);
    } catch { /* Raw output and non-error events are not public diagnostics. */ }
  }
  const diagnostic = messages.join("\n");
  if (/model[^\n]{0,300}(?:not supported|does not exist|not available)/i.test(diagnostic)) {
    return " Codex rejected the configured model. Choose a model available to this CLI and account in Codex settings; Core did not change your configuration.";
  }
  if (/usage limit|quota exceeded|rate limit|too many requests|at capacity/i.test(diagnostic)) {
    return " Codex reported a usage or capacity limit. Retry after the limit resets or choose another configured provider.";
  }
  if (/unauthorized|authentication failed|not authenticated|sign in|log in|invalid api key/i.test(diagnostic)) {
    return " Codex authentication failed. Sign in to the CLI, then retry.";
  }
  if (/stream disconnected|connection (?:reset|refused)|network error|ENOTFOUND|ECONNRESET|ECONNREFUSED/i.test(diagnostic)) {
    return " Codex could not maintain its provider connection. Check connectivity and retry.";
  }
  return "";
}

/** Reuse only fixed Core guidance when wrapping a sanitized provider failure. */
export function publicProviderFailureGuidance(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const message = error.message;
  if (!/^(?:The (?:codex|claude|gemini|opencode|antigravity) [\w-]+ agent (?:failed|timed out)\.|Generated tool\/task metadata could not be safely corrected after one attempt\.|Generated capabilities could not be fully accounted for after one completion\.)/.test(message)) return "";
  const timeoutGuidance = "The coding provider exceeded its configured time limit. Retry or adjust its Core timeout setting.";
  if (/^The (?:codex|claude|gemini|opencode|antigravity) [\w-]+ agent timed out\./.test(message)) return ` ${timeoutGuidance}`;
  for (const guidance of [
    timeoutGuidance,
    "Codex rejected the configured model. Choose a model available to this CLI and account in Codex settings; Core did not change your configuration.",
    "Codex reported a usage or capacity limit. Retry after the limit resets or choose another configured provider.",
    "Codex authentication failed. Sign in to the CLI, then retry.",
    "Codex could not maintain its provider connection. Check connectivity and retry.",
  ]) {
    if (message.includes(guidance)) return ` ${guidance}`;
  }
  return "";
}

function sanitizedAgentFailure(opts: AgentRunOptions, error: unknown): Error {
  const role = typeof opts.trajectoryMetadata?.role === "string"
    ? opts.trajectoryMetadata.role
    : inferredRole(opts.saveTo);
  const timedOut = errorProperty(error, "timedOut") === true
    || errorProperty(error, "code") === "ETIMEDOUT";
  return new Error(
    `The ${opts.provider} ${role} agent ${timedOut ? "timed out" : "failed"}.${timedOut ? "" : providerFailureHint(opts, error)} Raw provider diagnostics were saved to ${opts.saveTo}; prompt and code output were withheld from the terminal.`,
  );
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
    ?? (currentOperationDeadline() === undefined ? ((role === "baseline" || role === "test") ? "5m" : "15m")
      : `${Math.ceil(providerTimeoutMs(opts) / 1000)}s`);
}

function parseTimeoutMs(value: string, fallbackMs: number): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.max(1_000, Math.round(amount * multiplier));
}

function providerTimeoutMs(opts: AgentRunOptions): number {
  const role = typeof opts.trajectoryMetadata?.role === "string"
    ? opts.trajectoryMetadata.role
    : inferredRole(opts.saveTo);
  const deadline = currentOperationDeadline();
  // A durable stage has an explicit owner-selected budget. Reserve time for
  // cleanup; ordinary CLI/provider timeout defaults remain unchanged.
  const fallback = deadline === undefined ? (role === "baseline" || role === "test" ? 5 * 60_000 : 15 * 60_000)
    : Math.max(1_000, deadline - Date.now() - 30_000);
  return parseTimeoutMs(process.env[`WEBMCPIFY_${opts.provider.toUpperCase()}_TIMEOUT`] ?? "", fallback);
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
  const stderr = errorProperty(error, "stderr");
  const output = JSON.stringify(
    {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      ...(typeof stdout === "string" && stdout ? { stdout } : {}),
      ...(typeof stderr === "string" && stderr ? { stderr } : {}),
    },
    null,
    2,
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
  const trace = (message: string): void => {
    if (process.env.WEBMCPIFY_TRACE === "1") console.log(message);
  };

  try {
    trace(`[trace ${opts.provider}] check provider working directory START`);
    assertProviderCwd(opts.provider, opts.cwd);
    trace(`[trace ${opts.provider}] check provider working directory DONE`);
    if (opts.provider === "claude") {
      trace("[trace claude] provider execution START (raw output withheld)");
      const result = await runClaude({
        prompt: opts.prompt,
        cwd: opts.cwd,
        allowedTools: opts.allowedTools,
        mcpConfig: opts.mcpConfig,
        saveTo: opts.saveTo,
        timeout: providerTimeoutMs(opts),
      });
      trace("[trace claude] provider execution DONE; completion check START");
      assertProviderCompletion(opts.provider, result);
      trace("[trace claude] completion check DONE");
      await recordAgentMetadata(opts, "completed", startedAt, startedMs);
      return result;
    }

    trace(`[trace ${opts.provider}] prepare provider configuration START`);
    if (opts.provider === "antigravity") {
      await prepareAntigravityMcpConfig(opts);
    }
    const providerEnv = opts.provider === "opencode" ? await prepareOpenCodeMcpConfig(opts) : {};
    if (opts.provider === "gemini") await prepareGeminiMcpConfig(opts);
    trace(`[trace ${opts.provider}] prepare provider configuration DONE; resolve invocation START`);

    const invocation = getInvocation(opts);
    if (opts.provider === "codex") {
      const mcpArgs = await codexMcpArgs(opts.mcpConfig);
      invocation.args.splice(1, 0, ...mcpArgs);
    }
    const timeoutMs = providerTimeoutMs(opts);
    trace(`[trace ${opts.provider}] invocation ready: output=${invocation.output}, timeout=${Math.round(timeoutMs / 1000)}s; arguments withheld`);
    let stdout: string;
    // Keep the provider in its own process group. If the user interrupts the
    // WebMCPify command, AGY (and any child shell it started) must stop before
    // the parent exits; otherwise an old direct-target run can keep editing.
    const subprocess = execa(invocation.command, invocation.args, {
      cwd: opts.cwd,
      detached: process.platform !== "win32",
      env: providerEnv,
      // Prompts are passed as command arguments. Leaving stdin open makes
      // Codex assume that more prompt text is coming and wait indefinitely
      // with "Reading additional input from stdin...".
      stdin: "ignore",
      timeout: timeoutMs,
      cancelSignal: currentOperationSignal(),
    });
    trace(`[trace ${opts.provider}] subprocess created; waiting for provider output (not proof of model connection)`);
    const terminateProvider = (signal: NodeJS.Signals): void => {
      if (subprocess.pid) {
        if (process.platform === "win32") {
          void execa("taskkill", ["/pid", String(subprocess.pid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
          return;
        }
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
    const signal = currentOperationSignal();
    signal?.addEventListener("abort", onTerminate, { once: true });

    let pendingJsonLine = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastOutputAt = Date.now();
    // Byte counts reveal transport activity without exposing prompts or source.
    subprocess.stderr?.on("data", (chunk: Buffer | string) => {
      if (!stderrBytes) trace(`[trace ${opts.provider}] first stderr bytes received (contents withheld)`);
      stderrBytes += Buffer.byteLength(chunk);
      lastOutputAt = Date.now();
    });
    subprocess.stdout?.on("data", (chunk: Buffer | string) => {
      if (!stdoutBytes) trace(`[trace ${opts.provider}] first stdout bytes received (contents withheld)`);
      stdoutBytes += Buffer.byteLength(chunk);
      lastOutputAt = Date.now();
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
          // Whitelist labels: never log arbitrary provider strings, item text,
          // command arguments, tool results, prompts, or generated code.
          const events = ["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"];
          const items = ["reasoning", "agent_message", "command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list", "collab_tool_call", "error"];
          if (event.type && events.includes(event.type)) {
            const itemType = event.item?.type && items.includes(event.item.type) ? event.item.type : "none/unknown";
            trace(`[trace ${opts.provider}] event=${event.type}, item=${itemType}, elapsed=${Math.round((Date.now() - startedMs) / 1000)}s`);
          }
          if (opts.trajectoryMetadata?.role === "test") logProviderMcpToolEvent(event, opts.trajectoryMetadata.taskId);
          if (event.type === "turn.started") {
            console.log("[codex] turn started");
          } else if (event.type === "turn.completed") {
            console.log("[codex] turn completed");
          } else if (event.type === "error" || event.item?.type === "error") {
            console.error("[codex] provider diagnostic received; waiting for turn outcome");
          }
        } catch {
          // Keep the raw output for the trajectory; progress logging is best effort.
        }
      }
    });

    // Provider stderr is intentionally buffered but never streamed. Some CLIs
    // echo their argv on failure, and the prompt may contain source code.
    // Raw diagnostics are preserved privately in the failed trajectory.
    const activityTimer = process.env.WEBMCPIFY_TRACE === "1" ? setInterval(() => {
      trace(`[trace ${opts.provider}] waiting for process completion: stdout=${stdoutBytes} bytes, stderr=${stderrBytes} bytes, last stream bytes=${Math.round((Date.now() - lastOutputAt) / 1000)}s ago; silence does not prove a stall`);
    }, 15_000) : undefined;

    try {
      ({ stdout } = await subprocess);
      trace(`[trace ${opts.provider}] subprocess completed successfully`);
    } catch (error) {
      trace(`[trace ${opts.provider}] subprocess stopped unsuccessfully; raw details withheld`);
      throw classifyProviderLaunchError(opts.provider, invocation.command, opts.cwd, error);
    } finally {
      clearInterval(activityTimer);
      // A timed-out parent may leave MCP servers and child shells alive.
      terminateProvider("SIGKILL");
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      signal?.removeEventListener("abort", onTerminate);
    }

    trace(`[trace ${opts.provider}] save output START`);
    await mkdir(path.dirname(opts.saveTo), { recursive: true });
    await writeFile(opts.saveTo, stdout, "utf8");
    trace(`[trace ${opts.provider}] save output DONE; parse and completion check START`);

    const result = parseOutput(stdout, invocation.output);
    assertProviderCompletion(opts.provider, result, stdout);
    trace(`[trace ${opts.provider}] parse and completion check DONE`);
    await recordAgentMetadata(opts, "completed", startedAt, startedMs);
    return result;
  } catch (error) {
    if (error instanceof ProviderLaunchError) {
      await preserveFailedOutput(opts, providerLaunchDiagnostics(error));
      await recordAgentMetadata(opts, "failed", startedAt, startedMs, {
        error: error.message,
      });
      throw error;
    }

    await preserveFailedOutput(opts, error);
    const publicError = sanitizedAgentFailure(opts, error);
    await recordAgentMetadata(opts, "failed", startedAt, startedMs, {
      error: error instanceof Error ? error.message : String(error),
      stderr: errorProperty(error, "stderr"),
      publicError: publicError.message,
    });
    throw publicError;
  } finally {
    stopProgress();
  }
}
