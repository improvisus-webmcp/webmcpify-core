const TEXT_KEYS = new Set([
  "response",
  "result",
  "text",
  "output",
  "message",
  "content",
  "assistant",
  "completion",
  "answer",
  "final",
]);

// Closed envelope: the domain JSON remains subject to the existing tool, task
// and coverage validators. Strings permit arbitrary application input schemas
// without weakening Codex's required closed-object response schema.
export const GENERATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    tool_proposals_json: { type: "string", description: "Complete JSON object with a tools array describing the actual generated registrations, not a summary or file reference." },
    tasks_json: { type: "string", description: "Complete JSON array of realistic verification tasks bound to all proposed tools." },
    capability_coverage_json: {
      type: "object",
      properties: { candidates: { type: "array", items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          status: { type: "string", enum: ["proposed", "existing", "skipped"] },
          toolNames: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["candidateId", "status", "toolNames", "reason"],
        additionalProperties: false,
      } } },
      required: ["candidates"],
      additionalProperties: false,
      description: "Actual JSON object accounting for every resolved discovery action; use empty toolNames for skipped/existing entries.",
    },
  },
  required: ["tool_proposals_json", "tasks_json", "capability_coverage_json"],
  additionalProperties: false,
};

/** Candidate IDs are Core-owned metadata, not strings for a model to invent. */
export function generationOutputSchema(candidateIds: string[]): typeof GENERATION_OUTPUT_SCHEMA {
  const schema = structuredClone(GENERATION_OUTPUT_SCHEMA);
  const candidates = schema.properties.capability_coverage_json.properties.candidates;
  if (candidateIds.length) Object.assign(candidates.items.properties.candidateId, { enum: [...new Set(candidateIds)] });
  else Object.assign(candidates, { maxItems: 0 });
  return schema;
}

function generationText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  const keys = GENERATION_OUTPUT_SCHEMA.required;
  const coverage = envelope.capability_coverage_json;
  if (Object.keys(envelope).length !== keys.length || typeof envelope.tool_proposals_json !== "string"
    || typeof envelope.tasks_json !== "string" || !(typeof coverage === "string"
      || (coverage && typeof coverage === "object" && !Array.isArray(coverage)))) return undefined;
  // Preserve malformed content for the domain validators; never silently
  // substitute invented tools, tasks or reports.
  return keys.map((key, index) => `${["TOOL_PROPOSALS_JSON", "TASKS_JSON", "CAPABILITY_COVERAGE_JSON"][index]}\n\`\`\`json\n${typeof envelope[key] === "string" ? envelope[key] : JSON.stringify(envelope[key])}\n\`\`\``).join("\n");
}

function collectText(value: unknown, values: string[], key?: string): void {
  if (typeof value === "string") {
    if (!key || TEXT_KEYS.has(key)) {
      let structured: string | undefined;
      try { structured = generationText(JSON.parse(value)); } catch { /* Ordinary assistant text. */ }
      values.push(structured ?? value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectText(entry, values, key));
    return;
  }
  if (typeof value === "object" && value !== null) {
    const structured = generationText(value);
    if (structured) { values.push(structured); return; }
    Object.entries(value).forEach(([childKey, childValue]) => collectText(childValue, values, childKey));
  }
}

/** Convert raw provider output into the assistant text containing proposals. */
export function normalizeProviderOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const values: string[] = [];
    collectText(parsed, values);
    return values.length ? values.join("\n") : raw;
  } catch {
    const values: string[] = [];
    let parsedLine = false;
    for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      try {
        collectText(JSON.parse(line), values);
        parsedLine = true;
      } catch {
        // Plain text uses the raw-output fallback.
      }
    }
    return parsedLine && values.length ? values.join("\n") : raw;
  }
}
