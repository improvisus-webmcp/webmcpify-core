#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { Agent, McpClient } from "@strands-agents/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "./args.js";
import { buildInitialRequest, CORE_TOOL_NAMES, SYSTEM_PROMPT } from "./workflow.js";

const HELP = `WebMCPify Core Agent — Strands-powered WebMCP preparation

Usage:
  pnpm agent -- --path <web-app> --url <running-url> [--provider codex] [request]

Options:
  --path <path>       Target web application (default: current directory)
  --url <url>         Running application URL (default: http://localhost:3000)
  --provider <name>   Core coding provider; omit for auto-detection
  --once              Run one agent turn instead of the approval-aware interactive loop
  --help              Show this help`;

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "message" in result) {
    const message = (result as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(result);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }
  await access(options.repositoryPath);
  const agentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const coreServer = path.resolve(agentDirectory, "../../../dist/mcp/server.js");
  await access(coreServer);

  const core = new McpClient({
    transport: new StdioClientTransport({
      command: process.execPath,
      args: [coreServer],
      cwd: options.repositoryPath,
      stderr: "inherit",
    }),
    toolFilters: { allowed: [...CORE_TOOL_NAMES] },
    prefix: "core_",
  });
  const agent = new Agent({
    systemPrompt: SYSTEM_PROMPT,
    tools: [core],
  });

  let prompt = buildInitialRequest(options);
  const terminal = options.once ? undefined : createInterface({ input, output });
  try {
    while (true) {
      const result = await agent.invoke(prompt);
      console.log(`\n${resultText(result)}\n`);
      if (!terminal) break;
      const next = (await terminal.question("You › ")).trim();
      if (!next || ["exit", "quit"].includes(next.toLowerCase())) break;
      prompt = next;
    }
  } finally {
    terminal?.close();
    await core.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
