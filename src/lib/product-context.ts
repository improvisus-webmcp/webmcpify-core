import { createInterface } from "node:readline/promises";

export function normalizeProductContext(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Ask for optional domain knowledge after automated discovery. This is
 * deliberately TTY-only so non-interactive use, MCP calls, and CI retain the
 * exact current flow.
 */
export async function collectProductContext(
  supplied?: string,
  shouldPrompt = true,
): Promise<string | undefined> {
  const provided = normalizeProductContext(supplied);
  if (provided || !shouldPrompt || !process.stdin.isTTY || !process.stdout.isTTY) {
    return provided;
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return normalizeProductContext(await readline.question(
      "[generate] Optional product context (features, workflows, or intended outcomes). Press Enter to skip:\n> ",
    ));
  } finally {
    readline.close();
  }
}
