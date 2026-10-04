import { createHash, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createTrajectoryArtifact } from "./trajectories.js";
import type { SecurityPolicy } from "./security-audit.js";
import type { AIProvider } from "./ai-provider.js";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 30_000;

export type PatchStatus = "awaiting-review" | "approved" | "rejected" | "applied" | "failed" | "invalid";

export interface PatchMetadata {
  version: 1;
  runId: string;
  timestamp: string;
  targetProject: string;
  sourceVersion?: string;
  workingTreeHash?: string;
  changedFiles: string[];
  patchStatus: PatchStatus;
  patchPath: string;
  patchHash?: string;
  generationTrajectory: string;
  securityPolicy?: SecurityPolicy;
  provider?: AIProvider;
  /** A reduced-tool draft reuses its independently valid retained tests. */
  selectionRevision?: true;
  repair?: {
    sourceEvaluation: string;
    url: string;
    taskSetId?: string;
    failedTaskIds: string[];
  };
  error?: string;
  lastApply?: { timestamp: string; status: string; error?: string };
}

function patchPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "pending-diff.patch");
}

export function patchMetadataPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "pending-diff.meta.json");
}

export function patchArtifactPath(sitePath: string): string {
  return patchPath(sitePath);
}

export function sourcePatchHash(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

/** Resolve only Core's canonical, non-symlink pending patch. */
export async function readPendingPatch(sitePath: string, metadata: PatchMetadata): Promise<string> {
  const canonical = path.resolve(patchPath(sitePath));
  if (path.resolve(metadata.patchPath) !== canonical) throw new Error("Pending patch path does not match the target project.");
  for (const filename of [path.dirname(canonical), canonical]) {
    if ((await lstat(filename)).isSymbolicLink()) throw new Error("Pending patch paths must not be symbolic links.");
  }
  const patch = await readFile(canonical, "utf8");
  if (metadata.patchHash && metadata.patchHash !== sourcePatchHash(patch)) throw new Error("Pending patch changed after generation; regenerate and review it.");
  const files = extractUnifiedDiff(patch).changedFiles.sort();
  if (JSON.stringify(files) !== JSON.stringify([...metadata.changedFiles].sort())) throw new Error("Pending patch changed-file metadata does not match its source changes.");
  return patch;
}

function textFromProviderOutput(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    const values: string[] = [];
    const collect = (value: unknown, key?: string): void => {
      if (typeof value === "string") {
        if (!key || ["response", "result", "text", "output", "message", "content"].includes(key)) values.push(value);
        return;
      }
      if (Array.isArray(value)) { value.forEach((entry) => collect(entry)); return; }
      if (typeof value === "object" && value !== null) {
        for (const [childKey, childValue] of Object.entries(value)) collect(childValue, childKey);
      }
    };
    collect(parsed);
    if (values.length) return values.join("\n");
  } catch {
    // Provider output may be plain text.
  }
  return raw;
}

