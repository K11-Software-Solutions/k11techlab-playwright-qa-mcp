---
description: Turn a user story into a passing Playwright test using verified locators, asking about anything unclear first
argument-hint: <start-url> <user story text or path to a story file>
---

Write a Playwright Test spec for the user story below, using the playwright-qa MCP tools.

Input: $ARGUMENTS

The first argument is the start URL. The rest is the user story, or a path to a file containing it (read the file if so).

1. **Ask before you build.** Call `review_user_story` with the story. If the project has related docs (a glossary, product notes, the feature's README), pass them as `context`.
   - If `ready` is false, show the user every question, with its reason and the words in the story that raised it, then **stop and wait for answers**. Don't guess them.
   - Add the answers to the story as acceptance criteria or Given/When/Then lines, and call `review_user_story` again.
   - If the user says to go ahead anyway, continue, but put each open question in the spec as a `// OPEN QUESTION:` comment next to the test it affects, and list them in your final report.
2. Call `parse_user_story` with the story and URL to get scenarios and a skeleton.
3. Call `explore_page` on the start URL, and again on any page the flow reaches, to get locators verified against the live page. For pages behind a login, call `save_login_state` once (passwords as `${ENV:NAME}`, never literal) and pass `session.storage_state`; for pages several steps into a flow, pass `session.steps`.
4. Fill in every TODO using only verified locators (prefer `getByTestId` and `getByRole`) and web-first assertions such as `toBeVisible`, `toHaveText` and `toHaveURL`. Do not add fixed waits.
5. Save the spec with `write_test` as `<feature>.spec.ts`. If the file exists, ask before overwriting.
6. Run it with `run_tests`. For locator failures call `heal_locator`; fix test logic yourself. If the application itself is wrong, stop and report the bug rather than weakening the assertion.
7. When the spec passes, call `capture_baseline` with the URL and the locators the test uses.

Finish with the file path, what each test covers, the questions you asked and the answers you got (and any still open), and any acceptance criteria you could not automate and why.
