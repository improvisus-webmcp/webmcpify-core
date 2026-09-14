# Contributing to WebMCPify Core

Contributions that improve compatibility, safety, verification, accessibility, provider support, or developer experience are welcome.

## Make a pull request

1. Open an issue for substantial behavior or architecture changes. Small fixes can go directly to a pull request.
2. Fork `improvisus-webmcp/webmcpify-core` and create a focused branch.
3. Install dependencies with `pnpm install`.
4. Make one scoped change. Do not commit `.env`, `.webmcpify/`, `dist/`, temporary workspaces, or generated trajectories.
5. Add or update a self-contained verification script under `scripts/` when behavior changes.
6. Run:

   ```bash
   pnpm typecheck
   pnpm test
   pnpm audit --prod
   npm pack --dry-run
   git diff --check
   ```

7. Update `CHANGELOG.md` for user-visible behavior.
8. Open the pull request with the problem, the change, its safety impact, and the verification performed.

Keep pull requests small enough to review. Generated WebMCP code must remain grounded in discovered application behavior, preserve the human approval boundary, and include independent verification.

Report security issues privately to `support@improvisus.tech`; do not open a public issue containing exploit details or sensitive data.

## Maintainer release

The package name and public access setting are already defined in `package.json`. A publisher must belong to the `improvisus` npm organization with write access and satisfy npm's publishing authentication requirements.

```bash
npm login
npm whoami
npm run prepublishOnly
npm pack --dry-run
npm publish --access public
```

After the first release, update `version` before each later release; npm package versions cannot be reused. `npm run release` runs the final publish command and triggers the same lifecycle checks.
