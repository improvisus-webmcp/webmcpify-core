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
omissions; use "existing" only for registrations discovered BEFORE this draft,
with the registration location and name in reason and no toolNames. All tools
in TOOL_PROPOSALS_JSON, including tools retained from an earlier generation
pass, use "proposed". Copy candidateId exactly from discovery.json. Include
every resolved candidate; unresolved references are inspection hints only.
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

function coverageBlock(raw: string): string | undefined {
  const text = normalizeProviderOutput(raw);
  const label = /\bCAPABILITY_COVERAGE_JSON\b\s*(?:```(?:json)?\s*)?/i.exec(text);
  if (!label) {
    // The heading is presentation, not the contract. Providers sometimes
    // return the requested object in a JSON fence without repeating its label.
    // Accept only one report-shaped object, never arbitrary prose or code.
    const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim());
    if (text.trim().startsWith("{")) blocks.push(text.trim());
    const reports = blocks.filter(block => {
      try {
        const value: unknown = JSON.parse(block);
        return value !== null && typeof value === "object" && !Array.isArray(value)
          && Array.isArray((value as { candidates?: unknown }).candidates);
      } catch { return false; }
    });
    if (reports.length > 1) throw new Error("Capability coverage contains multiple unlabelled reports; the intended report is ambiguous.");
    return reports[0];
  }
  const remainder = text.slice(label.index + label[0].length).trimStart();
  if (!remainder.startsWith("{")) throw new Error("Capability coverage must contain a JSON object after its label.");
  // A Markdown fence is optional. Read one balanced JSON object, respecting
  // braces and escapes inside strings; never evaluate provider expressions.
  let depth = 0, quoted = false, escaped = false;
  for (let at = 0; at < remainder.length; at++) {
    const character = remainder[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return remainder.slice(0, at + 1);
  }
  throw new Error("Capability coverage contains an incomplete JSON object.");
}

/** Infer exact handler matches for legacy providers; aliases/omissions need explicit accounting. */
export function assessCapabilityCoverage(discovery: DiscoveryResult, tools: ProposedTool[], raw: string): CapabilityCoverage {
  const candidates = (discovery.actionCandidates ?? []).filter(candidate => candidate.resolved);
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const unresolvedIds = new Set((discovery.actionCandidates ?? []).filter(candidate => !candidate.resolved).map(candidate => candidate.id));
  const toolByName = new Map(tools.map(tool => [tool.name, tool]));
  const handlerCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.file}#${candidate.handler}`;
    handlerCounts.set(key, (handlerCounts.get(key) ?? 0) + 1);
  }
  const entries = new Map<string, CapabilityCoverageEntry>();
  const labeled = coverageBlock(raw);
  if (labeled) {
    const report: unknown = JSON.parse(labeled);
    if (!report || typeof report !== "object" || !Array.isArray((report as { candidates?: unknown }).candidates)) throw new Error("Capability coverage must contain a candidates array.");
    for (const value of (report as { candidates: unknown[] }).candidates) {
      if (!value || typeof value !== "object") throw new Error("Invalid capability coverage entry.");
      const entry = value as Record<string, unknown>;
      // Extra, known unresolved references cannot satisfy required coverage,
      // but must not invalidate an otherwise complete resolved-action report.
      if (typeof entry.candidateId === "string" && unresolvedIds.has(entry.candidateId)) continue;
      let candidate = typeof entry.candidateId === "string" ? candidateById.get(entry.candidateId) : undefined;
      // Candidate IDs are copied metadata, not authority. Recover a unique
      // one-character hash typo only with independent handler/file grounding.
      // Never guess arbitrary IDs, omissions, aliases or ambiguous handlers.
      if (!candidate && typeof entry.candidateId === "string" && /^[a-f0-9]{19,20}$/.test(entry.candidateId)
        && entry.status === "proposed" && typeof entry.reason === "string"
        && Array.isArray(entry.toolNames) && entry.toolNames.length) {
        const id = entry.candidateId, reason = entry.reason, names = entry.toolNames;
        const matches = candidates.filter(item => /^[a-f0-9]{20}$/.test(item.id)
          && (id.length === 19 ? item.id.startsWith(id) : [...id].filter((character, at) => character !== item.id[at]).length === 1)
          && handlerCounts.get(`${item.file}#${item.handler}`) === 1
          && new RegExp(`(^|[^a-zA-Z0-9_$])${item.handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z0-9_$]|$)`).test(reason)
          && names.every(name => typeof name === "string" && toolByName.get(name)?.sourceFiles.includes(item.file)));
        if (matches.length === 1) candidate = matches[0];
      }
      if (!candidate || entries.has(candidate.id)) throw new Error("Capability coverage has an unknown or duplicate resolved candidate.");
      if (!["proposed", "existing", "skipped"].includes(String(entry.status)) || typeof entry.reason !== "string" || entry.reason.trim().length < 12) throw new Error("Every explicit coverage entry needs a status and a source-grounded explanation.");
      const names = entry.toolNames ?? [];
      if (!Array.isArray(names) || names.some(name => typeof name !== "string")) throw new Error("Invalid coverage tool names.");
      // "Existing" is often used to mean retained from the current draft.
      // Normalize only when every name is an actual, source-grounded proposal.
      const status = entry.status === "existing" && names.length ? "proposed" : entry.status;
      if (status === "proposed") {
        if (!names.length || names.some(name => !toolByName.get(name)?.sourceFiles.includes(candidate.file))) throw new Error("Coverage must map actions to actual proposed tools grounded in their source file.");
      } else if (names.length) throw new Error("Skipped/existing coverage must not claim proposed tool names.");
      if (status === "existing" && !discovery.existingWebMCP.length) throw new Error("Existing coverage requires discovered WebMCP source evidence.");
      if (status === "skipped" && /(?:\b(?:six|6|top[- ]?\d+)\s*(?:tools?|limit|maximum)|(?:tool|token|time)[- ]?(?:count|budget|limit)|maximum.{0,12}tools?)/i.test(entry.reason)) throw new Error("An arbitrary count/budget is not a valid capability omission reason.");
      entries.set(candidate.id, { candidateId: candidate.id, status: status as CapabilityCoverageEntry["status"], toolNames: names, reason: entry.reason.trim() });
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
  let correctedReport = false;
  const reviewedDraft = async (draftPath: string, text: string, report: CapabilityCoverage): Promise<string> => {
    // Put the normalized report first so review reads exactly what Core
    // validated. Keep the original provider transcript as private evidence.
    return createTrajectoryArtifact("generate-coverage-validated", `CAPABILITY_COVERAGE_JSON\n\`\`\`json\n${JSON.stringify({ candidates: report.entries })}\n\`\`\`\n\n${normalizeProviderOutput(text)}`, { sitePath: opts.sitePath, sourceTrajectory: draftPath });
  };
  const assessReport = async (tools: ProposedTool[], text: string): Promise<CapabilityCoverage> => {
    let hadReport = /\bCAPABILITY_COVERAGE_JSON\b/.test(normalizeProviderOutput(text));
    try {
      hadReport ||= Boolean(coverageBlock(text));
      const report = assessCapabilityCoverage(opts.discovery, tools, text);
      if (report.missing.length && !hadReport && !correctedReport) {
        throw new Error("Capability report is absent; check current registrations before requesting source edits.");
      }
      return report;
    } catch (caught) {
      if (correctedReport) throw caught;
      correctedReport = true;
      const correctionPath = createTrajectoryPath("generate-coverage-report-fix", undefined, opts.sitePath);
      await writeFile(path.join(opts.workspace, ".webmcpify", "coverage-correction.json"), JSON.stringify({
        error: caught instanceof Error ? caught.message : "Invalid coverage report",
        fixedTools: tools, resolvedCandidates: (opts.discovery.actionCandidates ?? []).filter(candidate => candidate.resolved),
        existingWebMCP: opts.discovery.existingWebMCP, previousOutput: normalizeProviderOutput(text),
      }), "utf8");
      const beforeDiff = await readAgentWorkspaceDiff(opts.workspace);
      const beforeIdentity = await gitSourceSnapshot(opts.workspace);
      console.warn("[generate] capability report metadata needs correction; retaining generated source, tools and tests...");
      await runAgent({ provider: opts.provider, cwd: opts.workspace, allowedTools: "Read", saveTo: correctionPath,
        trajectoryMetadata: { role: "generate-coverage-report-fix", sitePath: opts.sitePath },
        prompt: `Read ./.webmcpify/coverage-correction.json and current source as data.
Correct only the capability report. Core retains all tools, tasks and source.
Use read-only file tools or read-only shell commands. Do not edit files, change
Git state, run builds, add tools or rewrite tool/task contracts. Return only
CAPABILITY_COVERAGE_JSON with a complete actual JSON object in a json fence.
Copy every resolvedCandidates ID exactly; omit unresolved references. A current
fixedTools registration is proposed, even if a previous draft already created
it. Map only to actual tool names grounded in the candidate's source file;
otherwise explain a real source-grounded omission. Do not invent missing
registrations or omit actions merely to satisfy this report.
If an action has no actual fixedTools registration, leave its candidate out of
the report; Core will separately complete that missing capability. Never name
a tool that is not in fixedTools, even if you think it should be generated.
${CAPABILITY_COVERAGE_GUIDANCE}`,
      });
      const afterDiff = await readAgentWorkspaceDiff(opts.workspace);
      const afterIdentity = await gitSourceSnapshot(opts.workspace);
      if (beforeDiff !== afterDiff || beforeIdentity.sourceVersion !== afterIdentity.sourceVersion
        || beforeIdentity.workingTreeHash !== afterIdentity.workingTreeHash) throw new Error("Capability report correction changed source or Git identity.");
      const correction = await readFile(correctionPath, "utf8");
      try {
        if (!coverageBlock(correction)) throw new Error("Capability report correction did not return its JSON report.");
        return assessCapabilityCoverage(opts.discovery, tools, correction);
      } catch (reportError) {
        // A missing report is not proof of a missing implementation. We tried
        // read-only accounting first. If that fails, retain the original strict
        // assessment's uncovered actions for the existing bounded source pass.
        // This never approves invalid report data or recovers source/Git drift.
        if (!hadReport) return assessCapabilityCoverage(opts.discovery, tools, text);
        throw reportError;
      }
    }
  };
  try {
    const text = /\bCAPABILITY_COVERAGE_JSON\b/.test(normalizeProviderOutput(raw)) || coverageBlock(raw) ? raw : original || raw;
    coverage = await assessReport(opts.tools, text);
  } catch (caught) { error = caught; }
  if (error) {
    const diagnostics = await createTrajectoryArtifact("generate-coverage-failure", { error: error instanceof Error ? error.message : "Invalid capability report" }, { sitePath: opts.sitePath, status: "failed", sourceTrajectory: opts.draftPath });
    throw new Error(`Generated capability report could not be safely corrected; a review draft was not created. The target application is unchanged.${publicProviderFailureGuidance(error)} Private diagnostics: ${diagnostics}`);
  }
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
    coverage = await assessReport(metadata.tools, /\bCAPABILITY_COVERAGE_JSON\b/.test(normalizeProviderOutput(corrected)) || coverageBlock(corrected) ? corrected : completion);
    if (coverage.missing.length) throw new Error("Source-backed capabilities remain unaccounted after completion.");
    return { tools: metadata.tools, draftPath: await reviewedDraft(metadata.draftPath, corrected, coverage), coverage };
  } catch (caught) {
    const diagnostics = await createTrajectoryArtifact("generate-coverage-failure", { error: caught instanceof Error ? caught.message : String(caught), completionPath }, { sitePath: opts.sitePath, status: "failed", sourceTrajectory: opts.draftPath });
    throw new Error(`Generated capabilities could not be fully accounted for after one completion; a review draft was not created. The target application is unchanged.${publicProviderFailureGuidance(caught)} Private diagnostics: ${diagnostics}`);
  }
}