function fixHunkHeaders(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("@@ ")) {
      const headerMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (headerMatch) {
        const startOld = parseInt(headerMatch[1], 10);
        const startNew = parseInt(headerMatch[2], 10);
        const rest = headerMatch[3] || "";
        const hunkLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("diff --git ")) {
          let hLine = lines[i];
          if (hLine === "" && i + 1 < lines.length && !lines[i + 1].startsWith("diff --git ") && !lines[i + 1].startsWith("@@ ")) {
            hLine = " ";
          } else if (!hLine.startsWith("+") && !hLine.startsWith("-") && !hLine.startsWith(" ") && !hLine.startsWith("\\") && hLine !== "") {
            hLine = " " + hLine;
          }
          hunkLines.push(hLine);
          i++;
        }
        let oldCount = 0;
        let newCount = 0;
        for (const hl of hunkLines) {
          if (hl.startsWith("-")) oldCount++;
          else if (hl.startsWith("+")) newCount++;
          else if (hl.startsWith(" ")) {
            oldCount++;
            newCount++;
          }
        }
        out.push(`@@ -${startOld},${oldCount} +${startNew},${newCount} @@${rest}`);
        out.push(...hunkLines);
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

function normalizeUnifiedDiff(patch: string): string {
  const original = patch.trimStart();
  if (original.startsWith("diff --git ")) {
    // Preserve valid Git output byte-for-byte. Trimming or repairing it can
    // destroy trailing-space context and binary-patch terminators.
    // Avoid synchronous stdin pipe handling: a stalled parser blocks the
    // review server and its polling/cancellation timers as well. Give Git a
    // private file and a hard deadline, preserving valid bytes unchanged.
    const directory = mkdtempSync(path.join(tmpdir(), "webmcpify-patch-check-"));
    try {
      const filename = path.join(directory, "draft.patch");
      writeFileSync(filename, original, { mode: 0o600 });
      const checked = spawnSync("git", ["apply", "--numstat", "-z", filename], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: gitTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 50 * 1024 * 1024,
      });
      if ((checked.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error("Git patch inspection timed out; retry the review. No approval was created.");
      if (checked.status === 0) return original;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  let normalized = patch.trim();
  const chunks = normalized.split(/\n(?=diff --git )/);
  const resultChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.startsWith("diff --git ")) {
      resultChunks.push(chunk);
    } else {
      const withGitDiff = chunk.replace(/(?:^|\n)(--- (?:a\/)?(\S+)\s*\n\+\+\+ (?:b\/)?(\S+))/g, (_m, p1, p2, p3) => {
        return `\ndiff --git a/${p2} b/${p3}\n${p1}`;
      }).trim();
      resultChunks.push(withGitDiff);
    }
  }
  const joined = resultChunks.join("\n").trim();
  return fixHunkHeaders(joined);
}

function candidatePatches(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:diff|patch)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.includes("diff --git ") || match[1]?.includes("--- a/") || match[1]?.includes("--- ")) {
      candidates.push(normalizeUnifiedDiff(match[1]));
    }
  }
  for (const match of text.matchAll(/```(?:[^\n]*\n)?([\s\S]*?)```/gi)) {
    if (match[1]?.includes("diff --git ") || match[1]?.includes("--- a/") || match[1]?.includes("--- ")) {
      candidates.push(normalizeUnifiedDiff(match[1]));
    }
  }
  const firstGitDiff = text.indexOf("diff --git ");
  if (firstGitDiff >= 0) candidates.push(normalizeUnifiedDiff(text.slice(firstGitDiff)));
  const firstDiff = text.indexOf("--- a/");
  if (firstDiff >= 0) candidates.push(normalizeUnifiedDiff(text.slice(firstDiff)));
  return [...new Set(candidates.filter(Boolean))];
}

