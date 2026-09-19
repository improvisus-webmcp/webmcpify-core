---
id: ADR-0001
title: Use Barry Cache as canonical project memory
status: active
date: 2026-09-20
supersedes: []
tags: [context, agents]
---

# ADR-0001: Use Barry Cache as canonical project memory

## Context

The repository previously kept durable project history in `.codex/PROJECT_MEMORY.md` while Serena supplied semantic code retrieval. Maintaining a second long-form memory beside Barry would duplicate facts, increase startup context, and allow the two stores to drift.

## Decision

Barry Cache is the sole project-memory system. Reviewed, source-backed facts and decisions live in `docs/context/`; ignored `.context-state/` stores operational handoffs; `.context-cache/` is disposable. Serena remains responsible only for symbol and reference retrieval. New Codex sessions follow `AGENTS.md`, run Barry `resume`, and load only routed context.

## Consequences

The legacy `.codex/PROJECT_MEMORY.md` is removed. Durable implementation changes require fact or ADR updates plus Barry validation; substantial sessions end with `finalize`. Secrets, large diffs, transient output, and duplicate project histories stay out of Barry.
