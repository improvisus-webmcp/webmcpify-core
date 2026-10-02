import path from "node:path";
import { extractUnifiedDiff } from "./patches.js";
import type { ProposedTool } from "./tool-proposals.js";

export interface ReviewFile {
  file: string;
  change: "Added" | "Modified" | "Deleted" | "Renamed" | "Copied";
  reason: string;
}

function fileReason(file: string, tools: ProposedTool[]): string {
  const name = path.posix.basename(file).toLowerCase();
  if (name === "agents.md") return "Combines repository instructions and site-capability guidance for coding and browser agents.";
  if (name === "llms.txt") return "Provides a public discovery index linking agents to capability documentation; indexing is not guaranteed.";
  if (name === "webmcp.md") return "Documents proposed tools, inputs, prerequisites, outcomes, and interaction boundaries.";
  if (["webmcp.html", "webmcp-capabilities.html"].includes(name)) return "Provides a crawlable HTML reference for proposed browser-agent capabilities.";
  if (name === "robots.txt") return "Updates crawler access rules for capability references. Review the exact Allow/Disallow changes and existing restrictions.";
  if (name === "webmcp-readiness.md") return "Records deployment, discovery, and GEO/AEO checks that the project owner must verify.";
  if (name === "readme.md") return "Explains the proposed integration and how the project exposes agent capabilities.";
  const registrations = tools.filter(tool => tool.placement.file === file);
  if (registrations.length) return registrations.map(tool => `${tool.name}: ${tool.placement.rationale}`).join("; ");
  const handlers = tools.filter(tool => tool.sourceFiles.includes(file));
  if (handlers.length) return `Connects existing application behavior to proposed tools: ${handlers.map(tool => tool.name).join(", ")}. Inspect the handler and wiring changes.`;
  if (/\.(?:css|scss|sass|less)$/i.test(file)) return "Contains styling changes, potentially for WebMCP/agent feedback. Inspect the diff for the exact UI changes.";
  return "Additional source or configuration change. No specific purpose is declared in the tool metadata; verify its necessity in the exact diff.";
}

/** Describe every actual patch path, not a capped or provider-supplied file list. */
export function describeReviewFiles(patch: string, tools: ProposedTool[]): ReviewFile[] {
  const files = new Map<string, ReviewFile>();
  for (const chunk of patch.split(/\n(?=diff --git )/)) {
    const headers = chunk.split(/\n@@ /)[0];
    const change: ReviewFile["change"] = /^new file mode /m.test(headers) || /^--- \/dev\/null$/m.test(headers) ? "Added"
      : /^deleted file mode /m.test(headers) || /^\+\+\+ \/dev\/null$/m.test(headers) ? "Deleted"
      : /^rename from /m.test(headers) ? "Renamed" : /^copy from /m.test(headers) ? "Copied" : "Modified";
    for (const file of extractUnifiedDiff(chunk).changedFiles) {
      const reason = change === "Deleted" ? "Removes this file. The draft does not declare a file-specific deletion reason; confirm that removal is necessary."
        : fileReason(file, tools);
      files.set(file, { file, change, reason });
    }
  }
  return [...files.values()];
}
