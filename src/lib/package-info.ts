import { readFileSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./paths.js";

interface PackageMetadata {
  name?: string;
  version?: string;
}

let cachedMetadata: Required<PackageMetadata> | undefined;

export function packageMetadata(): Required<PackageMetadata> {
  if (cachedMetadata) return cachedMetadata;

  try {
    const parsed = JSON.parse(
      readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    ) as PackageMetadata;
    cachedMetadata = {
      name: parsed.name ?? "@improvisus/webmcpify-core",
      version: parsed.version ?? "0.0.0",
    };
  } catch {
    cachedMetadata = {
      name: "@improvisus/webmcpify-core",
      version: "0.0.0",
    };
  }

  return cachedMetadata;
}
