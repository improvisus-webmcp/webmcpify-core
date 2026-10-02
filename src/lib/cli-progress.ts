interface ProgressOptions {
  stream?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  intervalMs?: number;
}

/** Safe phase-only stderr feedback; never echo command, prompt, code or errors. */
export async function withCliProgress<T>(scope: string, label: string, operation: () => Promise<T>, options: ProgressOptions = {}): Promise<T> {
  const stream = options.stream ?? process.stderr;
  const interactive = Boolean(stream.isTTY);
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  stream.write(`[${scope}] ${label} started…\n`);
  const timer = setInterval(() => {
    stream.write(interactive ? `\r\x1b[2K[${scope}] ${label} ${frames[frame++ % frames.length]} (${elapsed()} elapsed)`
      : `[${scope}] ${label} working (${elapsed()} elapsed)…\n`);
  }, options.intervalMs ?? (interactive ? 250 : 5000));
  timer.unref();
  let completed = false;
  try {
    const result = await operation();
    completed = true;
    return result;
  } finally {
    clearInterval(timer);
    if (interactive) stream.write("\r\x1b[2K");
    stream.write(`[${scope}] ${label} ${completed ? "completed" : "stopped"} (${elapsed()} elapsed).\n`);
  }
}
