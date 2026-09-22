#!/usr/bin/env node
import "../lib/load-env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { runGenerate } from "../commands/generate.js";
import { runApply } from "../commands/apply.js";
import { runTest } from "../commands/test.js";
import { patchMetadataPath, readPatchMetadata } from "../lib/patches.js";
import { discoveryPath } from "../lib/discovery.js";
import { proposedToolsPath } from "../lib/tool-proposals.js";
import { withManagedChrome } from "../lib/browser.js";
import { packageMetadata } from "../lib/package-info.js";
import { closeScoringBrowser } from "../lib/scoring.js";
import { runSecurity } from "../commands/security.js";
import { securityReportPath } from "../lib/security-audit.js";

const PROTOCOL_VERSION = "2025-03-26";
const serverRoot = path.resolve(process.cwd());

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function response(id: JsonRpcRequest["id"], result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function errorResponse(id: JsonRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function stringArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value;
  if (!required && value === undefined) return undefined;
  throw new Error(`Tool argument "${name}" must be a non-empty string.`);
}

async function safeRepositoryPath(input: string): Promise<string> {
  const candidate = path.resolve(input);
  if (!existsSync(candidate)) throw new Error(`Repository path does not exist: ${candidate}`);
  const resolved = await realpath(candidate);
  const relative = path.relative(serverRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Repository path must be inside the MCP server workspace (${serverRoot}): ${resolved}`);
  }
  return resolved;
}

async function capture<T>(operation: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...values: unknown[]) => logs.push(values.map((value) => String(value)).join(" "));
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    return { value: await operation(), logs };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

const tools = [
  {
    name: "analyze_repository",
    description: "Analyze a local web application using WebMCPify discovery.",
    inputSchema: { type: "object", properties: { repositoryPath: { type: "string", description: "Repository path, relative to the server workspace or absolute within it." } }, required: ["repositoryPath"], additionalProperties: false },
  },
  {
    name: "generate_webmcp",
    description: "Draft WebMCP registrations through WebMCPify's existing generation pipeline. Changes remain pending review.",
    inputSchema: { type: "object", properties: { repositoryPath: { type: "string" }, analysis: { type: "object", description: "Optional prior analyze_repository result." }, provider: { type: "string" }, method: { type: "string", enum: ["auto", "declarative", "imperative"] } }, required: ["repositoryPath"], additionalProperties: false },
  },
  {
    name: "audit_webmcp_security",
    description: "Audit proposed or approved WebMCP tools for access-control, quota, origin, privacy, and replay-protection gaps.",
    inputSchema: { type: "object", properties: { repositoryPath: { type: "string" }, strict: { type: "boolean" } }, required: ["repositoryPath"], additionalProperties: false },
  },
  {
    name: "apply_webmcp",
    description: "Apply the explicitly approved pending WebMCP patch, including the existing build check.",
    inputSchema: { type: "object", properties: { repositoryPath: { type: "string" }, patchIdentifier: { type: "string", description: "The pending patch runId returned by generate_webmcp." } }, required: ["repositoryPath", "patchIdentifier"], additionalProperties: false },
  },
  {
    name: "test_webmcp",
    description: "Run WebMCPify's existing isolated browser test and evaluation pipeline against an already-running site.",
    inputSchema: { type: "object", properties: { repositoryPath: { type: "string" }, url: { type: "string", description: "Running application URL; required unless WEBMCPIFY_URL is set." }, provider: { type: "string" } }, required: ["repositoryPath"], additionalProperties: false },
  },
];

async function callTool(name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const repositoryPath = await safeRepositoryPath(stringArg(rawArgs, "repositoryPath")!);
  switch (name) {
    case "analyze_repository": {
      const captured = await capture(async () => {
        const { runDiscovery } = await import("../lib/discovery.js");
        return runDiscovery(repositoryPath);
      });
      return textResult({ ...captured.value, artifacts: { discoveryPath: discoveryPath(repositoryPath) }, logs: captured.logs });
    }
    case "generate_webmcp": {
      const analysis = rawArgs.analysis;
      const captured = await capture(() => runGenerate({ path: repositoryPath, provider: stringArg(rawArgs, "provider", false), method: stringArg(rawArgs, "method", false), context: analysis ? JSON.stringify(analysis) : undefined }));
      const metadata = await readPatchMetadata(repositoryPath);
      return textResult({ status: metadata.patchStatus, patchIdentifier: metadata.runId, changedFiles: metadata.changedFiles, artifacts: { patch: metadata.patchPath, metadata: patchMetadataPath(repositoryPath), discovery: discoveryPath(repositoryPath), proposedTools: proposedToolsPath(repositoryPath), securityReport: securityReportPath(repositoryPath), generationTrajectory: metadata.generationTrajectory }, logs: captured.logs });
    }
    case "audit_webmcp_security": {
      const captured = await capture(() => runSecurity({ path: repositoryPath, strict: rawArgs.strict === true }));
      return textResult({ ...captured.value, artifacts: { securityReport: securityReportPath(repositoryPath) }, logs: captured.logs });
    }
    case "apply_webmcp": {
      const identifier = stringArg(rawArgs, "patchIdentifier")!;
      const metadata = await readPatchMetadata(repositoryPath);
      if (metadata.runId !== identifier) throw new Error(`Patch identifier does not match the pending patch. Expected ${metadata.runId}.`);
      const captured = await capture(() => runApply({ path: repositoryPath }));
      const applied = await readPatchMetadata(repositoryPath);
      return textResult({ status: applied.patchStatus, patchIdentifier: applied.runId, changedFiles: applied.changedFiles, lastApply: applied.lastApply, logs: captured.logs });
    }
    case "test_webmcp": {
      const url = stringArg(rawArgs, "url", false) ?? process.env.WEBMCPIFY_URL;
      if (!url) throw new Error("A running site URL is required. Pass url or set WEBMCPIFY_URL.");
      const captured = await capture(() =>
        withManagedChrome(url, async () => {
          try {
            return await runTest({ path: repositoryPath, url, provider: stringArg(rawArgs, "provider", false) });
          } finally {
            await closeScoringBrowser();
          }
        }),
      );
      return textResult({ ...captured.value, logs: captured.logs });
    }
    default:
      throw new Error(`Unknown MCP tool "${name}".`);
  }
}

export async function handle(request: JsonRpcRequest): Promise<string | undefined> {
  if (!request.method) return errorResponse(request.id, -32600, "Invalid JSON-RPC request.");
  if (request.method === "notifications/initialized" || request.method.startsWith("notifications/")) return undefined;
  if (request.method === "initialize") {
    const metadata = packageMetadata();
    return response(request.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "webmcpify-core", version: metadata.version } });
  }
  if (request.method === "ping") return response(request.id, {});
  if (request.method === "tools/list") return response(request.id, { tools });
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (typeof name !== "string") return errorResponse(request.id, -32602, "tools/call requires a tool name.");
    try { return response(request.id, await callTool(name, (request.params?.arguments as Record<string, unknown> | undefined) ?? {})); }
    catch (error) { return response(request.id, textResult(error instanceof Error ? error.message : String(error), true)); }
  }
  return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
}

function startStdioServer(): void {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    const lines = input.split(/\r?\n/);
    input = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: JsonRpcRequest;
      try { request = JSON.parse(line) as JsonRpcRequest; }
      catch (error) {
        process.stdout.write(`${errorResponse(null, -32700, error instanceof Error ? error.message : String(error))}\n`);
        continue;
      }
      void handle(request).then((result) => { if (result) process.stdout.write(`${result}\n`); }).catch((error) => process.stdout.write(`${errorResponse(request.id, -32603, error instanceof Error ? error.message : String(error))}\n`));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) startStdioServer();
