import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiscoveryResult } from "./discovery.js";
import { createTrajectoryArtifact } from "./trajectories.js";

export interface ProposedTool {
  id: string;
  name: string;
  title: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean; consequentialHint: boolean };
  security?: {
    userAuthentication: "required" | "optional" | "none";
    agentIdentity: "required" | "optional" | "none";
    authorization: "backend" | "server-action" | "client-only" | "none";
    originScope: "same-origin" | "restricted-cross-origin";
    allowedOrigins?: string[];
    rateLimit: { enforced: boolean; scope: "agent" | "user" | "agent-user-tool"; limit?: number; windowSeconds?: number };
    idempotency: { enforced: boolean; keyParameter?: string };
    notes: string;
  };
  implementation: { handler: string; action: string; state?: string };
  placement: { strategy: "declarative" | "imperative"; file: string; rationale: string };
  sourceFiles: string[];
}

export interface ProposedToolsDocument {
  version: 1;
  status: "valid";
  generatedAt: string;
  targetProject: string;
  discoveryPath: string;
  tools: ProposedTool[];
}

export function proposedToolsPath(sitePath: string): string {
  return path.join(sitePath, ".webmcpify", "proposed-tools.json");
}

function textFromOutput(raw: string): string {
  const values: string[] = [];
  const collect = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (!key || ["response", "result", "text", "output", "message", "content"].includes(key)) values.push(value);
    } else if (Array.isArray(value)) value.forEach((entry) => collect(entry));
    else if (typeof value === "object" && value !== null) Object.entries(value).forEach(([childKey, childValue]) => collect(childValue, childKey));
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    collect(parsed);
    if (values.length) return values.join("\n");
  } catch {
    // Codex --json emits one JSON object per line. Parse each event so the
    // final item.completed agent message can be searched for structured
    // proposal/task blocks instead of treating the whole stream as plain
    // text.
    for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      try {
        collect(JSON.parse(line));
      } catch {
        // Preserve the plain-output fallback below for non-JSON providers.
      }
    }
    if (values.length) return values.join("\n");
  }
  return raw;
}

function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:[^\n]*\n)?([\s\S]*?)```/gi)) {
    if (match[1]) {
      const trimmed = match[1].trim();
      candidates.push(trimmed);
      const objStart = trimmed.indexOf("{");
      const objEnd = trimmed.lastIndexOf("}");
      if (objStart >= 0 && objEnd > objStart) {
        candidates.push(trimmed.slice(objStart, objEnd + 1));
      }
      const arrStart = trimmed.indexOf("[");
      const arrEnd = trimmed.lastIndexOf("]");
      if (arrStart >= 0 && arrEnd > arrStart) {
        candidates.push(trimmed.slice(arrStart, arrEnd + 1));
      }
    }
  }
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) {
      const trimmed = match[1].trim();
      candidates.push(trimmed);
      const objStart = trimmed.indexOf("{");
      const objEnd = trimmed.lastIndexOf("}");
      if (objStart >= 0 && objEnd > objStart) {
        candidates.push(trimmed.slice(objStart, objEnd + 1));
      }
    }
  }
  candidates.push(text.trim());
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(text.slice(objectStart, objectEnd + 1));
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));
  return candidates;
}

function labeledJsonCandidates(text: string, label: string): string[] {
  const candidates: string[] = [];
  // Providers commonly emit either ` ```json TOOL_PROPOSALS_JSON` or put the
  // label on the line after the language tag. Keep extraction line-oriented so
  // a later TASKS_JSON block can never be selected as a tool proposal.
  const fenced = new RegExp(
    "```(?:json[ \\t]*)?" + label + "[ \\t]*\\r?\\n([\\s\\S]*?)```",
    "gi"
  );
  for (const match of text.matchAll(fenced)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  // Codex commonly puts the label on its own line, followed by a blank line
  // and then a normal ```json fence. Accept that equivalent format while
  // keeping extraction scoped to the labeled block so TASKS_JSON cannot be
  // mistaken for a tool proposal.
  const labelBeforeFence = new RegExp(
    "(?:^|\\r?\\n)\\s*" + label + "\\s*:?[ \\t]*\\r?\\n\\s*```(?:json[ \\t]*)?\\r?\\n([\\s\\S]*?)```",
    "gi",
  );
  for (const match of text.matchAll(labelBeforeFence)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  return candidates;
}

function proposalValue(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return { tools: parsed };
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.tools)) return { tools: record.tools };
  if (Array.isArray(record.proposedTools)) return { tools: record.proposedTools };
  return parsed;
}

