import assert from "node:assert/strict";
import { logProviderMcpToolEvent, mcpDiagnosticName } from "../dist/lib/mcp-tool-log.js";

const originalLog = console.log;
const logs = [];
try {
  console.log = (line) => logs.push(line);
  for (const type of ["item.started", "item.completed"]) {
    logProviderMcpToolEvent({
      type,
      item: {
        type: "mcp_tool_call", server: "chrome-devtools", tool: "call_webmcp_tool",
        status: type === "item.started" ? "in_progress" : "completed",
        arguments: { input: "PRIVATE_ARGUMENTS" }, result: "PRIVATE_RESULT",
        error: "PRIVATE_ERROR", text: "PRIVATE_PROMPT",
      },
    }, "login-enables-checkout");
  }
  assert.equal(logs.length, 2);
  assert.match(logs[0], /task=login-enables-checkout.*server=chrome-devtools.*method=call_webmcp_tool/);
  assert.match(logs[1], /completed.*status=completed/);
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_/);
  logProviderMcpToolEvent({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE_PROMPT" } }, "task");
  assert.equal(logs.length, 2, "Agent messages must not be echoed");
  assert.equal(mcpDiagnosticName("list_webmcp_tools"), "list_webmcp_tools");
  assert.equal(mcpDiagnosticName("invalid\nPRIVATE_PROMPT"), "[withheld-name]");
  assert.equal(mcpDiagnosticName("x".repeat(161)), "[withheld-name]");
  assert.equal(mcpDiagnosticName({ prompt: "PRIVATE_PROMPT" }), "[withheld-name]");
} finally {
  console.log = originalLog;
}
console.log("MCP tool logging passed: identifiers and lifecycle only; inputs, results, errors and agent text withheld.");
