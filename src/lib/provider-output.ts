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

function collectText(value: unknown, values: string[], key?: string): void {
  if (typeof value === "string") {
    if (!key || TEXT_KEYS.has(key)) values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectText(entry, values, key));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.entries(value).forEach(([childKey, childValue]) => collectText(childValue, values, childKey));
  }
}

/** Convert raw provider output into the assistant text containing proposals. */
export function normalizeProviderOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
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
