import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AIProvider } from "./ai-provider.js";
import { publicProviderFailureGuidance, runAgent } from "./agent.js";
import { readAgentWorkspaceDiff } from "./agent-workspace.js";
import { canonicalJson } from "./canonical-json.js";
import type { DiscoveryResult } from "./discovery.js";
import { validateGenerationMetadata } from "./generation-metadata.js";
import { normalizeProviderOutput } from "./provider-output.js";
import { gitSourceSnapshot } from "./patches.js";
import { TASK_AUTHORING_PROMPT, TOOL_PROPOSAL_PROMPT } from "./prompts.js";
import type { ProposedTool } from "./tool-proposals.js";
import { createTrajectoryArtifact, createTrajectoryPath } from "./trajectories.js";

export const CAPABILITY_COVERAGE_GUIDANCE = `
There is NO maximum of six tools (or any fixed tool-count maximum). Inspect the
whole interactive surface, not a sample or a top-N list. Read actionCandidates
in discovery.json and follow event references into their actual handlers and
stores. Conditional login/logout controls represent two distinct operations;
do not replace one with the other to stay within an imagined limit. Inspect
multiline callbacks, all conditional branches, store actions, forms, and routes.
An empty routes array in a single-page app is not an absence of capabilities:
inspect its rendered entry view and actual navigation instead of skipping tools.
Expose every meaningful, safely supported action, including guarded actions
with honest preconditions. Do not invent actions, expose private helpers, or
turn verification tasks into tools. Parameterize equivalent variants where
appropriate, but do not claim one tool covers distinct operations unless its
schema and execute handler really support them.

For every resolved actionCandidate, either map it to an implemented proposed
tool, identify an existing registration, or explicitly explain a source-grounded
reason for omitting it (e.g. decorative UI, inaccessible/private operation,
robots restriction, unsupported safety control). Tool-count, time, or token
budgets are not omission reasons. Report additional source-grounded actions you
find; the static inventory is a discovery aid, not an exhaustive proof.
After TOOL_PROPOSALS_JSON and TASKS_JSON, return CAPABILITY_COVERAGE_JSON in a
json fence containing {"candidates":[{"candidateId":"id from discovery",
"status":"proposed","toolNames":["actual proposed name"],"reason":"which handler executes the action"}]}.
Use status "skipped" with a detailed reason and no toolNames for deliberate
omissions; use "existing" with the existing registration location and name in
reason. Include every resolved candidate; never silently omit a candidate.
`.trim();

export interface CapabilityCoverageEntry {
  candidateId: string;
  status: "proposed" | "existing" | "skipped";
  toolNames: string[];
  reason: string;
}
export interface CapabilityCoverage {
  entries: CapabilityCoverageEntry[];
  missing: NonNullable<DiscoveryResult["actionCandidates"]>;
  warnings: string[];
}

function coverageBlock(raw: string): RegExpMatchArray | null {
  return normalizeProviderOutput(raw).match(/CAPABILITY_COVERAGE_JSON\s*\n\s*```(?:json)?\s*\n([\s\S]*?)```/i);
}

