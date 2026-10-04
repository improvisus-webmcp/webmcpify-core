import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/** A credential-free executable provider fixture on POSIX and Windows. */
export async function fixtureProvider(directory, filename, source) {
  const script = path.join(directory, `${filename}.mjs`);
  await writeFile(script, source.startsWith("#!") ? source : `#!/usr/bin/env node\n${source}`);
  if (process.platform !== "win32") await chmod(script, 0o755);
  // Execa resolves the Node shebang on Windows. A .cmd wrapper re-parses
  // prompts through cmd.exe and cannot preserve multiline/quoted arguments.
  return script;
}
