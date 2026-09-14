import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type TrajectoryStatus = "running" | "completed" | "failed";

export interface TrajectoryMetadata {
  role: string;
  status: TrajectoryStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  provider?: string;
  cwd?: string;
  prompt?: string;
  allowedTools?: string;
  mcpConfig?: string;
  [key: string]: unknown;
}

function trajectoryDirectory(sitePath?: string): string {
  return path.join(path.resolve(sitePath ?? process.cwd()), ".webmcpify", "trajectories");
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run"
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function metadataPath(rawPath: string): string {
  return rawPath.endsWith(".json")
    ? `${rawPath.slice(0, -5)}.meta.json`
    : `${rawPath}.meta.json`;
}

export function createTrajectoryPath(role: string, label?: string, sitePath?: string): string {
  const suffix = label ? `-${safeSegment(label)}` : "";
  return path.join(
    trajectoryDirectory(sitePath),
    `${safeSegment(role)}-${timestamp()}-${randomUUID().slice(0, 8)}${suffix}.json`
  );
}

export async function recordTrajectoryMetadata(
  rawPath: string,
  metadata: TrajectoryMetadata
): Promise<string> {
  const metadataFilePath = metadataPath(rawPath);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await writeFile(
    metadataFilePath,
    JSON.stringify(
      {
        version: 1,
        ...metadata,
        trajectory: path.basename(rawPath),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return metadataFilePath;
}

export async function writeTrajectoryArtifact(
  rawPath: string,
  value: unknown,
  metadata: TrajectoryMetadata
): Promise<string> {
  await mkdir(path.dirname(rawPath), { recursive: true });
  await writeFile(rawPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  return recordTrajectoryMetadata(rawPath, metadata);
}

export async function createTrajectoryArtifact(
  role: string,
  value: unknown,
  metadata: Omit<TrajectoryMetadata, "role" | "status"> &
    Partial<Pick<TrajectoryMetadata, "status">>,
  label?: string
): Promise<string> {
  const rawPath = createTrajectoryPath(role, label, typeof metadata.sitePath === "string" ? metadata.sitePath : undefined);
  await writeTrajectoryArtifact(rawPath, value, {
    ...metadata,
    role,
    status: metadata.status ?? "completed",
  });
  return rawPath;
}

export async function latestTrajectoryPath(
  role: string,
  sitePath?: string
): Promise<string | undefined> {
  const directory = trajectoryDirectory(sitePath);
  await mkdir(directory, { recursive: true });
  const prefix = `${safeSegment(role)}-`;
  const entries = await readdir(directory, { withFileTypes: true });
  const dynamic = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".meta.json")
    )
    .map((entry) => entry.name)
    .sort();

  if (dynamic.length > 0) {
    const candidates = dynamic.reverse();
    if (!sitePath) return path.join(directory, candidates[0]);
    const target = path.resolve(sitePath);
    for (const candidate of candidates) {
      const candidatePath = path.join(directory, candidate);
      try {
        const metadata = JSON.parse(await readFile(metadataPath(candidatePath), "utf8")) as Record<string, unknown>;
        const recordedSite = metadata.sitePath ?? metadata.cwd ?? metadata.targetProject;
        if (typeof recordedSite === "string" && path.resolve(recordedSite) === target) return candidatePath;
      } catch {
        // Ignore malformed/unrelated artifacts while searching for this project.
      }
    }
    return undefined;
  }

  const legacy = path.join(directory, `${safeSegment(role)}.json`);
  try {
    await access(legacy);
    if (!sitePath) return legacy;
    const metadata = JSON.parse(await readFile(metadataPath(legacy), "utf8")) as Record<string, unknown>;
    const recordedSite = metadata.sitePath ?? metadata.cwd ?? metadata.targetProject;
    return typeof recordedSite === "string" && path.resolve(recordedSite) === path.resolve(sitePath)
      ? legacy
      : undefined;
  } catch {
    return undefined;
  }
}

export function trajectoryDirectoryPath(): string {
  return trajectoryDirectory();
}