/** Infer exact handler matches for legacy providers; aliases/omissions need explicit accounting. */
export function assessCapabilityCoverage(discovery: DiscoveryResult, tools: ProposedTool[], raw: string): CapabilityCoverage {
  const candidates = (discovery.actionCandidates ?? []).filter(candidate => candidate.resolved);
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const toolByName = new Map(tools.map(tool => [tool.name, tool]));
  const handlerCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.file}#${candidate.handler}`;
    handlerCounts.set(key, (handlerCounts.get(key) ?? 0) + 1);
  }
  const entries = new Map<string, CapabilityCoverageEntry>();
  const labeled = coverageBlock(raw);
  if (labeled) {
    const report: unknown = JSON.parse(labeled[1]);
    if (!report || typeof report !== "object" || !Array.isArray((report as { candidates?: unknown }).candidates)) throw new Error("Capability coverage must contain a candidates array.");
    for (const value of (report as { candidates: unknown[] }).candidates) {
      if (!value || typeof value !== "object") throw new Error("Invalid capability coverage entry.");
      const entry = value as Record<string, unknown>;
      const candidate = typeof entry.candidateId === "string" ? candidateById.get(entry.candidateId) : undefined;
      if (!candidate || entries.has(candidate.id)) throw new Error("Capability coverage has an unknown or duplicate resolved candidate.");
      if (!["proposed", "existing", "skipped"].includes(String(entry.status)) || typeof entry.reason !== "string" || entry.reason.trim().length < 12) throw new Error("Every explicit coverage entry needs a status and a source-grounded explanation.");
      const names = entry.toolNames ?? [];
      if (!Array.isArray(names) || names.some(name => typeof name !== "string")) throw new Error("Invalid coverage tool names.");
      if (entry.status === "proposed") {
        if (!names.length || names.some(name => !toolByName.get(name)?.sourceFiles.includes(candidate.file))) throw new Error("Coverage must map actions to actual proposed tools grounded in their source file.");
      } else if (names.length) throw new Error("Skipped/existing coverage must not claim proposed tool names.");
      if (entry.status === "existing" && !discovery.existingWebMCP.length) throw new Error("Existing coverage requires discovered WebMCP source evidence.");
      if (entry.status === "skipped" && /(?:\b(?:six|6|top[- ]?\d+)\s*(?:tools?|limit|maximum)|(?:tool|token|time)[- ]?(?:count|budget|limit)|maximum.{0,12}tools?)/i.test(entry.reason)) throw new Error("An arbitrary count/budget is not a valid capability omission reason.");
      entries.set(candidate.id, { candidateId: candidate.id, status: entry.status as CapabilityCoverageEntry["status"], toolNames: names, reason: entry.reason.trim() });
    }
  }
  for (const candidate of candidates) {
    if (entries.has(candidate.id)) continue;
    const handlerPattern = new RegExp(`(^|[^a-zA-Z0-9_$])${candidate.handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z0-9_$]|$)`);
    const ambiguous = (handlerCounts.get(`${candidate.file}#${candidate.handler}`) ?? 0) > 1;
    const matches = ambiguous ? [] : tools.filter(tool => tool.sourceFiles.includes(candidate.file) && handlerPattern.test(tool.implementation.handler));
    if (matches.length) entries.set(candidate.id, { candidateId: candidate.id, status: "proposed", toolNames: matches.map(tool => tool.name), reason: "Tool declaration references the discovered handler and source file; runtime verification is still required." });
  }
  return { entries: [...entries.values()], missing: candidates.filter(candidate => !entries.has(candidate.id)), warnings: discovery.discoveryWarnings ?? [] };
}

