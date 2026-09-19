# Barry Cache Context

Barry Cache keeps repo context source-backed, validated, and easy for agents to load.

## Reasoning

This directory is the canonical project memory for Barry Cache. It keeps durable implementation context in Git so humans and agents can review the same source-backed facts instead of relying on private assistant memory or stale chat history.

Barry separates three concerns: `docs/context/` is reviewed truth, `.context-state/` is operational session continuity, and `.context-cache/` is disposable retrieval data. Barry stores a parsed context index in `.context-cache/context-index.json` and reuses it while the source context manifest is unchanged. Use this structure to explain existing behavior, route tasks, validate facts, and resume agent work without loading the whole repo.

Large projects can optionally add `docs/context/workspaces.json` to map paths/modules to context routes. Workspace routing is a hinting layer over the same canonical context, not a second memory store.
