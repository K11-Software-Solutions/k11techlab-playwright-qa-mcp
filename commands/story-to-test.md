---
description: Turn a user story into a passing Playwright test using verified locators
argument-hint: <start-url> <user story text or path to a story file>
---

Write a Playwright Test spec for the user story below, using the playwright-qa MCP tools.

Input: $ARGUMENTS

The first argument is the start URL. The rest is the user story, or a path to a file containing it (read the file if so).

1. Call `parse_user_story` with the story and URL to get scenarios and a skeleton.
2. Call `explore_page` on the start URL, and again on any page the flow reaches, to get locators verified against the live page. For pages behind a login, call `save_login_state` once (passwords as `${ENV:NAME}`, never literal) and pass `session.storage_state`; for pages several steps into a flow, pass `session.steps`.
3. Fill in every TODO using only verified locators (prefer `getByTestId` and `getByRole`) and web-first assertions such as `toBeVisible`, `toHaveText` and `toHaveURL`. Do not add fixed waits.
4. Save the spec with `write_test` as `<feature>.spec.ts`. If the file exists, ask before overwriting.
5. Run it with `run_tests`. For locator failures call `heal_locator`; fix test logic yourself. If the application itself is wrong, stop and report the bug rather than weakening the assertion.
6. When the spec passes, call `capture_baseline` with the URL and the locators the test uses.

Finish with the file path, what each test covers, and any acceptance criteria you could not automate and why.
