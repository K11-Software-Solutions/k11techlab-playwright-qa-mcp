# k11 Playwright QA — MCP server & Claude Code plugin

**Turn user stories into Playwright tests that actually pass, and fix the ones a redesign just broke.**

AI coding assistants write Playwright tests quickly, but they guess selectors. The tests look right, then fail on the first run, or break the next time someone renames a CSS class. This MCP server gives the assistant the facts it can't guess:

- **Verified locators.** It opens the real page and returns locators that match exactly one element, most stable first (`getByTestId`, `getByRole`, `getByLabel`, ...).
- **Story → spec.** It turns "As a… I want… so that…", Gherkin scenarios or acceptance-criteria bullets into a Playwright Test skeleton: one test per scenario, one `test.step` per step.
- **Structured test runs.** It runs Playwright and returns per-test results, including the exact locator a failing test was waiting for.
- **Self-healing locators.** When the UI changes, it finds the element the test meant and suggests a verified replacement with a confidence score and the reasons. It never silently edits your tests.

Works with **Claude Code** (as a plugin with `/story-to-test` and `/heal-tests` commands), **Claude Desktop**, and any other MCP client.

---

## See it heal

The demo app ships in two versions. In v2 a redesign renamed every id, changed the button text from "Sign in" to "Log in", swapped the CSS classes and added a "Continue with Google" button. A test using `page.locator('#login-btn')` fails. `heal_locator` returns (trimmed):

```json
{
  "status": "healed",
  "original": "page.locator('#login-btn')",
  "suggestion": "page.getByRole('button', { name: 'Log in' })",
  "confidence": 0.87,
  "reasons": [
    "name equivalent: \"Sign in\" → \"Log in\"",
    "id similar (50%): \"login-btn\" → \"signin-submit\"",
    "role matches", "type matches", "tag matches",
    "classes similar (64%): \"btn btn-primary\" → \"cta cta-primary\""
  ],
  "candidates": [
    { "locator": "page.getByRole('button', { name: 'Log in' })", "score": 0.87 },
    { "locator": "page.getByRole('button', { name: 'Continue with Google' })", "score": 0.42 },
    { "locator": "page.getByRole('heading', { name: 'Log in to Acme Store' })", "score": 0.15 }
  ],
  "referenceSource": "baseline"
}
```

It picked the right button over the look-alike, and the suggestion is a role-based locator that would have survived the redesign in the first place.

## Tools

| Tool | What it does |
|---|---|
| `explore_page` | Opens a URL and lists elements with locators verified to match exactly one element. |
| `check_locator` | Counts what a locator matches on a page (1 = good) and whether it's visible. |
| `parse_user_story` | User story → structured scenarios + a Playwright Test skeleton. |
| `write_test` | Writes a spec into `tests/`. Refuses paths outside it; won't overwrite unless asked. |
| `run_tests` | Runs Playwright Test and returns per-test results with the failing locator. |
| `capture_baseline` | While tests pass, fingerprints the element each locator matches (`.qa-mcp/baselines.json`). |
| `heal_locator` | Finds the intended element after a UI change and suggests a verified replacement. |

Prompt: **`story_to_playwright`**, a guided workflow from story to passing test.

## How self-healing works

1. **Baseline.** While tests pass, `capture_baseline` records each element's fingerprint: role, accessible name, test id, id, `name`, type, label, placeholder, classes, text and href.
2. **Detect.** When `run_tests` reports a failure, it includes the locator Playwright was waiting for.
3. **Match.** `heal_locator` scores every visible element on the current page against the fingerprint. It uses exact matching for stable attributes and fuzzy, synonym-aware matching for text and ids ("Sign in" ≈ "Log in", `btn` ≈ `button`).
4. **Verify.** The best match gets the most stable locator that matches exactly one element on the live page.
5. **Decide.** It reports `healed` only when the confidence is at least 0.55 and clearly ahead of the runner-up. Otherwise it reports `needs_review` with the top candidates, or `not_found` if nothing resembles the original. Without a baseline it falls back to what the locator itself implies and says so.

## Install

Requires Node 20+.

### Claude Code

```bash
git clone https://github.com/K11-Software-Solutions/k11techlab-playwright-qa-mcp
cd k11techlab-playwright-qa-mcp
npm install
npx playwright install chromium
# from your app's project folder:
claude mcp add playwright-qa -- node /path/to/k11techlab-playwright-qa-mcp/dist/cli.js
```

**As a plugin** (adds `/story-to-test` and `/heal-tests`), once the package is published to npm:

```text
/plugin marketplace add K11-Software-Solutions/k11techlab-playwright-qa-mcp
/plugin install playwright-qa@k11-qa-tools
```

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "playwright-qa": {
      "command": "node",
      "args": ["/path/to/k11techlab-playwright-qa-mcp/dist/cli.js"],
      "env": { "QA_MCP_ROOT": "/path/to/your/app" }
    }
  }
}
```

The server works on the project in `QA_MCP_ROOT`, or the current directory if that isn't set. That project needs `@playwright/test` installed for `run_tests`.

## Try it

In Claude Code, inside your app's repository:

```text
/story-to-test http://localhost:3000/login As a customer, I want to sign in so that I can see my orders.
- Valid credentials show "Welcome back"
- A wrong password shows an error and keeps me on the login page
```

After a UI change:

```text
/heal-tests tests/login.spec.ts
```

## Safety

- **Locator strings are parsed, never `eval`'d.** Only single `getByRole` / `getByTestId` / `getByLabel` / `getByPlaceholder` / `getByText` / `locator(css)` expressions are accepted.
- **Writes are confined to `tests/`,** limited to `.spec`/`.test` files, and never overwrite unless you ask.
- **Tests run through the project's own Playwright CLI** with Node directly, with no shell, so arguments can't inject commands.
- **Healing only suggests.** You, or the agent with your review, decide what to change.

## Development

```bash
npm install
npx playwright install chromium
npm test        # unit, browser and MCP-protocol tests (22)
npm run build
```

## Roadmap

- Healing across multi-step flows (navigate, then heal on the page the test reached)
- Visual (screenshot) fingerprints as an extra healing signal
- Optional auto-apply mode for `healed` results in CI, opening a pull request
- npm package and one-command plugin install

---

Built by [K11 Software Solutions](https://k11softwaresolutions.com). Part of the K11 Tech Lab agentic QA series. MIT licensed.
