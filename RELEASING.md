# Releasing

## First release (manual, from your machine)

```bash
npm login                 # opens the browser; use your npm account
npm publish --access public
```

`prepublishOnly` builds and runs the full test suite first, so a broken build can't be published.
After publishing, check https://www.npmjs.com/package/k11-playwright-qa-mcp and run:

```bash
npx -y k11-playwright-qa-mcp --version
```

## Later releases (automated)

1. On npmjs.com, create a granular access token with publish rights for this package.
2. In GitHub: Settings → Secrets and variables → Actions → New repository secret, named `NPM_TOKEN`.
3. Bump the version and push a tag:

```bash
npm version patch         # updates package.json and creates tag vX.Y.Z
git push && git push --tags
```

The Release workflow checks that the tag matches `package.json`, runs the tests, and publishes with npm provenance.
Also bump `version` in `.claude-plugin/plugin.json` and `VERSION` in `src/server.ts` to match.
