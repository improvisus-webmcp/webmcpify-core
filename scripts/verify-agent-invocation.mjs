import assert from "node:assert/strict";
import { getInvocation } from "../dist/lib/agent.js";

const invocation = getInvocation({
  provider: "antigravity",
  prompt: "fixture",
  cwd: "/tmp/webmcpify-agent-fixture",
  saveTo: "/tmp/generate-fixture.json",
});

const modeIndex = invocation.args.indexOf("--mode");
assert.notEqual(modeIndex, -1, "Antigravity generation must select an execution mode");
assert.equal(invocation.args[modeIndex + 1], "accept-edits");
console.log("Antigravity invocation verification passed");
