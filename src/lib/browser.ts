import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executableOnPath } from "./executables.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

function cdpUrl(): URL {
  const value = process.env.WEBMCPIFY_CDP_URL ?? DEFAULT_CDP_URL;
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid WEBMCPIFY_CDP_URL: ${value}`);
  }
}

async function cdpAvailable(endpoint: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/json/version", endpoint), {
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function chromeExecutable(): string | undefined {
  if (process.env.WEBMCPIFY_CHROME_BIN) {
    return process.env.WEBMCPIFY_CHROME_BIN;
  }

  for (const candidate of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const executable = executableOnPath(candidate);
    if (executable) return executable;
  }

  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return undefined;
}

async function waitForCdp(
  endpoint: URL,
  child: ChildProcess,
  launchError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const error = launchError();
    if (error) throw error;
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before opening ${endpoint.origin}.`);
    }
    if (await cdpAvailable(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Chrome did not open ${endpoint.origin} within 10 seconds.`);
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/** Reuse an existing CDP browser or manage one isolated Chrome process. */
export async function withManagedChrome<T>(
  targetUrl: string,
  operation: () => Promise<T>,
): Promise<T> {
  const endpoint = cdpUrl();
  if (await cdpAvailable(endpoint)) {
    console.log(`[browser] using Chrome at ${endpoint.origin}`);
    return operation();
  }

  if (!["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
    throw new Error(
      `Could not connect to the configured remote Chrome endpoint ${endpoint.origin}.`,
    );
  }

  const executable = chromeExecutable();
  if (!executable) {
    throw new Error(
      "Chrome or Chromium was not found. Install it or set WEBMCPIFY_CHROME_BIN.",
    );
  }

  const profile = await mkdtemp(path.join(os.tmpdir(), "webmcpify-chrome-"));
  const port = endpoint.port || "9222";
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--enable-features=DevToolsWebMCPSupport,WebMCP",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      targetUrl,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });
  const stopOnExit = () => child.kill("SIGTERM");
  process.once("exit", stopOnExit);

  try {
    await waitForCdp(endpoint, child, () => childError);
    console.log(`[browser] started isolated Chrome at ${endpoint.origin}`);
    return await operation();
  } finally {
    process.removeListener("exit", stopOnExit);
    await stopChrome(child);
    await rm(profile, { recursive: true, force: true });
  }
}