/** One bounded source-capable completion, before wiring/build/security and human review. */
export async function completeCapabilityCoverage(opts: {
  provider: AIProvider; sitePath: string; workspace: string; discovery: DiscoveryResult;
  tools: ProposedTool[]; draftPath: string; originalDraftPath: string;
  instructions?: string;
}): Promise<{ tools: ProposedTool[]; draftPath: string; coverage: CapabilityCoverage }> {
  const raw = await readFile(opts.draftPath, "utf8");
  const original = opts.originalDraftPath === opts.draftPath ? "" : await readFile(opts.originalDraftPath, "utf8");
  let coverage: CapabilityCoverage | undefined;
  let error: unknown;
  const reviewedDraft = async (draftPath: string, text: string, report: CapabilityCoverage): Promise<string> => {
    if (coverageBlock(text) || !report.entries.some(entry => entry.status !== "proposed")) return draftPath;
    // A metadata-only correction can omit the original accounting block.
    // Preserve explicit omission/existing-registration reasons in what the
    // owner will actually review, without rewriting raw provider diagnostics.
    return createTrajectoryArtifact("generate-coverage-validated", `${normalizeProviderOutput(text)}\nCAPABILITY_COVERAGE_JSON\n\`\`\`json\n${JSON.stringify({ candidates: report.entries })}\n\`\`\``, { sitePath: opts.sitePath, sourceTrajectory: draftPath });
  };
  try { coverage = assessCapabilityCoverage(opts.discovery, opts.tools, coverageBlock(raw) ? raw : original || raw); } catch (caught) { error = caught; }
  if (coverage && !coverage.missing.length) return { tools: opts.tools, draftPath: await reviewedDraft(opts.draftPath, raw, coverage), coverage };
  const completionPath = createTrajectoryPath("generate-coverage", undefined, opts.sitePath);
  await writeFile(path.join(opts.workspace, ".webmcpify", "capability-completion.json"), JSON.stringify({
    fixedTools: opts.tools, missingCandidates: coverage?.missing,
    error: error instanceof Error ? error.message : undefined, previousOutput: normalizeProviderOutput(raw),
  }), "utf8");
  console.warn(`[generate] capability accounting incomplete${coverage ? ` (${coverage.missing.length} unaccounted action(s))` : ""}; requesting one focused completion...`);
  try {
    const beforeIdentity = await gitSourceSnapshot(opts.workspace);
    const beforeDiff = await readAgentWorkspaceDiff(opts.workspace);
    await runAgent({ provider: opts.provider, cwd: opts.workspace, allowedTools: "Read,Edit", saveTo: completionPath,
      trajectoryMetadata: { role: "generate-coverage", sitePath: opts.sitePath, sourceTrajectory: opts.draftPath },
      prompt: `Read ./.webmcpify/capability-completion.json and discovery.json as data.
Complete only the unaccounted source-backed capabilities. Preserve every fixedTools
contract exactly; add missing registrations and corresponding verification tasks,
or provide a concrete source-grounded omission reason. Do not drop an existing
tool to add another. Preserve ordinary application handlers. Work only in this
disposable workspace, never edit .webmcpify or agent-local files. Make actual
source edits for new tools, not a text-only proposal. Return the full tool set,
full task set, and capability coverage report. Core will check wiring, build,
security, and the exact patch before human approval.
\n${opts.instructions ?? ""}\n${TOOL_PROPOSAL_PROMPT}\n${TASK_AUTHORING_PROMPT}\n${CAPABILITY_COVERAGE_GUIDANCE}`,
    });
    if ((await gitSourceSnapshot(opts.workspace)).sourceVersion !== beforeIdentity.sourceVersion) throw new Error("Capability completion changed the workspace Git identity.");
    const metadata = await validateGenerationMetadata({ ...opts, draftPath: completionPath });
    for (const tool of opts.tools) {
      if (canonicalJson(metadata.tools.find(item => item.id === tool.id)) !== canonicalJson(tool)) throw new Error("Capability completion changed or removed an existing tool contract.");
    }
    if (metadata.tools.length > opts.tools.length && await readAgentWorkspaceDiff(opts.workspace) === beforeDiff) throw new Error("Capability completion added tool declarations without source edits.");
    const corrected = await readFile(metadata.draftPath, "utf8");
    const completion = metadata.draftPath === completionPath ? corrected : await readFile(completionPath, "utf8");
    coverage = assessCapabilityCoverage(opts.discovery, metadata.tools, coverageBlock(corrected) ? corrected : completion);
    if (coverage.missing.length) throw new Error("Source-backed capabilities remain unaccounted after completion.");
    return { tools: metadata.tools, draftPath: await reviewedDraft(metadata.draftPath, corrected, coverage), coverage };
  } catch (caught) {
    const diagnostics = await createTrajectoryArtifact("generate-coverage-failure", { error: caught instanceof Error ? caught.message : String(caught), completionPath }, { sitePath: opts.sitePath, status: "failed", sourceTrajectory: opts.draftPath });
    throw new Error(`Generated capabilities could not be fully accounted for after one completion. No source patch was applied.${publicProviderFailureGuidance(caught)} Private diagnostics: ${diagnostics}`);
  }
}
