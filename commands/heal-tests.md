---
description: Run Playwright tests and repair locators broken by UI changes
argument-hint: [spec file] [page URL]
---

Repair Playwright tests whose locators broke because the UI changed, using the playwright-qa MCP tools.

Input: $ARGUMENTS (optional spec file, optional page URL)

1. Call `run_tests` (for the given spec, if any).
2. For each failure that has a `failingLocator`, find the page URL the test was on (from the test code or the argument) and call `heal_locator`. If the page needs a login or several steps to reach, pass a `session` (a `storage_state` from `save_login_state`, and/or `steps`); check `.qa-mcp/heal.config.json` for one first.
3. Act on the result:
   - `healed`: replace the old locator with `suggestion` in the test file.
   - `needs_review` or `ambiguous`: show the user the candidates, scores and reasons, and ask which one is right before editing.
   - `not_found`: the element may have been removed. Report it; do not invent a locator.
4. Leave failures that are not locator problems untouched and list them separately; they may be real bugs.
5. Re-run the affected specs. When they pass, call `capture_baseline` to refresh fingerprints.

Finish with a table: test, old locator, new locator, confidence, and status.

To do this unattended in CI with a pull request and audit report, use `npx -y k11-playwright-qa-mcp heal-ci --apply` (see the README).
