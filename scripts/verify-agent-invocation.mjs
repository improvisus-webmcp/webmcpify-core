import assert from "node:assert/strict";
import { getInvocation } from "../dist/lib/agent.js";
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
console.log("Antigravity invocation and generation prompt verification passed");
