import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Page } from "playwright-core";
import { connectStdioMcp, type McpToolResult, type StdioMcpClient, type StdioMcpServer } from "./mcp-stdio-client.js";
import { createTrajectoryArtifact } from "./trajectories.js";
import type { WebMcpEvidence } from "./webmcp-evidence.js";
import { observeWebMcpExecution } from "./webmcp-observer.js";

export const WEBMCP_AGENT_TOOLS = "mcp__chrome-devtools__list_webmcp_tools,mcp__chrome-devtools__call_webmcp_tool";

function text(result: McpToolResult): string {
  return (result.content ?? []).filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
}

function listedPages(result: McpToolResult): Array<{ id: number; url: string }> {
  const structured = result.structuredContent?.pages;
  // The pinned server can return only text, including a title before the URL.
  // Prefer an actual structured array (even when empty); never trust a URL in
  // the title instead of the final parenthesized URL emitted by upstream.
  const entries: unknown[] = Array.isArray(structured) ? structured
    : [...text(result).matchAll(/^\s*(\d+):\s+(.+)$/gm)].map(match => {
      const label = match[2]!.trim();
      const titled = label.match(/ \(([a-z][\w+.-]*:[^\s]*)\)(?:\s+\[selected\])?(?:\s+isolatedContext=.*)?$/i);
      const bare = label.match(/^([a-z][\w+.-]*:[^\s]+)(?:\s+\[selected\])?(?:\s+isolatedContext=.*)?$/i);
      return { id: Number(match[1]), url: titled?.[1] ?? bare?.[1] };
    });
  const pages: Array<{ id: number; url: string }> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { id, url } = entry as { id?: unknown; url?: unknown };
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 || typeof url !== "string") continue;
    try { pages.push({ id, url: new URL(url).href }); }
    catch { /* A malformed inventory entry cannot identify a task tab. */ }
  }
  return pages;
}

export function webMcpExecutionResult(result: McpToolResult, observedError?: string): { status: "success" | "error"; error?: string } | undefined {
  if (result.isError) return undefined; // Protocol/connection/missing-tool errors are not business rejections.
  let value: unknown = result.structuredContent;
  if (!(value && typeof value === "object" && "status" in value)) {
    const json = text(result).match(/\{[\s\S]*\}/)?.[0];
    if (!json) return undefined;
    try { value = JSON.parse(json); } catch { return undefined; }
  }
  const outcome = value as { status?: unknown; errorText?: unknown; output?: unknown };
  if (outcome.status === "Completed" || outcome.status === "success") {
    // A protocol-completed invocation may still return a structured business
    // rejection. Do not count an explicit isError/failed result as success.
    let output = outcome.output;
    if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* Plain successful output. */ } }
    if (output && typeof output === "object") {
      const business = output as { isError?: unknown; status?: unknown; success?: unknown; ok?: unknown; error?: unknown; message?: unknown; content?: McpToolResult["content"] };
      if (business.isError === true || business.status === "error" || business.success === false || business.ok === false) {
        const message = typeof business.error === "string" ? business.error
          : business.error && typeof business.error === "object" && "message" in business.error && typeof business.error.message === "string" ? business.error.message
          : typeof business.message === "string" ? business.message
          : Array.isArray(business.content) ? text({ content: business.content }) : "";
        return message.trim() ? { status: "error", error: message } : undefined;
      }
    }
    return { status: "success" };
  }
  const errorText = typeof outcome.errorText === "string" && outcome.errorText.trim() ? outcome.errorText : observedError;
  if ((outcome.status === "Error" || outcome.status === "error") && errorText?.trim()) {
    return { status: "error", error: errorText };
  }
  return undefined;
}

export interface ChromeWebMcpConnection {
  bindTask(options: { url: string; marker: string; toolNames: string[]; workspace: string; page?: Page }): Promise<WebMcpTaskBridge>;
  close(): Promise<void>;
}

export interface WebMcpTaskBridge {
  configPath: string;
  evidence: WebMcpEvidence;
  diagnostics: unknown[];
  instruction: string;
  close(): Promise<void>;
}

