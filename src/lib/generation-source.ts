import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { DiscoveryResult } from "./discovery.js";
import { extractUnifiedDiff, gitSourceSnapshot } from "./patches.js";
import { normalizeProviderOutput } from "./provider-output.js";
import { createTrajectoryArtifact } from "./trajectories.js";

interface SourceCheckpoint {
  version: 1;
  sitePath: string;
  sourceTrajectory: string;
  discovery: DiscoveryResult;
  patch: string;
  sourceVersion?: string;
  workingTreeHash?: string;
}

const checkpointPath = (site: string) => path.join(site, ".webmcpify", "generation-source.json");

/** Private, unapproved source capture; never an approval or applicable patch. */
export async function saveGenerationSource(site: string, patch: string, discovery: DiscoveryResult,
  sourceTrajectory: string, identity: Awaited<ReturnType<typeof gitSourceSnapshot>>): Promise<string> {
  const current = await gitSourceSnapshot(site);
  if (JSON.stringify(current) !== JSON.stringify(identity)) throw new Error("Target source changed during generation; refusing a stale source checkpoint.");
  const file = checkpointPath(site);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, sitePath: path.resolve(site), sourceTrajectory,
    discovery, patch: extractUnifiedDiff(patch).patch, ...identity } satisfies SourceCheckpoint), "utf8");
  return file;
}

export async function loadGenerationSource(site: string): Promise<SourceCheckpoint> {
  let saved: SourceCheckpoint;
  try { saved = JSON.parse(await readFile(checkpointPath(site), "utf8")); }
  catch { throw new Error("No saved source checkpoint. Run generate --diagnostic-source-only once, then retry with --diagnostic-metadata-only."); }
  if (!saved || saved.version !== 1 || saved.sitePath !== path.resolve(site)
    || typeof saved.patch !== "string" || typeof saved.sourceTrajectory !== "string"
    || !saved.discovery || !Array.isArray(saved.discovery.actionCandidates)) {
    throw new Error("Invalid source checkpoint; run generate --diagnostic-source-only again.");
  }
  const identity = await gitSourceSnapshot(site);
  if (!saved.sourceVersion || !saved.workingTreeHash) {
    throw new Error("Metadata-only retry requires a Git target with a saved source identity. Normal generation still supports projects without Git.");
  }
  if (saved.sourceVersion !== identity.sourceVersion || saved.workingTreeHash !== identity.workingTreeHash) {
    throw new Error("Target source changed since the checkpoint; run generate --diagnostic-source-only again.");
  }
  extractUnifiedDiff(saved.patch);
  return saved;
}

/** Bind a completed metadata draft to the saved source, then freeze its bytes. */
export async function loadGenerationMetadata(site: string, file: string, sourceTrajectory: string): Promise<string> {
  const directory = path.resolve(site, ".webmcpify", "trajectories");
  const filename = path.resolve(file);
  const inside = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
  };
  if (!inside(directory, filename) || !filename.endsWith(".json") || filename.endsWith(".meta.json")) {
    throw new Error("Continue with a complete metadata .json artifact from this target's .webmcpify/trajectories directory.");
  }
  let metadata: Record<string, unknown>;
  let raw: string;
  try {
    const resolvedDirectory = await realpath(directory);
    if (!inside(resolvedDirectory, await realpath(filename))
      || !inside(resolvedDirectory, await realpath(filename.replace(/\.json$/, ".meta.json")))) {
      throw new Error("Metadata artifact escapes its trajectory directory.");
    }
    metadata = JSON.parse(await readFile(filename.replace(/\.json$/, ".meta.json"), "utf8"));
    raw = await readFile(filename, "utf8");
  } catch {
    throw new Error("Could not safely read the saved metadata and its provenance. Use the complete metadata file printed by the successful diagnostic.");
  }
  if (!metadata || metadata.role !== "generate-metadata" || metadata.status !== "completed"
    || typeof metadata.sitePath !== "string" || path.resolve(metadata.sitePath) !== path.resolve(site)
    || typeof metadata.sourceTrajectory !== "string" || path.resolve(metadata.sourceTrajectory) !== path.resolve(sourceTrajectory)) {
    throw new Error("Saved metadata does not belong to this source checkpoint. Use matching source and complete metadata diagnostics; nothing was regenerated or applied.");
  }
  return createTrajectoryArtifact("generate-metadata-resumed", normalizeProviderOutput(raw),
    { sitePath: site, sourceTrajectory: filename, sourceEditTrajectory: sourceTrajectory });
}

/** Replay only inside Core's disposable workspace, never the target checkout. */
export async function restoreGenerationSource(workspace: string, checkpoint: SourceCheckpoint): Promise<void> {
  const patch = extractUnifiedDiff(checkpoint.patch).patch;
  try {
    await execa("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: workspace, input: patch });
    await execa("git", ["apply", "--whitespace=nowarn", "-"], { cwd: workspace, input: patch });
  } catch {
    throw new Error("Saved source cannot be restored safely into the disposable copy. Run generate --diagnostic-source-only again; target source is unchanged.");
  }
}
