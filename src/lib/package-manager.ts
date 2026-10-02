import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveExecutable } from "./executables.js";

export async function resolvePackageManager(sitePath: string): Promise<string> {
  if (process.env.WEBMCPIFY_PACKAGE_MANAGER) return resolveExecutable("npm", "WEBMCPIFY_PACKAGE_MANAGER");
  for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"], ["bun.lock", "bun"], ["bun.lockb", "bun"]]) {
    if (existsSync(path.join(sitePath, file))) return resolveExecutable(manager, "WEBMCPIFY_PACKAGE_MANAGER");
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(sitePath, "package.json"), "utf8"));
    const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
    if (["npm", "pnpm", "yarn", "bun"].includes(declared)) return resolveExecutable(declared, "WEBMCPIFY_PACKAGE_MANAGER");
  } catch { /* No readable declaration: use the standard Node default. */ }
  return resolveExecutable("npm", "WEBMCPIFY_PACKAGE_MANAGER");
}