function providerProposalValue(parsed: unknown): unknown {
  const proposal = proposalValue(parsed);
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return proposal;
  const record = proposal as Record<string, unknown>;
  if (!Array.isArray(record.tools)) return proposal;

  const toolEntries = record.tools.filter((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
    const candidate = entry as Record<string, unknown>;
    const taskOnly = typeof candidate.verify === "string"
      && candidate.parameters === undefined
      && candidate.schema === undefined
      && candidate.annotations === undefined
      && candidate.implementation === undefined
      && candidate.placement === undefined
      && candidate.sourceFiles === undefined;
    return !taskOnly;
  });

  // Some providers accidentally append the requested TASKS_JSON verification
  // entry to the tool array. Recover only when the entry is unmistakably a
  // task and at least one real tool candidate remains. Stored proposals and
  // review edits still go through validateProposedTools without this cleanup.
  return toolEntries.length > 0 && toolEntries.length < record.tools.length
    ? { ...record, tools: toolEntries }
    : proposal;
}

function normalizeTool(value: unknown, index: number): ProposedTool {
  if (typeof value !== "object" || value === null) throw new Error(`Tool ${index + 1} must be an object.`);
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : typeof candidate.id === "string" ? candidate.id.trim() : "";
  const id = typeof candidate.id === "string" ? candidate.id.trim() : name;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const implementation = candidate.implementation as Record<string, unknown> | undefined;
  const placement = candidate.placement as Record<string, unknown> | undefined;
  const parameters = (candidate.parameters ?? candidate.schema) as Record<string, unknown> | undefined;
  if (!/^[a-z][a-z0-9_-]*$/i.test(name) || !/^[a-z][a-z0-9_-]*$/i.test(id)) throw new Error(`Tool ${index + 1} has an invalid id/name.`);
  if (typeof candidate.description !== "string" || !candidate.description.trim()) throw new Error(`Tool "${name}" needs a description.`);
  if (!title) throw new Error(`Tool "${name}" needs a WebMCP title.`);
  if (!parameters || parameters.type !== "object" || typeof parameters.properties !== "object" || parameters.properties === null || Array.isArray(parameters.properties)) throw new Error(`Tool "${name}" needs an object JSON-schema parameters definition.`);
  if (parameters.additionalProperties !== false) throw new Error(`Tool "${name}" must set parameters.additionalProperties to false.`);
  const annotations = candidate.annotations as Record<string, unknown> | undefined;
  if (!annotations || typeof annotations.readOnlyHint !== "boolean" || typeof annotations.untrustedContentHint !== "boolean" || typeof annotations.consequentialHint !== "boolean") throw new Error(`Tool "${name}" needs complete WebMCP annotations.`);
  if (!implementation || typeof implementation.handler !== "string" || typeof implementation.action !== "string") throw new Error(`Tool "${name}" needs implementation.handler and implementation.action.`);
  if (!placement || (placement.strategy !== "declarative" && placement.strategy !== "imperative") || typeof placement.file !== "string" || typeof placement.rationale !== "string") throw new Error(`Tool "${name}" needs valid placement information.`);
  if (!Array.isArray(candidate.sourceFiles) || candidate.sourceFiles.length === 0 || candidate.sourceFiles.some((file) => typeof file !== "string" || !file.trim())) throw new Error(`Tool "${name}" needs sourceFiles.`);
  if (parameters.required !== undefined && (!Array.isArray(parameters.required) || parameters.required.some((field) => typeof field !== "string"))) throw new Error(`Tool "${name}" has an invalid required parameter list.`);
  const security = normalizeSecurity(candidate.security, name);
  return { id, name, title, description: candidate.description.trim(), parameters: parameters as ProposedTool["parameters"], annotations: { readOnlyHint: annotations.readOnlyHint, untrustedContentHint: annotations.untrustedContentHint, consequentialHint: annotations.consequentialHint }, ...(security ? { security } : {}), implementation: { handler: implementation.handler, action: implementation.action, ...(typeof implementation.state === "string" ? { state: implementation.state } : {}) }, placement: { strategy: placement.strategy, file: placement.file, rationale: placement.rationale }, sourceFiles: [...new Set((candidate.sourceFiles as string[]).map((file) => file.trim()))] };
}

