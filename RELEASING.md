# Release Process

**Product:** k11 Playwright QA (MCP server and Claude Code plugin)
**Package:** [`k11-playwright-qa-mcp`](https://www.npmjs.com/package/k11-playwright-qa-mcp) on npm
**Maintainer:** [K11 Software Solutions LLC](https://k11softwaresolutions.com)
**Current release:** v0.2.0 (13 November 2026)

This document describes how K11 Software Solutions versions, tests, publishes and supports releases of k11 Playwright QA. Every release follows the same quality gates, whether it is published automatically or by hand.

---

## Versioning

Releases follow [Semantic Versioning](https://semver.org/):

| Change | Version bump | Example |
|---|---|---|
| Bug fixes and internal improvements that don't change tool behaviour | Patch | 0.1.0 → 0.1.1 |
| New tools, new tool options, new plugin commands; backward compatible | Minor | 0.1.0 → 0.2.0 |
| Removed or renamed tools, changed tool inputs or outputs, changed baseline file format | Major | 0.x → 1.0.0 |

While the product is in 0.x, minor releases may include small breaking changes. Each one is called out in the release notes.

The version number appears in three places and must always match:

- `package.json`: `version`
- `.claude-plugin/plugin.json`: `version`
- `src/version.ts`: `VERSION` (reported to MCP clients and by `--version`)

## Quality gates

A release can only be published when all of these pass:

1. **Build:** TypeScript compiles with strict checks.
2. **Tests:** the full suite passes (unit, real-browser healing and MCP protocol tests).
3. **CI:** the CI workflow passes on Node 20 and 22.
4. **Package contents:** `npm pack --dry-run` lists only the compiled server, the plugin files, the README, the license and `package.json`. No source, tests or secrets.
5. **Version check:** the release tag matches the version in `package.json`.

Gates 1 and 2 run automatically before every publish (`prepublishOnly`), so a broken build cannot reach npm.

## Release checklist

1. Confirm `main` is green in CI.
2. Update the version in all three places listed under Versioning.
3. Add the release to the **Release history** section below.
4. Commit: `Release vX.Y.Z`.
5. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

6. The **Release** workflow verifies the tag, runs the tests and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements), which links each published package to the exact source commit that built it.
7. Create a GitHub Release from the tag, using the release-history entry as the notes.
8. Verify the published package (see below).

### Publishing setup (one time)

Automated publishing needs an npm granular access token with publish rights for `k11-playwright-qa-mcp`, stored as the GitHub repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).

### Manual publish (fallback)

If the automated workflow is unavailable, a maintainer with publish rights can release from a clean checkout of the tagged commit:

```bash
npm ci
npx playwright install chromium
npm login
npm publish --access public
```

## Post-release verification

```bash
npm view k11-playwright-qa-mcp version
npx -y k11-playwright-qa-mcp --version
npx -y k11-playwright-qa-mcp install-browsers
```

Then confirm in a fresh Claude Code session that the plugin installs and lists its tools:

```text
/plugin marketplace add K11-Software-Solutions/k11techlab-playwright-qa-mcp
/plugin install playwright-qa@k11-qa-tools
```

## If a release has a problem

Published npm versions cannot be replaced. Instead:

1. **Deprecate** the faulty version so installs show a warning:

   ```bash
   npm deprecate k11-playwright-qa-mcp@X.Y.Z "Contains <issue>; please upgrade to X.Y.Z+1"
   ```

2. **Fix forward:** publish a patch release with the fix.
3. **Document it** in the release history and the GitHub Release.

`npm unpublish` is reserved for releases that accidentally exposed secrets or other sensitive material.

## Support and security

- **Bugs and feature requests:** [GitHub Issues](https://github.com/K11-Software-Solutions/k11techlab-playwright-qa-mcp/issues)
- **Security issues:** please report privately through [k11softwaresolutions.com/contact](https://k11softwaresolutions.com/contact) rather than in a public issue.
- **Commercial support, training and custom MCP development:** [K11 Software Solutions](https://k11softwaresolutions.com/contact)

---

## Release history

### v0.2.0 (13 November 2026): logged-in pages and healing in CI

**Highlights**

- **Pages behind a login and multi-step flows:** `explore_page`, `check_locator`, `capture_baseline` and `heal_locator` accept a `session` with a saved login (`storage_state`) and up to 25 steps to run before exploring or healing.
- **`save_login_state` tool:** logs in once and saves the session to `.qa-mcp/auth/`, adding that folder to `.gitignore`.
- **Secrets stay out of prompts and logs:** step values can read `${ENV:NAME}`; literal fill values are masked in all output.
- **`heal-ci` command:** runs the suite, heals locator failures against committed baselines, and applies only changes with at least 70% confidence that are clearly ahead of the runner-up. It re-runs the healed tests, reverts any change whose test still fails, writes a Markdown and JSON audit report and sets GitHub Actions outputs.
- **Pull-request workflow:** `docs/heal-locators.yml` runs `heal-ci` on a schedule and opens a pull request whose description is the audit report.
- **Run reports** now include the spec file path and error line for each failure.

**Compatibility:** no breaking changes to existing tools. New optional `session` input on four tools.

### v0.1.0 (13 November 2026): first public release

**Highlights**

- **Verified locators:** `explore_page` and `check_locator` return Playwright locators that match exactly one element on the live page, most stable strategy first.
- **User story to test:** `parse_user_story` turns stories, Gherkin scenarios or acceptance criteria into a Playwright Test skeleton.
- **Guarded test writing and runs:** `write_test` writes only inside `tests/`; `run_tests` runs Playwright without a shell and reports the exact locator a failing test was waiting for.
- **Self-healing locators:** `capture_baseline` and `heal_locator` match broken locators to the intended element using fingerprints, with a confidence score, reasons and a verified replacement. Suggestions are never applied silently.
- **Claude Code plugin:** `/story-to-test` and `/heal-tests` commands, installable from this repository's plugin marketplace.
- **Browser setup:** `npx -y k11-playwright-qa-mcp install-browsers` installs the matching Chromium build.

**Compatibility:** Node.js 20 or later; Playwright 1.65; MCP TypeScript SDK 1.x.

---

k11 Playwright QA is developed by K11 Software Solutions LLC and released under the MIT License.
