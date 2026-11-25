# Changelog

## Unreleased

- **Ask before you build:** new `review_user_story` tool. Before tests are generated, it lists the questions a careful tester would ask (missing acceptance criteria, outcomes that can't be asserted, no user role, untestable words, limits without numbers, no failure path, missing preconditions, and, with `context`, terms the context never explains), each with why it matters and the words that raised it.
- `/story-to-test` and the `story_to_playwright` prompt now start with the review and wait for answers instead of guessing; open questions the user chooses to skip go into the spec and the final report.
- `parse_user_story` returns a short `review` summary, so open questions are visible even when the review is skipped.

## 0.3.0 (16 November 2026)

- **Mobile web:** `device` option (any Playwright device profile, e.g. "iPhone 15", "Pixel 7") on `explore_page`, `check_locator`, `capture_baseline`, `heal_locator` and `save_login_state`; new `list_devices` tool.
- `check_locator` with `devices` checks a locator on several devices at once; `heal_locator` with `check_devices` verifies the suggestion on other devices.
- Baselines are kept per device; existing desktop baselines are unchanged.
- `run_tests` takes a Playwright `project`.
- **heal-ci across Playwright projects:** failures are healed on the device each project emulates; devices must agree on one replacement (a shared locator is found when each has its own element); a change is kept only if the test passes in every project.
- heal-ci now heals every test that shares a broken locator in one change.

## 0.2.1

- Listed in the official MCP Registry.
