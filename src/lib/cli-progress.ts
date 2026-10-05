import { clearCliProgress, printCliLine, registerProgressClearer, terminalWidth, wrapText } from "./cli-output.js";

interface ProgressOptions {
  stream?: Pick<NodeJS.WriteStream, "isTTY" | "write"> & { columns?: number };
  intervalMs?: number;
}

/** One bounded spinner line, cleared before phase or MCP messages are printed. */
export function startCliProgress(scope: string, label: string, options: ProgressOptions = {}): (status?: string) => void {
  const stream = options.stream ?? process.stderr;
  const interactive = Boolean(stream.isTTY);
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  let visible = false;
  const clear = () => {
    if (visible) { stream.write("\r\x1b[2K"); visible = false; }
  };
  printCliLine(scope, `${label} started`, stream);
  const unregister = interactive ? registerProgressClearer(clear) : () => {};
  const timer = setInterval(() => {
    if (interactive) {
      const prefix = `[${scope}] ${frames[frame++ % frames.length]} ${elapsed()} elapsed | `;
      const available = terminalWidth(stream);
      const line = wrapText(prefix + label, available)[0];
      clearCliProgress();
      stream.write("\r" + line);
      visible = true;
    } else printCliLine(scope, `${label} working (${elapsed()} elapsed)`, stream);
  }, options.intervalMs ?? (interactive ? 250 : 5000));
  timer.unref();
  let stopped = false;
  return (status = "completed") => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clear();
    unregister();
    printCliLine(scope, `${label} ${status} (${elapsed()} elapsed)`, stream);
  };
}

/** Safe phase-only stderr feedback; never echo command, prompt, code or errors. */
export async function withCliProgress<T>(scope: string, label: string, operation: () => Promise<T>, options: ProgressOptions = {}): Promise<T> {
  const stop = startCliProgress(scope, label, options);
  let completed = false;
  try {
    const result = await operation();
    completed = true;
    return result;
  } finally {
    stop(completed ? "completed" : "stopped");
  }
}