function normalizeSecurity(value: unknown, toolName: string): ProposedTool["security"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Tool "${toolName}" has an invalid security contract.`);
  const security = value as Record<string, unknown>;
  const rateLimit = security.rateLimit as Record<string, unknown> | undefined;
  const idempotency = security.idempotency as Record<string, unknown> | undefined;
  if (!["required", "optional", "none"].includes(String(security.userAuthentication))) throw new Error(`Tool "${toolName}" has an invalid security.userAuthentication value.`);
  if (!["required", "optional", "none"].includes(String(security.agentIdentity))) throw new Error(`Tool "${toolName}" has an invalid security.agentIdentity value.`);
  if (!["backend", "server-action", "client-only", "none"].includes(String(security.authorization))) throw new Error(`Tool "${toolName}" has an invalid security.authorization value.`);
  if (!["same-origin", "restricted-cross-origin"].includes(String(security.originScope))) throw new Error(`Tool "${toolName}" has an invalid security.originScope value.`);
  if (!rateLimit || typeof rateLimit.enforced !== "boolean" || !["agent", "user", "agent-user-tool"].includes(String(rateLimit.scope))) throw new Error(`Tool "${toolName}" has an invalid security.rateLimit contract.`);
  if (!idempotency || typeof idempotency.enforced !== "boolean") throw new Error(`Tool "${toolName}" has an invalid security.idempotency contract.`);
  if (typeof security.notes !== "string" || !security.notes.trim()) throw new Error(`Tool "${toolName}" needs security.notes explaining the enforcement evidence or gap.`);
  if (security.allowedOrigins !== undefined && (!Array.isArray(security.allowedOrigins) || security.allowedOrigins.some((origin) => typeof origin !== "string"))) throw new Error(`Tool "${toolName}" has an invalid security.allowedOrigins list.`);
  for (const [field, raw] of [["limit", rateLimit.limit], ["windowSeconds", rateLimit.windowSeconds]] as const) {
    if (raw !== undefined && (!Number.isInteger(raw) || Number(raw) <= 0)) throw new Error(`Tool "${toolName}" needs a positive integer security.rateLimit.${field}.`);
  }
  if (idempotency.keyParameter !== undefined && (typeof idempotency.keyParameter !== "string" || !idempotency.keyParameter.trim())) throw new Error(`Tool "${toolName}" has an invalid security.idempotency.keyParameter.`);
  return {
    userAuthentication: security.userAuthentication as NonNullable<ProposedTool["security"]>["userAuthentication"],
    agentIdentity: security.agentIdentity as NonNullable<ProposedTool["security"]>["agentIdentity"],
    authorization: security.authorization as NonNullable<ProposedTool["security"]>["authorization"],
    originScope: security.originScope as NonNullable<ProposedTool["security"]>["originScope"],
    ...(Array.isArray(security.allowedOrigins) ? { allowedOrigins: [...new Set(security.allowedOrigins.map(String))] } : {}),
    rateLimit: { enforced: rateLimit.enforced, scope: rateLimit.scope as NonNullable<ProposedTool["security"]>["rateLimit"]["scope"], ...(typeof rateLimit.limit === "number" ? { limit: rateLimit.limit } : {}), ...(typeof rateLimit.windowSeconds === "number" ? { windowSeconds: rateLimit.windowSeconds } : {}) },
    idempotency: { enforced: idempotency.enforced, ...(typeof idempotency.keyParameter === "string" ? { keyParameter: idempotency.keyParameter.trim() } : {}) },
    notes: security.notes.trim(),
  };
}

function relatedSignals(tool: ProposedTool, discovery: DiscoveryResult): string[] {
  const sourceFiles = new Set(discovery.sourceFiles ?? []);
  const signals = [...discovery.forms, ...discovery.buttons, ...discovery.actions, ...discovery.apis, ...discovery.authentication, ...discovery.state, ...discovery.existingWebMCP];
  return signals.filter((signal) => tool.sourceFiles.includes(signal.file) || tool.placement.file === signal.file || tool.implementation.handler.startsWith(signal.file)).map((signal) => signal.kind);
}

function validateSupport(tool: ProposedTool, discovery: DiscoveryResult): void {
  const knownFiles = new Set(discovery.sourceFiles ?? []);
  const knownSourceFiles = tool.sourceFiles.filter((file) => knownFiles.has(file));
  if (knownSourceFiles.length === 0) throw new Error(`Tool "${tool.name}" references no source file present in discovery.`);
  if (tool.placement.strategy === "declarative" && !knownFiles.has(tool.placement.file)) throw new Error(`Declarative tool "${tool.name}" must be placed in an existing discovered source file.`);
  if (tool.placement.strategy === "declarative" && !tool.sourceFiles.includes(tool.placement.file)) throw new Error(`Declarative tool "${tool.name}" placement.file must be listed in sourceFiles.`);
  if (tool.placement.strategy === "imperative" && discovery.existingWebMCP.length > 0) {
    const integrationFiles = new Set(discovery.existingWebMCP.map((signal) => signal.file));
    if (!integrationFiles.has(tool.placement.file)) throw new Error(`Imperative tool "${tool.name}" should use an existing discovered WebMCP integration file: ${[...integrationFiles].join(", ")}.`);
  }
  const kinds = new Set(relatedSignals(tool, discovery));
  if (kinds.size === 0) throw new Error(`Tool "${tool.name}" has no matching discovered UI action, API, state, auth, or WebMCP signal.`);
  const text = `${tool.name} ${tool.description} ${tool.implementation.action} ${tool.implementation.handler}`.toLowerCase();
  if (/(auth|login|logout|session|account|sign.?in|sign.?out)/.test(text) && discovery.authentication.length === 0) throw new Error(`Tool "${tool.name}" requires authentication capability not found in discovery.`);
  if (/(api|fetch|request|graphql|server|endpoint)/.test(text) && discovery.apis.length === 0) throw new Error(`Tool "${tool.name}" requires API capability not found in discovery.`);
  if (tool.placement.strategy === "declarative" && discovery.forms.length === 0) throw new Error(`Tool "${tool.name}" uses declarative placement but discovery found no forms.`);
}

export function validateProposedTools(value: unknown, discovery: DiscoveryResult): ProposedTool[] {
  const rawTools = Array.isArray(value) ? value : typeof value === "object" && value !== null ? (value as Record<string, unknown>).tools : undefined;
  if (!Array.isArray(rawTools) || rawTools.length === 0) throw new Error("The provider output must contain a non-empty tools array.");
  const tools = rawTools.map(normalizeTool);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id.toLowerCase())) throw new Error(`Duplicate tool id: ${tool.id}`);
    ids.add(tool.id.toLowerCase());
    const normalizedName = tool.name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(normalizedName);
    validateSupport(tool, discovery);
  }
  return tools;
}

export function extractAndValidateProposedTools(raw: string, discovery: DiscoveryResult): ProposedTool[] {
  const text = textFromOutput(raw);
  // Providers also emit TASKS_JSON after the tool proposal. Prefer the
  // explicitly labelled proposal block so that the task array is never
  // mistaken for a list of tools.
  const labeledTools = labeledJsonCandidates(text, "TOOL_PROPOSALS_JSON");
  const candidates = labeledTools.length > 0
    ? labeledTools
    : [raw, text, ...jsonCandidates(text)];
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return validateProposedTools(providerProposalValue(parsed), discovery);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      lastError = error;
      continue;
    }
  }
  if (lastError instanceof Error && !lastError.message.includes("is not valid JSON") && !lastError.message.includes("Unexpected token")) {
    throw lastError;
  }
  throw new Error(
    labeledTools.length > 0
      ? "The TOOL_PROPOSALS_JSON block was invalid; TASKS_JSON cannot be used as a tool proposal."
      : "Provider output did not contain a labeled TOOL_PROPOSALS_JSON block."
  );
}

export async function writeProposedTools(sitePath: string, tools: ProposedTool[], discoveryPath: string, generationTrajectory: string): Promise<string> {
  const output = proposedToolsPath(sitePath);
  const document: ProposedToolsDocument = { version: 1, status: "valid", generatedAt: new Date().toISOString(), targetProject: sitePath, discoveryPath, tools };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await createTrajectoryArtifact("proposed-tools", document, { sitePath, proposedToolsPath: output, discoveryPath, sourceTrajectory: generationTrajectory, toolCount: tools.length });
  return output;
}

export async function loadDiscovery(sitePath: string): Promise<DiscoveryResult> {
  return JSON.parse(await readFile(path.join(sitePath, ".webmcpify", "discovery.json"), "utf8")) as DiscoveryResult;
}
