import { execa } from "execa";
import { createInterface } from "node:readline";
import { currentOperationSignal } from "./operation-context.js";

export interface StdioMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface StdioMcpClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  call(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  diagnostics(): string;
  close(): Promise<void>;
}

/** A bounded JSONL stdio client, matching the transport used by Core's MCP server. */
export async function connectStdioMcp(server: StdioMcpServer, timeoutMs = 90_000): Promise<StdioMcpClient> {
  const child = execa(server.command, server.args ?? [], {
    cwd: server.cwd,
    env: server.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    buffer: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0;
  let stopped = false;
  let exited = false;
  let stderr = "";
  const fail = () => {
    stopped = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome DevTools MCP connection closed before completing its request."));
    }
    pending.clear();
  };
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  child.stdin?.on("error", fail);
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line: string) => {
    if (line.length > 4_194_304) { fail(); return; }
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (typeof message.id !== "number") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error("Chrome DevTools MCP rejected a protocol request."));
      else entry.resolve(message.result);
    } catch { /* Ignore non-protocol startup output; it cannot be tool evidence. */ }
  });
  void child.then(() => { exited = true; fail(); }, () => { exited = true; fail(); });
  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (stopped) return Promise.reject(new Error("Chrome DevTools MCP is not connected."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Chrome DevTools MCP request timed out."));
        // A timed-out execution may still be running. Kill this owned MCP
        // connection instead of accepting subsequent calls on ambiguous state.
        void close();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
        if (error) fail();
      });
    });
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    fail();
    lines.close();
    signal?.removeEventListener("abort", onAbort);
    if (exited) return;
    if (process.platform === "win32" && child.pid) {
      await execa("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
    } else {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      child.kill("SIGKILL");
    }
    await child.catch(() => undefined);
  })();
  const onAbort = () => { void close(); };
  const signal = currentOperationSignal();
  signal?.addEventListener("abort", onAbort, { once: true });
  const client: StdioMcpClient = {
    request,
    call: async (name, args = {}) => {
      const result = await request("tools/call", { name, arguments: args });
      if (!result || typeof result !== "object") throw new Error("Chrome DevTools MCP returned an invalid tool result.");
      return result as McpToolResult;
    },
    diagnostics: () => stderr,
    close,
  };
  try {
    if (signal?.aborted) throw new Error("Chrome DevTools MCP startup was interrupted.");
    const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "webmcpify-core", version: "1" } });
    if (!initialized || typeof initialized !== "object" || !("capabilities" in initialized)) throw new Error("Chrome DevTools MCP did not initialize correctly.");
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return client;
  } catch (error) {
    await close();
    // The caller may save these diagnostics privately, never print them.
    const failure = new Error("Chrome DevTools MCP could not initialize.") as Error & { diagnostics?: string };
    failure.diagnostics = `${error instanceof Error ? error.message : "Startup failed"}\n${stderr}`;
    throw failure;
  }
}
