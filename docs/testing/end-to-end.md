# End-to-end test guide

Use a development/staging app with disposable data. Provider commands may consume
quota. Consequential tasks must not charge real money or modify production accounts.
The automated fixture suite uses no live provider credentials. A passing fixture
suite is not evidence that your live provider, deployment, or Temporal service works.

## 1. Verify Core and install this checkout

From the Core repository:

```bash
cd /home/olumide/Desktop/Webmcpify/webmcpify-packages/public/webmcpify-core
pnpm install
pnpm typecheck
pnpm test
pnpm run verify:browser-state
pnpm run verify:review-browser
pnpm audit --prod
npm pack --dry-run
git diff --check
npm uninstall --global @improvisus/webmcpify-core
npm link
hash -r
command -v webmcpify
webmcpify --version
webmcpify generate --help
```

Expected: checks pass; `generate --help` lists security choices with `balance` as
default. `npm link` uses this checkout's built `dist/`, not an old registry release.
Rebuild with `pnpm build` after later source changes. No `.tgz` is needed for link
testing. To test an actual distributable instead, run `npm pack` and install the
exact archive it prints with `npm install --global ./<printed-filename>.tgz`.
Do not install the unchanged published version expecting unpublished fixes.

On PowerShell omit `hash -r` and use `Get-Command webmcpify`; quote executable paths
containing spaces. Run the same suite on each native OS—Linux success does not prove
Windows/macOS success. Chrome/Chromium and provider executables must be installed.

## 2. Prepare and start the target

Terminal A:

```bash
cd /home/olumide/Desktop/Webmcpify/webmcpify-testing-projects/webmcpify-coffe-store
git status --short
git rev-parse HEAD
pnpm install
pnpm build
pnpm run lint
pnpm dev --host 127.0.0.1
```

Keep this terminal running. Use Vite's printed URL; examples below assume port
5173. Core needs a target Git commit and installed dependencies, but must preserve
your existing changes. Do not blindly commit secrets or reset the target.
Exclude `.webmcpify/` from target Git and deployment. Its directory is already a
Unix dotfolder; Windows visibility differs. Hiding it is not access control.

Terminal B:

```bash
cd /home/olumide/Desktop/Webmcpify/webmcpify-testing-projects/webmcpify-coffe-store
export WEBMCPIFY_CODEX_BIN="$HOME/.local/bin/codex"
codex --version
curl -I http://127.0.0.1:5173
webmcpify discover
```

Only set that Codex override if it exists; otherwise use your real CLI path or
normal PATH discovery. PowerShell equivalent: `$env:WEBMCPIFY_CODEX_BIN = 'C:\path\codex.exe'`.
Expected: discovery reports the correct stack, source inventory, real actions,
and saves local evidence. Dynamic React routes may not appear as static file routes.

## 3. Generate and inspect the draft

```bash
webmcpify generate --provider codex --method auto --no-product-context-prompt
webmcpify security
git status --short
```

Expected: actual build/typecheck preflight passes; security defaults to balanced;
tools/tasks and a patch are proposed; status is awaiting review. Your target source
is unchanged. Generation does not require the development server, but `run`, browser
testing, and baseline do. Stopping at awaiting review is intentional.

Check the review UI in the next step for:

- All proposals map to real handlers/state; every proposed tool has test coverage.
- Successful tasks establish their prerequisites; negative tasks preserve the unmet
  condition and specify an exact error plus an unchanged-state verification.
- An empty cart/logged-out checkout and removing an absent item can pass only as
  expected-rejection tests. Network failures, crashes, or completed forbidden actions
  must fail. A rejected action never counts as a completed purchase/removal.
- No `.serena`, `.tgz`, secrets, target runtime state, unrelated refactors, invented
  backend controls, or dead integration files in the source patch.
- Public docs, README, one root AGENTS.md, loaded styles, and accessible status are
  in the same reviewable patch. JavaScript targets must not acquire TypeScript syntax
  or a new tsconfig solely for WebMCP.

## 4. Test review, rejection, and partial selection

```bash
webmcpify review --port 4173
```

Open the exact localhost URL printed by Core. Confirm project name and repository
folder. Inspect tools, tasks, security, and source changes.
Tasks and tool contracts must be view-only: no task checkboxes or JSON editors.
Expand/collapse each section. The file inventory must list every changed path,
including changes beyond ten files, its change type, and a reason (or an explicit
unknown-purpose warning). Inspect the exact diff, not just those summaries.
With all tools selected, approval must be disabled until the larger source-patch
checkbox is checked. Uncheck it again: approval must become disabled. A direct
HTTP request without consent is rejected too. Reduced-tool draft preparation is
not approval of the old patch; after revision, source consent starts unchecked.

For a partial-approval test, uncheck one tool while keeping at least one selected.
Continue. Expected: controls lock immediately and a progress page appears. Other
open tabs lock too; refresh during revision must show only progress, not editable
controls. The original coding provider creates a revised patch in a
disposable workspace; rejected registrations and retained-only docs/tests are
reconciled; the page automatically reopens for fresh review. Remove another tool
and repeat if at least one remains. No approval/application happens
automatically. Confirm rejected registrations are actually absent, while original
human handlers still exist. Every remaining proposed tool still has coverage.
If the provider fails, expect a safe error and a retryable review page, never raw
prompt/code output or automatic approval. The original pending patch remains intact.

