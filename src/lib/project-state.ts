import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preserve owner rules and line endings; a final rule overrides earlier negations. */
export function updateWebmcpifyGitignore(existing = ""): string {
  const rules = existing.split(/\r?\n/).filter(line => line.length > 0 && !line.startsWith("#"));
  if (["/.webmcpify/", ".webmcpify/", "/.webmcpify", ".webmcpify"].includes(rules.at(-1) ?? "")) return existing;
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator = existing && !existing.endsWith("\n") ? newline : "";
  return `${existing}${separator}# WebMCPify private local run state (not application source)${newline}/.webmcpify/${newline}`;
}

/** Initialize ignore policy before source identity is captured or state is written. */
export async function initializeProjectState(sitePath: string): Promise<void> {
  const ignorePath = path.join(sitePath, ".gitignore");
  let existing: string | undefined;
  try {
    if ((await lstat(ignorePath)).isSymbolicLink()) throw new Error("Refusing to edit a symlinked target .gitignore.");
    existing = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = updateWebmcpifyGitignore(existing);
  if (updated !== existing) await writeFile(ignorePath, updated, "utf8");
  await mkdir(path.join(sitePath, ".webmcpify"), { recursive: true });
}
