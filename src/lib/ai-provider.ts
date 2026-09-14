import { existsSync } from "node:fs";
import { executableOnPath, findCodexExecutable } from "./executables.js";

export const AI_PROVIDERS = ["gemini", "antigravity", "claude", "codex", "opencode"] as const;

export type AIProvider = (typeof AI_PROVIDERS)[number];

function detectedProvider(): AIProvider | undefined {
  const codex = findCodexExecutable();
  if ((codex !== "codex" && existsSync(codex)) || executableOnPath("codex")) {
    return "codex";
  }
  if (executableOnPath("claude")) return "claude";
  if (executableOnPath("gemini")) return "gemini";
  if (executableOnPath("opencode")) return "opencode";
  if (executableOnPath("agy")) return "antigravity";
  return undefined;
}

export function resolveProvider(provider?: string): AIProvider {
  const selected = provider ?? process.env.WEBMCPIFY_PROVIDER ?? detectedProvider();

  if (!selected) {
    throw new Error(
      `No supported coding-agent CLI was found. Install or select one with --provider: ${AI_PROVIDERS.join(
        ", ",
      )}.`,
    );
  }

  if (selected === "agy") return "antigravity";

  if ((AI_PROVIDERS as readonly string[]).includes(selected)) {
    return selected as AIProvider;
  }

  throw new Error(
    `Unknown provider "${selected}". Choose one of: ${AI_PROVIDERS.join(", ")}.`
  );
}
