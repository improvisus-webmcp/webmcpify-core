# Product requirements

## User

A web developer maintaining a new or existing application.

## Outcome

The developer gives the agent a repository and running URL. The agent discovers grounded actions, drafts WebMCP tools, audits them, requests human review, applies only the approved patch, and independently verifies the result.

## Requirements

- Strands Agents SDK must own the agent loop.
- Core must be consumed through its MCP server.
- The agent must expose the exact Core tools it can call.
- Consequential source changes must stop for human approval outside model control.
- Apply must remain bound to the approved patch identifier.
- The final response must distinguish verified results from incomplete or failed stages.
- Existing Core users must not be forced to install Strands or move from Node 20.

