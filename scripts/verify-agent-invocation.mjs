import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { getInvocation, runAgent } from "../dist/lib/agent.js";
import { GENERATE_ONLY_PROMPT } from "../dist/commands/generate.js";
import { fixtureProvider } from "./fixture-provider.mjs";
import { executableOnPath, findCodexExecutable } from "../dist/lib/executables.js";

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
const failedTrajectory = path.join(failureFixture, "failed.json");
const secretPrompt = "PRIVATE_PROMPT_WITH_SOURCE_CODE const secret = 42;";
const secretStderr = "PRIVATE_PROVIDER_STDERR_WITH_CODE";
const previousOpenCodeBin = process.env.WEBMCPIFY_OPENCODE_BIN;
const previousCodexBin = process.env.WEBMCPIFY_CODEX_BIN;
const previousGeminiBin = process.env.WEBMCPIFY_GEMINI_BIN;
const previousPath = process.env.PATH;
const terminalErrors = [];
const originalConsoleError = console.error;

try {
  const fakeProvider = await fixtureProvider(
    failureFixture, "fake-provider",
    `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(secretStderr)} + " " + process.argv.join(" "));
process.exit(7);
`,
  );
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

  const options = { provider: "opencode", prompt: secretPrompt, cwd: failureFixture, saveTo: path.join(failureFixture, "launch-failure.json") };
  await assert.rejects(runAgent({ ...options, cwd: path.join(failureFixture, "missing-cwd") }), (error) => {
    assert.match(error.message, /provider working directory is missing/);
    assert.doesNotMatch(error.message, /Could not find|PRIVATE_PROMPT/);
    return true;
  });
  process.env.WEBMCPIFY_OPENCODE_BIN = path.join(failureFixture, "missing-provider");
  await assert.rejects(runAgent(options), (error) => {
    assert.match(error.message, /Could not find the opencode CLI executable/);
    assert.equal(error.cause, undefined, "A public error cause must not leak private subprocess argv");
    assert.doesNotMatch(inspect(error), /PRIVATE_PROMPT/);
    return true;
  });

  // ENOENT while reading provider configuration is not an absent executable.
  process.env.WEBMCPIFY_GEMINI_BIN = fakeProvider;
  await assert.rejects(runAgent({ ...options, provider: "gemini", mcpConfig: path.join(failureFixture, "missing-config.json") }), (error) => {
    assert.match(error.message, /gemini .*agent failed/);
    assert.doesNotMatch(error.message, /Could not find|PRIVATE_PROMPT/);
    return true;
  });
  if (process.platform !== "win32") {
    const broken = path.join(failureFixture, "broken-launcher");
    await writeFile(broken, "#!/nonexistent-webmcpify-fixture-interpreter\n");
    await chmod(broken, 0o755);
    process.env.WEBMCPIFY_OPENCODE_BIN = broken;
    await assert.rejects(runAgent({ ...options, saveTo: path.join(failureFixture, "interpreter-failure.json") }), /executable exists but could not be launched/);
  }
  const relativeProvider = await fixtureProvider(failureFixture, "relative-provider", "process.stdout.write(JSON.stringify({result:'fixture complete'}));");
  process.env.PATH = `${path.relative(process.cwd(), failureFixture)}${path.delimiter}${previousPath ?? ""}`;
  assert.equal(executableOnPath(path.basename(relativeProvider)), relativeProvider, "Resolve relative PATH entries before changing subprocess cwd");
  process.env.WEBMCPIFY_OPENCODE_BIN = path.basename(relativeProvider);
  await runAgent({ ...options, saveTo: path.join(failureFixture, "relative-success.json") });
  process.env.WEBMCPIFY_CODEX_BIN = path.relative(process.cwd(), relativeProvider);
  assert.equal(findCodexExecutable(), relativeProvider, "Relative overrides must resolve outside the disposable workspace");
  delete process.env.WEBMCPIFY_CODEX_BIN;
  process.env.PATH = failureFixture;
  const standalone = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const { access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  if (await access(standalone, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) {
    assert.equal(findCodexExecutable(), standalone, "Find the standalone Codex installation without a PATH entry");
  }
  assert.doesNotMatch(terminalErrors.join("\n"), /PRIVATE_PROMPT|PRIVATE_PROVIDER_STDERR|const secret/);
} finally {
  console.error = originalConsoleError;
  if (previousOpenCodeBin === undefined) delete process.env.WEBMCPIFY_OPENCODE_BIN;
  else process.env.WEBMCPIFY_OPENCODE_BIN = previousOpenCodeBin;
  if (previousCodexBin === undefined) delete process.env.WEBMCPIFY_CODEX_BIN; else process.env.WEBMCPIFY_CODEX_BIN = previousCodexBin;
  if (previousGeminiBin === undefined) delete process.env.WEBMCPIFY_GEMINI_BIN; else process.env.WEBMCPIFY_GEMINI_BIN = previousGeminiBin;
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  await rm(failureFixture, { recursive: true, force: true });
}

console.log("Agent invocation passed: relative executable paths, standalone Codex discovery, working-directory/interpreter/config diagnostics, and terminal redaction");
