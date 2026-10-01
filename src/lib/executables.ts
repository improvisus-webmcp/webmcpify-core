import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function executableOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const suffixes = process.platform === "win32" && !path.extname(name)
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
    const candidate = path.join(directory.replace(/^"|"$/g, ""), `${name}${suffix}`);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      }
    } catch {
      // Ignore inaccessible PATH entries and continue searching.
    }
    }
  }
  return undefined;
}

export function resolveExecutable(name: string, envName: string): string {
  return process.env[envName] ?? executableOnPath(name) ?? name;
}

export function findCodexExecutable(): string {
  const configured = process.env.WEBMCPIFY_CODEX_BIN;
  if (configured) return configured;

  const pathExecutable = executableOnPath("codex");
  if (pathExecutable) return pathExecutable;

  // Codex may be installed inside the OpenAI VS Code extension without a
  // shell PATH entry. Support that installation on Linux and macOS.
  for (const editor of [".vscode", ".cursor", ".vscode-insiders"]) {
  const extensionRoot = path.join(homedir(), editor, "extensions");
  if (existsSync(extensionRoot)) {
    const platformDirectory =
      process.platform === "darwin"
        ? process.arch === "arm64"
          ? "darwin-arm64"
          : "darwin-x86_64"
        : process.platform === "win32" ? `windows-${process.arch === "arm64" ? "arm64" : "x86_64"}`
        : `linux-${process.arch === "arm64" ? "arm64" : "x86_64"}`;
    const binary = process.platform === "win32" ? "codex.exe" : "codex";
    const extension = readdirSync(extensionRoot)
      .filter((name) => name.startsWith("openai.chatgpt-"))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .reverse()
      .find((name) =>
        existsSync(
          path.join(extensionRoot, name, "bin", platformDirectory, binary)
        )
      );

    if (extension) {
      return path.join(
        extensionRoot,
        extension,
        "bin",
        platformDirectory,
        binary
      );
    }
  }
  }

  return "codex";
}
