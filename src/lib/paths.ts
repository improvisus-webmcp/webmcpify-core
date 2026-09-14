import path from "node:path";
import { fileURLToPath } from "node:url";

/** Return the installed WebMCPify package root, independent of cwd. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}
