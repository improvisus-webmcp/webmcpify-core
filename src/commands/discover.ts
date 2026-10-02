import path from "node:path";
import { existsSync } from "node:fs";
import { discoveryPath, runDiscovery } from "../lib/discovery.js";

export async function runDiscover(opts: { path?: string }): Promise<void> {
  const sitePath = path.resolve(opts.path ?? process.cwd());
  if (!existsSync(sitePath)) throw new Error(`Site path does not exist: ${sitePath}`);
  const result = await runDiscovery(sitePath);
  console.log(`[discover] scanned ${result.filesScanned} source file(s)`);
  console.log(`[discover] framework: ${result.stack.framework ?? "unknown"}`);
  console.log(`[discover] routes: ${result.routes.length}, actions: ${result.actions.length}, APIs: ${result.apis.length}`);
  console.log(`[discover] action candidates: ${result.actionCandidates?.length ?? 0} (${result.actionCandidates?.filter(candidate => candidate.resolved).length ?? 0} resolved handlers)`);
  for (const warning of result.discoveryWarnings ?? []) console.warn(`[discover] ${warning}`);
  console.log(`[discover] discovery saved to ${discoveryPath(sitePath)}`);
}