Approve the revised source checkbox and proceed to confirmation. Check the space
above Confirm Approval/Cancel. Cancel returns to review without approval. Confirm
only after checking the exact revised patch. Old tabs/forms cannot approve a new
draft. Zero selected tools are rejected, not an automatic approval.
After confirmation, the CLI shows approval-saving activity. Standalone `review`
finishes with next-step instructions; `run` continues to apply/build and browser
tasks, with activity indicators and per-task counters. Allow several minutes;
these are phase/elapsed-time indicators, not completion-percentage estimates.
Open the two top summary cards individually: the other card must remain closed
and keep its closed height. Review shutdown displays closing activity and must
not hang on incomplete requests from old tabs; confirmation remains persisted.

To test whole-draft rejection instead, click Reject in a separate disposable run.
Expected: no target source change; apply refuses that rejected draft. Regenerate
before continuing. Occupied ports fall back; 20 unavailable ports produce a clear
`--port` message. Ctrl+C cancels review without approving.

## 5. Optional baseline before application

After approval creates the fixed task set, but before apply:

```bash
webmcpify baseline --url http://127.0.0.1:5173 --provider codex
```

Keep the server running. This one-shot baseline can use the existing UI or existing
WebMCP tools; it is not necessarily a UI-only baseline. It verifies each task on its
acted-on tab. The advanced final evaluation includes the separate UI-only comparison.

## 6. Apply and check the application

```bash
webmcpify apply
pnpm build
pnpm run lint
git diff --stat
```

Expected: only the exact approved source patch applies, with build checks passing.
Generated docs are now real files outside `.webmcpify`. Unapproved, changed, stale,
or tampered drafts must refuse application. Test those failure cases only in a
throwaway fixture/clone; do not damage the real app to test rollback.

Run normal human flows: filtering, selecting, adding/removing items, validation,
navigation, and safe checkout guards. Existing functionality must remain intact.
Inspect browser console for import/registration errors, duplicate registrations,
stale state, lifecycle leaks, and inaccessible controls.

## 7. Browser agents, feedback, and independent scoring

```bash
webmcpify test --url http://127.0.0.1:5173 --provider codex
webmcpify eval
```

Expected: only approved tools are in the agent workflow; every fixed task is tested;
observable state is independently checked on the same tab. Rejected tools must not
remain registered by the revised source. An expected rejection needs matching tool/
error evidence and a passing unchanged-state postcondition. Unrelated errors fail.

Use a compatible WebMCP browser to inspect live tool availability on relevant pages.
For declarative forms, inspect `toolname`/`tooldescription`, loaded CSS, visible
agent-active outline, readable status/live region, cancellation/reset behavior,
and real success/error feedback. Imperative callbacks must report pending/outcomes
and clear pending in `finally`. Test route changes and React remounts for duplicates.
Without browser WebMCP support, the ordinary human interface must still work.

Core manages an isolated headless browser when no CDP endpoint is available. For
manual visual checks, use a separate test profile with a compatible browser—not
your personal signed-in browser exposed to remote debugging. Override executable
or CDP endpoint only when needed using documented environment variables.

## 8. Public discovery/GEO/AEO checks

```bash
curl -i http://127.0.0.1:5173/llms.txt
curl -i http://127.0.0.1:5173/webmcp.md
curl -i http://127.0.0.1:5173/webmcp.html
curl -i http://127.0.0.1:5173/robots.txt
```

Check bodies and content types, not just HTTP 200: SPA fallback HTML can masquerade
as a successful text request. Use `/webmcp-capabilities.html` if owner HTML caused
the alternate filename; if both filenames were owner-authored, follow the checklist
instead. Public reference HTML must contain actual descriptions without requiring JS.

Read target `README.md`, `AGENTS.md`, and `docs/webmcp-readiness.md`. Confirm attribution,
identity, retained-only capabilities, private-data omission, and owner sections.
Preserve crawler opt-outs and named groups. No blanket training opt-in or private
route allowances should appear. If a framework metadata route owns robots, test that
route—Core does not add a conflicting static file.

On a real deployment, repeat HTTP checks and link the capability page from appropriate
navigation/help pages. Use real canonical/sitemap URLs and review CDN/WAF/crawl logs
and search eligibility. llms.txt is optional; these checks cannot prove GPT/Claude
indexing, citations, recommendations, or ranking.

## 9. Security modes, generation methods, and providers

Use separate disposable target copies for repeated draft variants:

```bash
webmcpify generate --provider codex --security strict --method auto --no-product-context-prompt
webmcpify security --strict
webmcpify generate --provider codex --security ignore --method auto --no-product-context-prompt
```

Check that standalone `security --strict` writes `"policy": "strict"` in the
security report and fails on blocking findings; without the flag it uses balance.

