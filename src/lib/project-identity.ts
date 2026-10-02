import path from "node:path";
import type { DiscoveryResult } from "./discovery.js";

export function projectDisplayName(discovery: Pick<DiscoveryResult, "project" | "targetProject">): string {
  return (discovery.project.name?.trim() || path.basename(discovery.targetProject) || "Website")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
}
