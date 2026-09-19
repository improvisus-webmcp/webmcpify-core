# Architecture Decision Records

ADRs explain why durable architectural decisions exist. Keep them short, source-backed, and linked from feature facts when a decision affects implementation behavior.

Use:

```bash
barry-cache adr new --title "<decision>"
barry-cache adr list
```

Facts can reference ADRs with `src: ["docs/context/adrs/ADR-0001-example.md"]`. Barry can then route, search, load, and review the decision together with the facts it supports.
