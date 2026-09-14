import path from "node:path";
import type { AgentOptions } from "./workflow.js";

export interface CliOptions extends AgentOptions {
  once: boolean;
  help: boolean;
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args: string[], cwd = process.cwd()): CliOptions {
  const result: CliOptions = {
    repositoryPath: cwd,
    url: "http://localhost:3000",
    once: false,
    help: false,
  };
  const request: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--path") result.repositoryPath = path.resolve(cwd, valueAfter(args, index++, arg));
    else if (arg === "--url") result.url = valueAfter(args, index++, arg);
    else if (arg === "--provider") result.provider = valueAfter(args, index++, arg);
    else if (arg === "--once") result.once = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}.`);
    else request.push(arg);
  }
  if (request.length) result.request = request.join(" ");
  let parsedUrl: URL;
  try { parsedUrl = new URL(result.url); }
  catch { throw new Error(`Invalid --url value: ${result.url}`); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error("--url must use http or https.");
  return result;
}
