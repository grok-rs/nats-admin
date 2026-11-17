# Development & publishing

## Develop

```bash
npm install
npm run watch            # esbuild in watch mode
# press F5 in VS Code ("Run Extension") to launch a development host
```

| Script | What it does |
| --- | --- |
| `npm run build` | Bundles `dist/extension.js` and `dist/webview/*.js` |
| `npm run typecheck` | `tsc --noEmit` over src, webviews and tests |
| `npm test` | Unit tests plus live tests against throwaway `nats-server` processes (needs `nats-server` on `PATH`) |
| `npm run test:integration` | Runs the extension inside VS Code against a throwaway server (uses `/usr/share/code/code`, or set `VSCODE_EXECUTABLE`; briefly opens a window) |
| `npm run package` | Production build plus `nats-admin-<version>.vsix` |

To preview a webview with mocked data, run `npm run build && node scripts/harness.mjs <name>` and open the printed URL. Names: home, overview, dashboard, streamDashboard, health, topology, cluster, kvBrowser, messageBrowser, consumerLab, liveTail, publisher, deadLetters, plan, connectionEditor. The design-system gallery is `test/harness/gallery.tsx`.

## Publish to the Visual Studio Marketplace

1. **Create a publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create a publisher. Its ID is permanent.
2. **Create a Personal Access Token.** In Azure DevOps (<https://dev.azure.com>) go to *User settings → Personal access tokens → New token*:
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined → Marketplace → Manage**
3. **Update `package.json`:**
   - `"publisher"`: your publisher ID (set to `grok-rs`);
   - `"repository"`, `"bugs"`, `"homepage"`: your public repository. vsce uses `repository` to turn the README's relative image links (`docs/images/*.png`) into absolute URLs, so the screenshots must be pushed to that repository's default branch;
   - optionally the copyright holder in `LICENSE`.
4. **Log in and publish:**

   ```bash
   npx vsce login <publisher-id>     # paste the PAT
   npm run package                   # inspect the .vsix first if you like
   npx vsce publish                  # or: npx vsce publish minor
   ```

   You can also upload the `.vsix` by hand on the publisher management page.
5. **Open VSX (optional, for VSCodium / Cursor / Gitpod):** create a token at <https://open-vsx.org>, then run `npx ovsx create-namespace <publisher-id> -p <token>` and `npx ovsx publish nats-admin-<version>.vsix -p <token>`.

### Pre-release checklist

- [ ] `npm run typecheck && npm test && npm run test:integration` all green
- [ ] `CHANGELOG.md` updated and `version` bumped
- [ ] Screenshots in `docs/images/` are current and pushed
- [ ] `npx vsce ls` shows only runtime files: `dist/`, `media/`, `syntaxes/`, `schemas/`, README, CHANGELOG, LICENSE
- [ ] Install the `.vsix` locally (`code --install-extension …`) and smoke-test against a real server
