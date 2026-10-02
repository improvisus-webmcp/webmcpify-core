/** Produced by Core's MCP boundary, never by parsing an agent's final report. */
export interface WebMcpCallEvidence {
  toolName: string;
  status: "success" | "error";
  error?: string;
}

export interface WebMcpEvidence {
  source: "chrome-devtools-mcp";
  pageId: number;
  discovered: boolean;
  calls: WebMcpCallEvidence[];
  policyViolations: string[];
  infrastructureError?: string;
}