Strict reversible UI state must not require invented backend authentication,
identity, replay, or quota enforcement; applicable backend/consequential guards must
remain. Ignore skips automated gating but never removes exact-patch human approval.
Review preserves the draft's recorded policy. Regeneration replaces pending draft
state, so do not run these variants while another draft is being reviewed.

Also try `--method declarative` on real forms and `--method imperative` on real
actions. Test optional `--product-context 'Describe real functionality here'`; omit
`--no-product-context-prompt` to test interactive context. Context is support, not
permission to invent capabilities.

Repeat a safe fixture workflow with each installed/authenticated provider:
`codex`, `agy`/`antigravity`, `claude`, `gemini`, and `opencode`. Inspect each provider's
own help/login/quota first. One provider's success does not prove the others work.

## 10. Failures and plain repair

In a disposable target, point `WEBMCPIFY_CODEX_BIN` at an intentionally missing path
and generate. Expected: clear installation/path message; no prompt/code dump; no
target source changes. Restore/unset the override afterwards. Similarly test an
invalid `WEBMCPIFY_PACKAGE_MANAGER` with installed target dependencies: validation
should explain environment setup and not ask the LLM to rewrite source.

The focused checks `pnpm run verify:agent`, `verify:runtime`, `verify:patch`,
`verify:review`, and `verify:partial-review` cover redaction, launch errors, source
identity, rollback, double confirmation, and rejected-tool reconciliation safely.

After a genuine failed approved browser task:

```bash
webmcpify repair --no-durable --provider codex
webmcpify review
webmcpify apply
webmcpify test --url http://127.0.0.1:5173 --provider codex
webmcpify eval
```

Repair must use failure evidence and preserve approved task criteria. It cannot
change task definitions or silently approve a fix. If no tasks failed, a repair is
not needed. Keep reports private; do not paste trajectories or prompts publicly.

## 11. Full normal workflow and MCP

On another clean/disposable app copy, with server running:

```bash
webmcpify run --url http://127.0.0.1:5173 --provider codex --no-product-context-prompt
```

Expected stages: discover/draft → human review → apply/build → test/independent
verification. It intentionally waits for review; rejection stops before apply.

Run `pnpm run test:mcp` in Core for a real stdio protocol smoke test. Configure your
agent client using the README MCP example; for this local build use the absolute
Core `dist/mcp/server.js` path with command `node` and target-project `cwd`, not
registry `npx` which might fetch an older release. Confirm tools list, repository
analysis, and confined path behavior. Generate still needs review before apply;
apply requires the exact matching patch identifier. Bare `webmcpify-mcp` waiting
for stdin is expected, not an interactive UI or a hang.

## 12. Optional Temporal and advanced evaluation

First run `pnpm run verify:temporal-optional` in Core. It recreates an isolated
production package with no Temporal peers and tests CLI/MCP startup plus clear
Temporal installation errors. Do not delete your real node_modules to test this.

Live durable tests require compatible optional peers, a Temporal service, provider,
running target, and WebMCP browser. A linked Core checkout already has the SDKs as
dev dependencies. A production install needs optional peers in its resolvable
installation. Native SDK compatibility must be checked separately on each OS.

Install the [Temporal CLI](https://docs.temporal.io/cli) first. Terminal C:

```bash
temporal server start-dev
```

Terminal D:

```bash
cd /home/olumide/Desktop/Webmcpify/webmcpify-packages/public/webmcpify-core
pnpm run temporal:worker
```

Expected: worker connects to the same address, namespace, and queue used by the
workflow client. Defaults are localhost:7233, default, and webmcpify. Set matching
`WEBMCPIFY_TEMPORAL_*` variables in both terminals for custom configurations; keep
TLS/API keys private. Local Temporal UI defaults to http://localhost:8233.

Terminal B, using an actual failed approved task ID from the review/task set:

```bash
webmcpify repair --durable --url http://127.0.0.1:5173 --task YOUR_APPROVED_TASK_ID --provider codex --max-repairs 3
```

The uppercase ID is a placeholder; replace it before running. Observe workflow/
activity status in Temporal UI, human review, application, retest, and attempt bound.
Durable/repair reviews preserve their fixed tools/tasks; they cannot partially
rewrite the task set mid-workflow. On a disposable test only, interrupt/restart a
worker and verify recovery without duplicate consequential actions. Live crash
recovery is not certified by the ordinary fixture tests.

Advanced comparison:

```bash
webmcpify final-eval --url http://127.0.0.1:5173 --provider codex
```

This includes UI-only baseline, WebMCP, and durable repair comparison and may require
additional human review. It is not a Temporal-free command. If no service/SDKs are
installed, use normal `test`, `eval`, and plain `repair` instead.

## 13. After testing

Keep `.webmcpify` ignored/private while you need review identity, evaluations,
rollback evidence, or durable resumption. Do not auto-delete it after every run.
Deleting it deliberately loses that local history and approval state; regenerate/
review before future application as necessary. Keep public discovery documents and
the root AGENTS.md/README: these are reviewed integration source, not disposable logs.

Stop test servers/workers/browser profiles when finished. Record exact package
commit, provider, native OS, browser version, and failures for reproducible reports;
omit credentials and raw provider trajectories.
