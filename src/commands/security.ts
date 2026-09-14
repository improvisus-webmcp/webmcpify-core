import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { approvedManifestPath } from "../lib/tasks.js";
import { loadDiscovery, proposedToolsPath, validateProposedTools } from "../lib/tool-proposals.js";
import { auditToolSecurity, writeSecurityReport, type SecurityReport } from "../lib/security-audit.js";

export interface SecurityOptions {
  path?: string;
  strict?: boolean;
}

async function loadTools(sitePath: string, discovery: Awaited<ReturnType<typeof loadDiscovery>>) {
  const proposal = proposedToolsPath(sitePath);
  if (existsSync(proposal)) return validateProposedTools(JSON.parse(await readFile(proposal, "utf8")), discovery);
  const approval = approvedManifestPath(sitePath);
  if (existsSync(approval)) {
    const parsed = JSON.parse(await readFile(approval, "utf8")) as { tools?: unknown };
    return validateProposedTools(parsed.tools, discovery);
  }
  throw new Error(`No proposed or approved tools found under ${path.join(sitePath, ".webmcpify")}. Run "webmcpify generate" first.`);
}

export async function runSecurity(opts: SecurityOptions): Promise<SecurityReport> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  const discovery = await loadDiscovery(sitePath);
  const tools = await loadTools(sitePath, discovery);
  const report = auditToolSecurity(tools, discovery, sitePath);
  const output = await writeSecurityReport(sitePath, report);
  console.log(`[security] ${report.status}: ${report.summary.block} blocking, ${report.summary.review} review finding(s)`);
  console.log(`[security] report: ${output}`);
  for (const item of report.findings) console.log(`[security] ${item.severity.toUpperCase()} ${item.toolId}/${item.code}: ${item.message}`);
  if (opts.strict && report.status === "block") throw new Error("Security audit found blocking access-control gaps.");
  return report;
}