/** Core, not the coding provider, owns the real browser-MCP connection. */
export async function connectChromeWebMcp(configPath: string, sitePath: string): Promise<ChromeWebMcpConnection> {
  let client: StdioMcpClient | undefined;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: Record<string, StdioMcpServer> };
    const server = config.mcpServers?.["chrome-devtools"];
    if (!server?.command) throw new Error("Chrome DevTools MCP command is missing.");
    client = await connectStdioMcp({ ...server, cwd: server.cwd ? path.resolve(sitePath, server.cwd) : sitePath });
    const catalog = await client.request("tools/list") as { tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    const names = new Set(catalog.tools?.map(tool => tool.name));
    const executionMethod = names.has("execute_webmcp_tool") ? "execute_webmcp_tool" : "call_webmcp_tool";
    if (!["list_pages", "select_page", "evaluate_script", "list_webmcp_tools", executionMethod].every(name => names.has(name))) {
      throw new Error("Chrome DevTools MCP must expose page binding plus list_webmcp_tools and execute_webmcp_tool/call_webmcp_tool. Enable the experimental WebMCP category; do not use --slim.");
    }
    const connection = client;
    // pageId is exposed only with upstream's experimental page-routing option.
    // Do not send unsupported arguments on its default schema.
    const routedMethods = new Set(catalog.tools?.filter(tool => tool.inputSchema?.properties?.pageId).map(tool => tool.name));
    return {
      bindTask: async options => {
        try { return await bindWebMcpTask(connection, executionMethod, routedMethods, options); }
        catch (error) {
          const artifact = await createTrajectoryArtifact("browser-mcp-failure", {
            reason: error instanceof Error ? error.message : "Task binding failed",
            response: error instanceof Error ? error.cause : undefined, stderr: connection.diagnostics(),
          }, { sitePath, role: "browser-mcp", status: "failed" });
          throw new Error(`Chrome DevTools MCP could not bind/discover the exact isolated task tab. No capability was called. Private diagnostics: ${artifact}`);
        }
      },
      close: () => connection.close(),
    };
  } catch (error) {
    const diagnostics = (error as { diagnostics?: string })?.diagnostics ?? client?.diagnostics();
    await client?.close();
    const artifact = await createTrajectoryArtifact("browser-mcp-failure", {
      reason: error instanceof Error ? error.message : "Connection failed", diagnostics,
    }, { sitePath, role: "browser-mcp", status: "failed" });
    throw new Error(`Chrome DevTools MCP could not initialize with its WebMCP methods. No capability tests were run. Check the configured command, experimental WebMCP support, registry access/cache, and browser connection. Private diagnostics: ${artifact}`);
  }
}

