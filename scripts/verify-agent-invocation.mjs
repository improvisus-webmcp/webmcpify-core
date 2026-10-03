import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { getInvocation, publicProviderFailureGuidance, runAgent } from "../dist/lib/agent.js";
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
const previousClaudeBin = process.env.WEBMCPIFY_CLAUDE_BIN;
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

  // Only terminal error events may produce fixed actionable hints. Provider
  // messages, secrets, echoed argv and warning items must stay private.
  for (const [message, hint] of [
    ["The 'private-model' model is not supported when using Codex with a ChatGPT account.", /rejected the configured model/],
    ["You've hit your usage limit.", /usage or capacity limit/],
    ["Authentication failed: invalid API key.", /authentication failed/],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", /authentication failed/],
    ["stream disconnected before completion", /provider connection/],
  ]) {
    const diagnosticProvider = await fixtureProvider(failureFixture, "codex-diagnostic", `
console.log(JSON.stringify({type:'item.completed',item:{type:'assistant_message',text:${JSON.stringify(secretPrompt)}}}));
console.log(JSON.stringify({type:'turn.failed',error:{message:${JSON.stringify(message + " " + secretStderr)}}}));
process.stderr.write(process.argv.join(' ')); process.exit(1);
`);
    process.env.WEBMCPIFY_CODEX_BIN = diagnosticProvider;
    await assert.rejects(runAgent({ provider: "codex", prompt: secretPrompt, cwd: failureFixture, saveTo: failedTrajectory }), error => {
      assert.match(error.message, hint);
      assert.match(publicProviderFailureGuidance(error), hint);
      assert.doesNotMatch(publicProviderFailureGuidance(new Error(`Command failed: ${error.message}`)), hint, "Echoed arguments cannot create provider guidance");
      assert.doesNotMatch(inspect(error), /private-model|PRIVATE_PROMPT|PRIVATE_PROVIDER_STDERR|const secret/);
      return true;
    });
  }
  const misleadingProvider = await fixtureProvider(failureFixture, "codex-warning", `
console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'model is not supported'}}));
process.stderr.write('usage limit '+process.argv.join(' ')); process.exit(1);
`);
  process.env.WEBMCPIFY_CODEX_BIN = misleadingProvider;
  await assert.rejects(runAgent({ provider: "codex", prompt: secretPrompt, cwd: failureFixture, saveTo: failedTrajectory }), error => {
    assert.doesNotMatch(error.message, /rejected the configured model|capacity limit|PRIVATE_PROMPT/);
    return true;
  });
  const authGuidance = "Codex authentication failed. Sign in to the CLI, then retry.";
  const timeoutGuidance = "The coding provider exceeded its configured time limit. Retry or adjust its Core timeout setting.";
  assert.equal(publicProviderFailureGuidance(new Error(`The antigravity generate-coverage agent timed out. ${secretPrompt}`)), ` ${timeoutGuidance}`, "Coverage timeout guidance must remain actionable without echoing the provider prompt");
  for (const prefix of [
    "Generated tool/task metadata could not be safely corrected after one attempt.",
    "Generated capabilities could not be fully accounted for after one completion.",
  ]) {
    assert.equal(publicProviderFailureGuidance(new Error(`${prefix} ${authGuidance} ${secretPrompt}`)), ` ${authGuidance}`, "Correction wrappers preserve fixed guidance, not private diagnostics");
    assert.equal(publicProviderFailureGuidance(new Error(`${prefix} ${timeoutGuidance} ${secretPrompt}`)), ` ${timeoutGuidance}`, "Correction wrappers preserve fixed timeout guidance");
  }
  const flatFailure = await fixtureProvider(failureFixture, "codex-flat-failure", `
console.log(JSON.stringify({type:'turn.failed',message:'401 Unauthorized'})); process.exit(1);
`);
  process.env.WEBMCPIFY_CODEX_BIN = flatFailure;
  await assert.rejects(runAgent({ provider: "codex", prompt: secretPrompt, cwd: failureFixture, saveTo: failedTrajectory }), /Codex authentication failed/);
  for (const [provider, output] of [
    ["codex", {type:"turn.failed", error:{message:"401 Unauthorized"}}],
    ["claude", {type:"result", subtype:"error_max_turns", is_error:true, result:secretPrompt}],
  ]) {
    const zeroExitFailure = await fixtureProvider(failureFixture, "zero-exit-failure", `console.log(${JSON.stringify(JSON.stringify(output))});`);
    process.env[`WEBMCPIFY_${provider.toUpperCase()}_BIN`] = zeroExitFailure;
    await assert.rejects(runAgent({provider, prompt:secretPrompt, cwd:failureFixture, saveTo:failedTrajectory}), error => {
      assert.match(error.message, /agent failed/);
      assert.doesNotMatch(error.message, /PRIVATE_PROMPT|const secret/);
      return true;
    }, "A terminal provider failure cannot be successful merely because the process exits zero");
  }
  for (const [provider, output] of [
    ["codex", `${JSON.stringify({type:"turn.failed"})}\n${JSON.stringify({type:"turn.completed"})}`],
    ["claude", JSON.stringify({type:"result", subtype:"success", is_error:false, result:"fixture completed"})],
  ]) {
    const recovered = await fixtureProvider(failureFixture, "recovered-provider", `process.stdout.write(${JSON.stringify(output)});`);
    process.env[`WEBMCPIFY_${provider.toUpperCase()}_BIN`] = recovered;
    await runAgent({provider, prompt:secretPrompt, cwd:failureFixture, saveTo:failedTrajectory});
  }

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
  if (previousClaudeBin === undefined) delete process.env.WEBMCPIFY_CLAUDE_BIN; else process.env.WEBMCPIFY_CLAUDE_BIN = previousClaudeBin;
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  await rm(failureFixture, { recursive: true, force: true });
}

console.log("Agent invocation passed: relative executable paths, standalone Codex discovery, working-directory/interpreter/config diagnostics, and terminal redaction");
