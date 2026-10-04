import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { fixtureProvider } from "./fixture-provider.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "webmcpify provider fixture "));
try {
  const provider = await fixtureProvider(root, "capture args", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const args = ["--fixture", 'First line\nSecond "quoted" line & | > < ^ % ! $ `', "", "last argument"];
  const result = await execa(provider, args, { cwd: root });
  assert.deepEqual(JSON.parse(result.stdout), args, "Provider arguments must survive Windows shebang launching without cmd.exe re-parsing");
  assert.equal(path.extname(provider), ".mjs");
  console.log("Provider fixture passed: spaced paths, multiline prompts, quotes, shell metacharacters and empty arguments remain unchanged.");
} finally {
  await rm(root, { recursive: true, force: true });
}