async function bindWebMcpTask(
  client: StdioMcpClient,
  executionMethod: string,
  routedMethods: Set<string | undefined>,
  options: { url: string; marker: string; toolNames: string[]; workspace: string; page?: Page },
): Promise<WebMcpTaskBridge> {
  const inventory = await client.call("list_pages");
  if (inventory.isError) throw new Error("Chrome DevTools MCP cannot list the existing task tab.", { cause: inventory });
  const candidates = listedPages(inventory);
  const targetOrigin = new URL(options.url).origin;
  const bindingAttempts: Array<{ pageId: number; stage: string; response: McpToolResult }> = [];
  let pageId: number | undefined;
  for (const candidate of candidates) {
    if (new URL(candidate.url).origin !== targetOrigin) continue;
    const selected = await client.call("select_page", { pageId: candidate.id });
    if (selected.isError) { bindingAttempts.push({ pageId: candidate.id, stage: "select", response: selected }); continue; }
    const identity = await client.call("evaluate_script", {
      function: "() => window.name", ...(routedMethods.has("evaluate_script") ? { pageId: candidate.id } : {}),
    });
    if (!identity.isError && text(identity).includes(JSON.stringify(options.marker))) { pageId = candidate.id; break; }
    bindingAttempts.push({ pageId: candidate.id, stage: "identity", response: identity });
  }
  if (pageId === undefined) throw new Error("Chrome DevTools MCP cannot bind the exact isolated task tab. No tools were called; another browser or tab must not be substituted.", {
    cause: { pages: candidates, attempts: bindingAttempts },
  });
  const selectedPageId = pageId;
  const fallbackPageId = candidates.find(candidate => Number.isInteger(candidate.id) && candidate.id !== selectedPageId)?.id;
  const probe = await client.call("list_webmcp_tools", routedMethods.has("list_webmcp_tools") ? { pageId } : {});
  if (probe.isError) throw new Error("Chrome DevTools MCP cannot discover WebMCP tools on the isolated task tab. Check browser WebMCP support.", { cause: probe });
  const evidence: WebMcpEvidence = { source: "chrome-devtools-mcp", pageId, discovered: false, calls: [], policyViolations: [] };
  const diagnostics: unknown[] = [];
  const allowed = new Set(options.toolNames);
  const token = randomBytes(32).toString("hex");
  let closed = false;
  let queue = Promise.resolve();
  const resultText = (message: string, isError = false) => ({ content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) });
  const toolSchemas = [
    { name: "list_webmcp_tools", description: "Discover live WebMCP tools on Core's already-bound task tab. Call this before executing a capability. The tab is selected by Core; never open or select another browser.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "call_webmcp_tool", description: "Execute a task-approved capability through Chrome DevTools MCP's real WebMCP execution method on Core's bound task tab. This is an alias for execute_webmcp_tool, not JavaScript or UI automation.", inputSchema: { type: "object", properties: { toolName: { type: "string", enum: [...allowed] }, input: { type: "string", description: "JSON-stringified object parameters; omit for an empty object." } }, required: ["toolName"], additionalProperties: false } },
  ];
  const handle = async (request: { id?: string | number | null; method?: string; params?: Record<string, unknown> }): Promise<unknown> => {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id ?? null, result });
    if (request.method?.startsWith("notifications/")) return undefined;
    if (request.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "chrome-devtools", version: "1" }, instructions: "Use only list_webmcp_tools and call_webmcp_tool. Core owns the exact task tab and independently records actual execution; final reports are not evidence." });
    if (request.method === "ping") return reply({});
    if (request.method === "tools/list") return reply({ tools: toolSchemas });
    if (request.method !== "tools/call") return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: "Unsupported task MCP method." } };
    const name = request.params?.name;
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const reject = (message: string) => { evidence.policyViolations.push(message); return reply(resultText(message, true)); };
    if (closed) return reply(resultText("The task bridge is closed.", true));
    if (name !== "list_webmcp_tools" && name !== "call_webmcp_tool") return reject("Only Chrome DevTools WebMCP discovery and execution methods are permitted.");
    if (!args || typeof args !== "object" || Array.isArray(args)) return reject("WebMCP method arguments must be an object.");
    if (Object.keys(args).some(key => !(name === "list_webmcp_tools" ? [] : ["toolName", "input"]).includes(key))) return reject("Do not supply page routing, scripts, or unsupported method arguments; Core binds the task tab.");
    if (name === "call_webmcp_tool") {
      if (!evidence.discovered) return reject("Call list_webmcp_tools before executing a capability.");
      if (typeof args.toolName !== "string" || !allowed.has(args.toolName)) return reject("This capability is not approved for this task.");
      if (args.input !== undefined) {
        if (typeof args.input !== "string") return reject("input must be a JSON-stringified object.");
        try { const input = JSON.parse(args.input); if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); }
        catch { return reject("input must contain a valid JSON object."); }
      }
    }
    try {
      const selected = await client.call("select_page", { pageId: selectedPageId });
      if (selected.isError) throw new Error("The exact task tab is no longer available.");
      const method = name === "call_webmcp_tool" ? executionMethod : name;
      const observer = name === "call_webmcp_tool" && options.page
        ? await observeWebMcpExecution(options.page, args.toolName as string, args.input as string | undefined)
        : undefined;
      let result: McpToolResult;
      let observedError: string | undefined;
      try {
        result = await client.call(method, { ...args, ...(routedMethods.has(method) ? { pageId: selectedPageId } : {}) });
        observedError = observer?.error();
        // The observer and MCP use separate CDP connections: their messages
        // can arrive in either order. Wait only for the matching invocation,
        // never borrow a report/console error or re-execute the capability.
        if (!webMcpExecutionResult(result, observedError) && observer) {
          observedError = await observer.waitForError();
          if (!webMcpExecutionResult(result, observedError)) diagnostics.push({ observer: observer.diagnostics() });
        }
      } finally { await observer?.close(); }
      if (name === "list_webmcp_tools") {
        if (result.isError) { diagnostics.push(result); throw new Error("WebMCP discovery is unavailable."); }
        evidence.discovered = true;
      } else {
        const execution = webMcpExecutionResult(result, observedError);
        if (!execution) { diagnostics.push(result); throw new Error("Chrome DevTools did not return a real WebMCP execution result; a missing tool, invalid schema or browser error is not an expected business rejection."); }
        evidence.calls.push({ toolName: args.toolName as string, ...execution });
        if (execution.status === "error" && observedError) {
          result = { ...result, content: [...(result.content ?? []), { type: "text", text: `Core observed the matching Chrome WebMCP invocation exception: ${observedError}` }] };
        }
      }
      return reply(result);
    } catch (error) {
      diagnostics.push({ reason: error instanceof Error ? error.message : "Chrome MCP call failed", stderr: client.diagnostics() });
      evidence.infrastructureError = "Chrome DevTools MCP could not complete WebMCP discovery/execution on the exact task tab.";
      return reply(resultText(evidence.infrastructureError + " Do not substitute clicks, evaluate_script, cua_repl, or another browser.", true));
    }
  };
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== "POST" || request.url !== "/mcp" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; if (body.length > 1_048_576) request.destroy(); });
    request.on("error", () => { response.destroy(); });
    request.on("end", () => {
      queue = queue.then(async () => {
        try {
          const result = await handle(JSON.parse(body));
          if (result === undefined) response.writeHead(204).end();
          else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result)); }
        } catch { response.writeHead(400).end(); }
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The task MCP endpoint did not start.");
    const bridgeOptionsPath = path.join(options.workspace, "webmcp-task-connection.json");
    await writeFile(bridgeOptionsPath, JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, token }), { mode: 0o600 });
    const configPath = path.join(options.workspace, "webmcp-task-mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { "chrome-devtools": {
      command: process.execPath,
      args: [fileURLToPath(new URL("../mcp/webmcp-bridge.js", import.meta.url)), bridgeOptionsPath],
      enabled: true, required: true, startup_timeout_sec: 90,
      enabled_tools: ["list_webmcp_tools", "call_webmcp_tool"],
      directTools: ["list_webmcp_tools", "call_webmcp_tool"],
      approveTools: ["call_webmcp_tool"],
    } } }), { mode: 0o600 });
    return {
      configPath, evidence, diagnostics,
      instruction: "Chrome DevTools MCP is already connected to Core's exact isolated task tab. Use ONLY mcp__chrome-devtools__list_webmcp_tools and mcp__chrome-devtools__call_webmcp_tool. First discover the live tools, then call task-approved capabilities with toolName and JSON-stringified input. Do not use list_pages/select_page/evaluate_script, direct document.modelContext calls, clicks, shell, cua_repl, or another browser. Core selects the page and verifies state independently. If these two MCP methods are unavailable, report the connection failure and stop; never substitute another interface.",
      close: async () => {
        if (closed) { await queue; return; }
        closed = true;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        // Finish any in-flight request before evidence is persisted or the
        // shared browser client moves to the next task.
        await queue;
        // Upstream 1.7 lists pages only after consulting its current selection.
        // Leave it on a surviving page before Core closes the isolated context;
        // otherwise the next task's list_pages fails on the stale closed tab.
        if (fallbackPageId !== undefined) {
          await client.call("select_page", { pageId: fallbackPageId }).catch(() => undefined);
        }
      },
    };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
