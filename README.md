# k11 Playwright QA — MCP server & Claude Code plugin

**Turn user stories into Playwright tests that actually pass, and fix the ones a redesign just broke.**

AI coding assistants write Playwright tests quickly, but they guess selectors. The tests look right, then fail on the first run, or break the next time someone renames a CSS class. This MCP server gives the assistant the facts it can't guess:

- **Verified locators.** It opens the real page and returns locators that match exactly one element, most stable first (`getByTestId`, `getByRole`, `getByLabel`, ...).
- **Story → spec.** It turns "As a… I want… so that…", Gherkin scenarios or acceptance-criteria bullets into a Playwright Test skeleton: one test per scenario, one `test.step` per step.
- **Structured test runs.** It runs Playwright and returns per-test results, including the exact locator a failing test was waiting for.
- **Self-healing locators.** When the UI changes, it finds the element the test meant and suggests a verified replacement with a confidence score and the reasons. It never silently edits your tests.

Works with **Claude Code** (as a plugin with `/story-to-test` and `/heal-tests` commands), **Claude Desktop**, and any other MCP client. Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.K11-Software-Solutions/playwright-qa`.

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
| `save_login_state` | Logs in once with a few steps and saves the session for the other tools and your tests. |

`explore_page`, `check_locator`, `capture_baseline` and `heal_locator` accept an optional **session** to reach pages behind a login or several steps into a flow.

Prompt: **`story_to_playwright`**, a guided workflow from story to passing test.

## How self-healing works

1. **Baseline.** While tests pass, `capture_baseline` records each element's fingerprint: role, accessible name, test id, id, `name`, type, label, placeholder, classes, text and href.
2. **Detect.** When `run_tests` reports a failure, it includes the locator Playwright was waiting for.
3. **Match.** `heal_locator` scores every visible element on the current page against the fingerprint. It uses exact matching for stable attributes and fuzzy, synonym-aware matching for text and ids ("Sign in" ≈ "Log in", `btn` ≈ `button`).
4. **Verify.** The best match gets the most stable locator that matches exactly one element on the live page.
5. **Decide.** It reports `healed` only when the confidence is at least 0.55 and clearly ahead of the runner-up. Otherwise it reports `needs_review` with the top candidates, or `not_found` if nothing resembles the original. Without a baseline it falls back to what the locator itself implies and says so.

Commit `.qa-mcp/baselines.json` to your repository so healing works in CI. Do **not** commit `.qa-mcp/auth/`, which holds login sessions; `save_login_state` adds it to `.gitignore` for you.

## Pages behind a login and multi-step flows

Every page tool accepts a `session`:

```json
{
  "url": "https://shop.example.com/login",
  "session": {
    "storage_state": ".qa-mcp/auth/default.json",
    "steps": [
      { "action": "click", "locator": "page.getByRole('link', { name: 'My orders' })" },
      { "action": "wait_for", "locator": "page.getByRole('heading', { name: 'Order history' })" }
    ]
  }
}
```

- **`storage_state`** is a saved login. Create one with `save_login_state` (log in once with steps) or reuse the file from your Playwright global setup. It must be inside the project.
- **`steps`** run after the start page loads: `goto`, `click`, `fill`, `press`, `select`, `check`, `uncheck` and `wait_for`, up to 25. Locators are parsed the same safe way as everywhere else.
- **Secrets stay out of prompts and logs.** Write `"value": "${ENV:APP_PASSWORD}"` and the value is read from the environment. Results show the placeholder, and literal fill values are masked as `•••`.
- Baselines are stored under the page the steps end on, so capturing and healing with the same session line up.

## Healing in CI, with an audit trail

`heal-ci` repairs locators broken by a UI change and opens a pull request that explains every change:

```bash
npx -y k11-playwright-qa-mcp heal-ci --apply
```

1. Runs your Playwright suite.
2. For each locator failure, works out the page the test was on (from `.qa-mcp/heal.config.json`, or the test's own `page.goto(...)`) and heals against the committed baseline, logging in first if the config says so.
3. Applies a change only when confidence is at least **0.7** (`--min-confidence`) and clearly ahead of the runner-up.
4. **Re-runs the healed tests and reverts any change whose test still fails.** Each change is kept or reverted on its own merits.
5. Leaves failures that aren't about locators alone: they may be real bugs.
6. Writes `heal-report.md` (the pull-request description) and `heal-report.json` (full evidence).

Without `--apply`, it's a dry run that only reports suggestions. A real report from the demo app's redesign:

> **1 healed and verified**, 0 suggested, 1 reverted, 1 needs review, 0 not found, 1 failure not caused by locators.
>
> | Test | Old locator | New locator | Confidence | Runner-up | Re-run |
> |---|---|---|---|---|---|
> | Account › shows my orders | `page.locator('#view-orders')` | `page.getByRole('button', { name: 'View orders' })` | 82% | `View returns` button (59%) | passed |
>
> **Needs a person:** "Edit profile" link → best candidate "Account settings" (45%), not confident enough to change. "Open cart" healed at 85%, but the test still failed because the cart message changed too, so the change was **reverted**.
>
> **Not caused by locators:** "has the account title" (the page title changed). Untouched.

Copy [`docs/heal-locators.yml`](docs/heal-locators.yml) into your app's `.github/workflows/` to run it on a schedule and open the pull request automatically, and [`docs/heal.config.example.json`](docs/heal.config.example.json) to `.qa-mcp/heal.config.json` to tell it how to log in.

## How it compares to Microsoft's Playwright MCP

[Playwright MCP](https://github.com/microsoft/playwright-mcp) lets an AI drive a browser through any task, and Playwright's test agents (planner, generator, healer) build on it. Use them to explore and automate broadly. Use k11 Playwright QA when you need test maintenance you can audit:

| | Playwright MCP and test agents | k11 Playwright QA |
|---|---|---|
| Healing evidence | The agent's reasoning | Confidence score, specific reasons and the runner-up, in a report |
| Reference point | The current page | A fingerprint saved when the test last passed |
| Same input, same result | Varies by run and model | Yes |
| Edits to your tests | The agent edits them | Only verified, confident changes; the rest goes to a person |
| CI output | Agent session | A pull request with an audit report |

They work well together: drive flows with Playwright MCP, and keep your suite healthy with k11 Playwright QA.

## Install

Requires Node 20+.

First, once per machine, install the Chromium build the server uses:

```bash
npx -y k11-playwright-qa-mcp install-browsers
```

### Claude Code: plugin (recommended)

Adds the MCP tools plus the `/story-to-test` and `/heal-tests` commands:

```text
/plugin marketplace add K11-Software-Solutions/k11techlab-playwright-qa-mcp
/plugin install playwright-qa@k11-qa-tools
```

### Claude Code: MCP server only

From your app's project folder:

```bash
claude mcp add playwright-qa -- npx -y k11-playwright-qa-mcp
```

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "playwright-qa": {
      "command": "npx",
      "args": ["-y", "k11-playwright-qa-mcp"],
      "env": { "QA_MCP_ROOT": "/path/to/your/app" }
    }
  }
}
```

### From source

```bash
git clone https://github.com/K11-Software-Solutions/k11techlab-playwright-qa-mcp
cd k11techlab-playwright-qa-mcp
npm install && npx playwright install chromium
claude mcp add playwright-qa -- node /path/to/k11techlab-playwright-qa-mcp/dist/cli.js
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
npm test        # unit, browser, login-flow, heal-ci and MCP-protocol tests (31)
npm run build
```

## Roadmap

- Learn each test's page automatically from a Playwright trace, so `heal.config.json` is rarely needed
- Visual (screenshot) fingerprints as an extra healing signal
- Healing for chained and filtered locators (`.filter()`, `.nth()`, nested locators)
- Listing in the official MCP Registry and community directories

---

Built by [K11 Software Solutions](https://k11softwaresolutions.com). Part of the K11 Tech Lab agentic QA series. MIT licensed.
