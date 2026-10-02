import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CHROME_DEVTOOLS_SERVER = {
  command: "npx",
  args: [
    "-y",
    "chrome-devtools-mcp@1.7.0",
    "--category-experimental-webmcp",
    "--no-usage-statistics",
  ],
  directTools: [
    "navigate_page",
    "list_webmcp_tools",
    "execute_webmcp_tool",
  ],
  approveTools: ["execute_webmcp_tool"],
  enabled: true,
  required: true,
  startup_timeout_sec: 90,
};

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Return a site config that includes Chrome DevTools MCP. An existing config
 * is reused when complete or merged into a generated project-local file. The
 * user's .mcp.json is never replaced.
 */
export async function writeChromeDevtoolsMcpConfig(
  sitePath: string
): Promise<string> {
  const existingConfig = path.join(sitePath, ".mcp.json");
  let existing: McpConfig = {};
  if (existsSync(existingConfig)) {
    try {
      existing = JSON.parse(await readFile(existingConfig, "utf8")) as McpConfig;
    } catch (error) {
      throw new Error(
        `Could not read ${existingConfig}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const configDirectory = path.join(sitePath, ".webmcpify");
  const server = existing.mcpServers?.["chrome-devtools"] as Record<string, unknown> | undefined;
  const args = Array.isArray(server?.args) ? server.args.filter((value): value is string => typeof value === "string") : CHROME_DEVTOOLS_SERVER.args;
  const connectionArgs = ["--browserUrl", "--browser-url", "--wsEndpoint", "--ws-endpoint"];
  const retainedArgs = args.filter((arg, index) => !connectionArgs.includes(args[index - 1])
    && !connectionArgs.includes(arg)
    && !connectionArgs.some((flag) => arg.startsWith(`${flag}=`))
    && !/^--auto-?connect(?:=|$)/i.test(arg));
  const generatedConfig = path.join(
    configDirectory,
    "chrome-devtools-mcp.json"
  );
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    generatedConfig,
    JSON.stringify(
      {
        ...existing,
        mcpServers: {
          ...(existing.mcpServers ?? {}),
          "chrome-devtools": {
            ...CHROME_DEVTOOLS_SERVER,
            ...server,
            enabled: true,
            required: true,
            startup_timeout_sec: Math.max(90, typeof server?.startup_timeout_sec === "number" ? server.startup_timeout_sec : 0),
            args: [...retainedArgs, "--browserUrl", process.env.WEBMCPIFY_CDP_URL ?? "http://127.0.0.1:9222"],
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8"
  );
  return generatedConfig;
}
