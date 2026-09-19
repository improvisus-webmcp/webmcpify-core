# Project Context Model

Barry Cache separates canonical context, operational state, and generated caches.

- Canonical context lives in `docs/context/`.
- Optional workspace routing lives in `docs/context/workspaces.json` and maps module paths to canonical feature packs.
- Operational continuity lives in `.context-state/`.
- Generated retrieval data lives in `.context-cache/`, including the disposable parsed context index.