/** Git quotes non-ASCII bytes and control characters using C/octal escapes. */
function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("Unterminated Git path.");
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length;) {
    if (body[index] !== "\\") {
      const character = String.fromCodePoint(body.codePointAt(index)!);
      bytes.push(...Buffer.from(character));
      index += character.length;
      continue;
    }
    index++;
    const octal = body.slice(index).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      index += octal.length;
    } else {
      const escapes: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      const escaped = escapes[body[index++]];
      if (escaped === undefined) throw new Error("Invalid Git path escape.");
      bytes.push(...Buffer.from(escaped));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function changedFiles(patch: string): string[] {
  const files = new Set<string>();
  const add = (value: string, prefixed = true): void => {
    const decoded = decodeGitPath(value);
    if (decoded !== "/dev/null") files.add(prefixed ? decoded.replace(/^[ab]\//, "") : decoded);
  };
  // Read headers only, never hunk content that happens to start with ---/+++.
  for (const chunk of patch.split(/\n(?=diff --git )/)) {
    const headers = chunk.split(/\n@@ /)[0];
    const header = headers.split("\n")[0].replace(/^diff --git /, "");
    // A path can itself contain " b/". Prefer quoted tokens, identical
    // old/new names, or explicit rename/copy metadata over greedy splitting.
    const quoted = header.match(/^("(?:[^"\\]|\\.)*") (.+)$/)
      ?? header.match(/^(a\/.*) ("(?:[^"\\]|\\.)*")$/);
    const pairs: string[][] = [];
    if (quoted) pairs.push([quoted[1], quoted[2]]);
    else for (let offset = header.indexOf(" b/"); offset >= 0; offset = header.indexOf(" b/", offset + 1)) {
      pairs.push([header.slice(0, offset), header.slice(offset + 1)]);
    }
    const from = headers.match(/^(?:rename|copy) from (.+)$/m)?.[1];
    const to = headers.match(/^(?:rename|copy) to (.+)$/m)?.[1];
    const pair = pairs.find(([oldName, newName]) => decodeGitPath(oldName).slice(2) === decodeGitPath(newName).slice(2))
      ?? (from && to ? pairs.find(([oldName, newName]) => decodeGitPath(oldName) === `a/${decodeGitPath(from)}` && decodeGitPath(newName) === `b/${decodeGitPath(to)}`) : undefined)
      ?? (pairs.length === 1 ? pairs[0] : undefined);
    const diff = pair ? [header, ...pair] : undefined;
    if (!diff) throw new Error("Invalid Git diff paths.");
    if (!decodeGitPath(diff[1]).startsWith("a/") || !decodeGitPath(diff[2]).startsWith("b/")) throw new Error("Git diff headers require matching a/ and b/ path prefixes.");
    add(diff[1]);
    add(diff[2]);
    for (const line of headers.split("\n")) {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) add(line.slice(4).split("\t")[0]);
      else if (line.startsWith("rename from ")) add(line.slice(12), false);
      else if (line.startsWith("rename to ")) add(line.slice(10), false);
      else if (line.startsWith("copy from ")) add(line.slice(10), false);
      else if (line.startsWith("copy to ")) add(line.slice(8), false);
    }
  }
  return [...files];
}

function validatePatchPaths(files: string[]): void {
  if (files.length === 0) throw new Error("The diff does not contain any changed files.");
  for (const file of files) {
    const components = file.replace(/\\/g, "/").split("/");
    if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes("\0")
      || components.some((part) => ["..", ".git", ".webmcpify", ".serena", "node_modules", ".pnpm-store"].includes(part))) {
      throw new Error(`The diff contains an unsafe target path: ${file}`);
    }
  }
}

export function extractUnifiedDiff(rawProviderOutput: string): { patch: string; changedFiles: string[] } {
  const text = textFromProviderOutput(rawProviderOutput);
  for (const candidate of candidatePatches(text)) {
    try {
      const files = changedFiles(candidate);
      validatePatchPaths(files);
      return { patch: candidate.endsWith("\n") ? candidate : `${candidate}\n`, changedFiles: files };
    } catch {
      // Try the next possible fenced or embedded diff.
    }
  }
  throw new Error("The provider output did not contain a valid unified diff beginning with 'diff --git'.");
}

async function gitOutput(sitePath: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, { cwd: sitePath, timeout: gitTimeoutMs, killSignal: "SIGKILL", maxBuffer: 50 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if ((error as { killed?: boolean }).killed) throw new Error("Git source-identity inspection timed out; refusing incomplete patch validation.");
    return undefined;
  }
}

async function validateAgainstGit(sitePath: string, patch: string): Promise<void> {
  const temporaryPath = path.join(sitePath, ".webmcpify", `.pending-${randomUUID()}.patch`);
  await mkdir(path.dirname(temporaryPath), { recursive: true });
  await writeFile(temporaryPath, patch, "utf8");
  try {
    await execFileAsync("git", ["apply", "--check", "--whitespace=nowarn", temporaryPath], {
      cwd: sitePath,
      timeout: gitTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The extracted diff cannot be applied to the current target: ${detail}`);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function gitSourceSnapshot(sitePath: string): Promise<{ sourceVersion?: string; workingTreeHash?: string }> {
  const sourceVersion = (await gitOutput(sitePath, ["rev-parse", "HEAD"]))?.trim();
  if (!sourceVersion) return {};
  // These are WebMCPify-owned approval/runtime artifacts, not target source.
  // New approved tasks live inside .webmcpify. Keep the legacy root exclusion
  // so existing approval/source fingerprints remain valid after the upgrade.
  const sourcePathspec = [".", ":(exclude).webmcpify/**", ":(exclude)tasks.json"];
  const diff = await gitOutput(sitePath, ["diff", "--binary", "HEAD", "--", ...sourcePathspec]);
  const status = await gitOutput(sitePath, ["status", "--porcelain", "--untracked-files=all", "--", ...sourcePathspec]);
  if (diff === undefined || status === undefined) throw new Error("Could not capture target source identity; refusing incomplete patch validation.");
  const hash = createHash("sha256").update(`${status}\0${diff}`);
  const untracked = await gitOutput(sitePath, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...sourcePathspec]);
  if (untracked === undefined) throw new Error("Could not capture untracked source identity; refusing incomplete patch validation.");
  for (const file of untracked.split("\0").filter(Boolean).sort()) {
    const filename = path.join(sitePath, file);
    const info = await lstat(filename);
    hash.update(`\0${file}\0`);
    hash.update(info.isSymbolicLink() ? await readlink(filename) : await readFile(filename));
  }
  return {
    sourceVersion,
    workingTreeHash: hash.digest("hex"),
  };
}

export async function readPatchMetadata(sitePath: string): Promise<PatchMetadata> {
  return JSON.parse(await readFile(patchMetadataPath(sitePath), "utf8")) as PatchMetadata;
}

export async function writePatchMetadata(sitePath: string, metadata: PatchMetadata): Promise<void> {
  await mkdir(path.dirname(patchMetadataPath(sitePath)), { recursive: true });
  await writeFile(patchMetadataPath(sitePath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function createPendingPatch(
  sitePath: string,
  rawProviderOutput: string,
  generationTrajectory: string,
  context?: Pick<PatchMetadata, "repair" | "securityPolicy" | "provider" | "selectionRevision">,
): Promise<PatchMetadata> {
  const timestamp = new Date().toISOString();
  const runId = randomUUID();
  const base = {
    version: 1 as const,
    runId,
    timestamp,
    targetProject: sitePath,
    ...await gitSourceSnapshot(sitePath),
    patchPath: patchPath(sitePath),
    generationTrajectory,
    ...context,
  };

  try {
    const extracted = extractUnifiedDiff(rawProviderOutput);
    if (!base.sourceVersion) {
      throw new Error("The target project must be a Git repository to validate a source diff.");
    }
    await validateAgainstGit(sitePath, extracted.patch);
    const metadata: PatchMetadata = {
      ...base,
      changedFiles: extracted.changedFiles,
      patchStatus: "awaiting-review",
      patchHash: sourcePatchHash(extracted.patch),
    };
    await mkdir(path.dirname(patchPath(sitePath)), { recursive: true });
    await writeFile(patchPath(sitePath), extracted.patch, "utf8");
    await writePatchMetadata(sitePath, metadata);
    await createTrajectoryArtifact("patch", { ...metadata, patch: extracted.patch }, {
      sitePath,
      runId,
      patchPath: patchPath(sitePath),
      sourceTrajectory: generationTrajectory,
      changedFiles: extracted.changedFiles,
    });
    return metadata;
  } catch (error) {
    const metadata: PatchMetadata = {
      ...base,
      changedFiles: [],
      patchStatus: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
    await writePatchMetadata(sitePath, metadata);
    throw new Error(`Generation did not produce an applicable source diff: ${metadata.error}`);
  }
}

export function patchExists(sitePath: string): boolean {
  return existsSync(patchPath(sitePath)) && existsSync(patchMetadataPath(sitePath));
}
