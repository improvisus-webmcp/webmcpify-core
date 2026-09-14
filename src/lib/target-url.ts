export function normalizeTargetUrl(value: string): string {
  const trimmed = value.trim();
  const markdownLink = trimmed.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
  const candidate = markdownLink?.[2] ?? trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      'Invalid target URL "' + value + '". Use a plain URL such as http://localhost:5173 (not Markdown link syntax).',
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error('Unsupported target URL protocol "' + parsed.protocol + '". Use http:// or https://.');
  }
  return parsed.toString().replace(/\/$/, "");
}

export async function ensureTargetReachable(url: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel();
  } catch (error) {
    throw new Error(
      `Target URL is not reachable: ${url}. Start the site and try again. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
