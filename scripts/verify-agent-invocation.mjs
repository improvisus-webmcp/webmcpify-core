import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getInvocation, runAgent } from "../dist/lib/agent.js";
import { GENERATE_ONLY_PROMPT } from "../dist/commands/generate.js";

const invocation = getInvocation({
  provider: "antigravity",
  prompt: "fixture",
  cwd: "/tmp/webmcpify-agent-fixture",
  saveTo: "/tmp/generate-fixture.json",
});

const modeIndex = invocation.args.indexOf("--mode");
assert.notEqual(modeIndex, -1, "Antigravity generation must select an execution mode");
assert.equal(invocation.args[modeIndex + 1], "accept-edits");
assert.match(GENERATE_ONLY_PROMPT, /Do not output a unified diff/);
assert.match(GENERATE_ONLY_PROMPT, /text-only proposal is not a completed task/);
const failureFixture = await mkdtemp(path.join(os.tmpdir(), "webmcpify-agent-redaction-"));
const fakeProvider = path.join(failureFixture, "fake-provider.mjs");
const failedTrajectory = path.join(failureFixture, "failed.json");
const secretPrompt = "PRIVATE_PROMPT_WITH_SOURCE_CODE const secret = 42;";
const secretStderr = "PRIVATE_PROVIDER_STDERR_WITH_CODE";
const previousOpenCodeBin = process.env.WEBMCPIFY_OPENCODE_BIN;
const terminalErrors = [];
const originalConsoleError = console.error;

try {
  await writeFile(
    fakeProvider,
    `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(secretStderr)} + " " + process.argv.join(" "));
process.exit(7);
`,
  );
  await chmod(fakeProvider, 0o755);
  process.env.WEBMCPIFY_OPENCODE_BIN = fakeProvider;
  console.error = (...values) => terminalErrors.push(values.map(String).join(" "));

  await assert.rejects(
    runAgent({
      provider: "opencode",
      prompt: secretPrompt,
      cwd: failureFixture,
      saveTo: failedTrajectory,
      trajectoryMetadata: { role: "generate" },
    }),
    (error) => {
      assert.match(error.message, /opencode generate agent failed/);
      assert.doesNotMatch(error.message, /PRIVATE_PROMPT|PRIVATE_PROVIDER_STDERR|const secret/);
      return true;
    },
  );
  const terminalText = terminalErrors.join("\n");
  assert.doesNotMatch(terminalText, /PRIVATE_PROMPT|PRIVATE_PROVIDER_STDERR|const secret/);
  const preserved = await readFile(failedTrajectory, "utf8");
  assert.match(preserved, /PRIVATE_PROVIDER_STDERR_WITH_CODE/);
} finally {
  console.error = originalConsoleError;
  if (previousOpenCodeBin === undefined) delete process.env.WEBMCPIFY_OPENCODE_BIN;
  else process.env.WEBMCPIFY_OPENCODE_BIN = previousOpenCodeBin;
  await rm(failureFixture, { recursive: true, force: true });
}

console.log("Agent invocation, generation prompt, and terminal redaction verification passed");
