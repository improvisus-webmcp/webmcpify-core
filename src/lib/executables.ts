import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function isExecutable(filename: string): boolean {
  try {
    if (!statSync(filename).isFile()) return false;
    accessSync(filename, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export function executableOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const suffixes = process.platform === "win32" && !path.extname(name)
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      // Resolve relative PATH entries before switching to a disposable cwd.
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), `${name}${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveExecutable(name: string, envName: string): string {
  const configured = process.env[envName];
  if (configured) {
    if (/[\\/]/.test(configured)) return path.resolve(configured);
    return executableOnPath(configured) ?? configured;
  }
  return executableOnPath(name) ?? name;
}

export function findCodexExecutable(): string {
  const configured = process.env.WEBMCPIFY_CODEX_BIN;
  if (configured) return resolveExecutable("codex", "WEBMCPIFY_CODEX_BIN");

  const pathExecutable = executableOnPath("codex");
  if (pathExecutable) return pathExecutable;

  const standalone = path.join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  if (isExecutable(standalone)) return standalone;

  // Codex may be installed inside the OpenAI VS Code extension without a
  // shell PATH entry. Also support other editor and platform installations.
  for (const editor of [".vscode", ".cursor", ".vscode-insiders"]) {
    const extensionRoot = path.join(homedir(), editor, "extensions");
    try {
      if (!existsSync(extensionRoot)) continue;
      const platformDirectory = process.platform === "darwin"
        ? `darwin-${process.arch === "arm64" ? "arm64" : "x86_64"}`
        : `${process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "arm64" : "x86_64"}`;
      const binary = process.platform === "win32" ? "codex.exe" : "codex";
      const extension = readdirSync(extensionRoot)
        .filter((name) => name.startsWith("openai.chatgpt-"))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .reverse()
        .find((name) => isExecutable(path.join(extensionRoot, name, "bin", platformDirectory, binary)));
      if (extension) return path.join(extensionRoot, extension, "bin", platformDirectory, binary);
    } catch { /* An inaccessible editor directory must not block other candidates. */ }
  }

  return "codex";
}

/** Public launch errors must never include the raw command, prompt, or stderr. */
const launchDiagnostics = new WeakMap<ProviderLaunchError, unknown>();
export class ProviderLaunchError extends Error {
  constructor(message: string, diagnostics?: unknown) {
    super(message);
    // Do not attach a public `cause`: inspecting an Error can print its argv.
    launchDiagnostics.set(this, diagnostics);
  }
}

export function providerLaunchDiagnostics(error: ProviderLaunchError): unknown {
  return launchDiagnostics.get(error) ?? error;
}

export function assertProviderCwd(provider: string, cwd: string): void {
  try {
    if (statSync(cwd).isDirectory()) return;
  } catch { /* Report only the safe category, not a raw filesystem error. */ }
  throw new ProviderLaunchError(`The ${provider} provider working directory is missing, inaccessible, or not a directory. Retry the operation; reinstalling the CLI will not fix its working directory.`);
}

export function classifyProviderLaunchError(provider: string, command: string, cwd: string, error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  // Windows launchers can report a missing explicit path as a normal nonzero
  // exit rather than ENOENT. Classify from filesystem evidence, not stderr.
  const explicitPathMissing = /[\\/]/.test(command) && !existsSync(command);
  if (!("code" in error && error.code === "ENOENT") && !explicitPathMissing) return error;
  try { assertProviderCwd(provider, cwd); }
  catch (cwdError) { return cwdError; }
  const candidate = /[\\/]/.test(command) ? command : executableOnPath(command);
  let exists = false;
  try { exists = Boolean(candidate && statSync(candidate).isFile()); } catch { /* Missing launcher. */ }
  const message = exists
    ? `The ${provider} CLI executable exists but could not be launched. Check its interpreter/runtime or broken launcher, and set WEBMCPIFY_${provider.toUpperCase()}_BIN to a working absolute executable path.`
    : `Could not find the ${provider} CLI executable. Install it or set WEBMCPIFY_${provider.toUpperCase()}_BIN to its absolute executable path. Shell aliases and functions are not executable paths.`;
  return new ProviderLaunchError(message, error);
}
