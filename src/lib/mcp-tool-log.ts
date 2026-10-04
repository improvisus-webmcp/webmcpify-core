/** Restrict public diagnostics to bounded identifiers, never tool inputs/results. */
export function mcpDiagnosticName(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_:@/.-]{1,160}$/.test(value) ? value : "[withheld-name]";
}

/** Codex events are attempted calls, not independent proof of execution. */
export function logProviderMcpToolEvent(event: unknown, taskId: unknown): void {
  if (!event || typeof event !== "object") return;
  const record = event as { type?: unknown; item?: { type?: unknown; server?: unknown; tool?: unknown; status?: unknown } };
  if (!["item.started", "item.completed"].includes(String(record.type)) || record.item?.type !== "mcp_tool_call") return;
  const status = ["in_progress", "completed", "failed"].includes(String(record.item.status)) ? record.item.status : "unknown";
  console.log(`[codex] task=${mcpDiagnosticName(taskId)} MCP attempt ${record.type === "item.started" ? "started" : "completed"}: server=${mcpDiagnosticName(record.item.server)}, method=${mcpDiagnosticName(record.item.tool)}, status=${status}; arguments/results withheld`);
}
