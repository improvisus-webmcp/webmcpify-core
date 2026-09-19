# Context Maintenance

- Keep project truth in Git.
- Add source-backed facts to feature `FACTS.jsonl` files.
- Directly edit feature `FACTS.jsonl` files when that is clearest.
- Use `barry-cache fact draft --route "<route>" --prefix "<PREFIX>" ...` to generate a schema-checked JSONL fact row; add `--write` only when you intentionally want Barry to append it.
- `fact draft` is an authoring guardrail, not broad canonical CRUD; review the resulting diff.
- Use ISO 8601 timestamps in fact `updated_at` values when saving new facts.
- Use collision-resistant fact IDs like `REV-20260526T160512Z-a8f3`.
- Use `barry-cache adr new --title "<decision>"` for decisions that change architecture.
- Reference ADR files from decision facts through the fact `src` array.
- Treat `.context-state/` as operational memory, not canonical truth.
- Run `barry-cache validate` after context changes.

## Save an agent session

When a Codex, Claude, Cursor, Copilot, Gemini, or other agent session contains useful project memory, ask the agent to save it into Barry Cache using this policy:

```text
Save this session to Barry Cache.

Rules:
1. Record the session outcome with barry-cache finalize.
2. If user validation showed previous work was wrong, first record it with barry-cache failure record and link the follow-up finalize with --fixes.
3. Promote only source-backed implementation facts into docs/context/features/*/FACTS.jsonl.
4. Use fact draft for schema-checked JSONL drafts/appends when helpful, or edit FACTS.jsonl directly for canonical facts.
5. Put uncertain notes, blockers, and next steps in operational memory, not canonical facts.
6. Update IDMAP.md or KG.adj only when new source IDs or relationships are needed.
7. Run barry-cache validate before finishing.
```

Recommended command for the session outcome:

```bash
barry-cache finalize --status success --summary "<what changed or what was learned>" --files "path-a,path-b"
```

Recommended command when user validation contradicts a previous handoff or fact:

```bash
barry-cache failure record --summary "<what failed>" --expected "<expected behavior>" --actual "<observed behavior>" --challenges "<handoff-or-fact-id>"
```
