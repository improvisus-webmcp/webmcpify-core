import { execa, type Options } from "execa";
import { currentOperationSignal } from "./operation-context.js";

/** Own the validation subprocess tree, not just its package-manager parent. */
export async function runOperationCommand(command: string, args: string[], options: Options = {}) {
  const signal = currentOperationSignal();
  signal?.throwIfAborted();
  const cancelled = new AbortController();
  const subprocess = execa(command, args, { ...options, detached: process.platform !== "win32", cancelSignal: cancelled.signal });
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => termination ??= (async () => {
    if (subprocess.pid) {
      if (process.platform === "win32") {
        // Kill the tree BEFORE signalling execa to kill its parent; otherwise
        // taskkill can lose the PID while a build child keeps writing source.
        await execa("taskkill", ["/pid", String(subprocess.pid), "/t", "/f"], { reject: false, stdio: "ignore", timeout: 5000 }).catch(() => {});
      } else {
        try { process.kill(-subprocess.pid, "SIGTERM"); } catch { /* already exited */ }
        await new Promise(resolve => setTimeout(resolve, 250));
        try { process.kill(-subprocess.pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
    cancelled.abort();
  })();
  const abort = () => { void terminate(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await subprocess;
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (termination) await termination;
    // A successful parent must not leave POSIX validation descendants running
    // against the workspace after the source/build snapshot was accepted.
    if (process.platform !== "win32" && subprocess.pid) {
      try { process.kill(-subprocess.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
}
