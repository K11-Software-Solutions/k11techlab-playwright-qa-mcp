import { describe, expect, it } from "vitest";
import path from "node:path";
import { impliedFingerprint, parseLocator, render } from "../src/locators.js";
import { parseStory, scaffoldSpec } from "../src/story.js";
import { rank, score, textSimilarity, tokens } from "../src/heal.js";
import { failingLocator, resolveTestPath, summarize } from "../src/project.js";
import type { Fingerprint } from "../src/snapshot.js";

describe("locator parsing", () => {
  it("round-trips the supported strategies", () => {
    for (const code of [
      "page.getByRole('button', { name: 'Sign in' })",
      "page.getByRole('heading')",
      "page.getByTestId('login-submit')",
      "page.getByLabel('Email address')",
      "page.getByPlaceholder('you@example.com')",
      "page.getByText('Welcome back')",
      "page.locator('#login-btn')",
    ]) {
      expect(render(parseLocator(code)!)).toBe(code);
    }
  });

  it("accepts await, double quotes and a trailing semicolon", () => {
    expect(parseLocator(`await page.getByRole("link", { name: "My orders" });`)).toEqual({ kind: "role", value: "link", name: "My orders" });
  });

  it("handles escaped quotes", () => {
    const spec = parseLocator("page.getByText('Don\\'t miss out')")!;
    expect(spec.value).toBe("Don't miss out");
    expect(render(spec)).toBe("page.getByText('Don\\'t miss out')");
  });

  it("rejects chains and arbitrary code instead of evaluating it", () => {
    expect(parseLocator("page.getByRole('button').first()")).toBeNull();
    expect(parseLocator("require('child_process').exec('calc')")).toBeNull();
  });

  it("derives a partial fingerprint from CSS locators", () => {
    expect(impliedFingerprint({ kind: "css", value: "button#login-btn.btn.btn-primary" }))
      .toEqual({ id: "login-btn", tag: "button", classes: "btn btn-primary" });
  });
});

describe("user story parsing", () => {
  it("parses connextra format with Gherkin scenarios", () => {
    const s = parseStory(`As a registered customer, I want to sign in so that I can see my orders.

Scenario: Valid credentials show the dashboard
  Given I am on the login page
  When I sign in with valid credentials
  Then I see "Welcome back"

Scenario: Wrong password shows an error
  Given I am on the login page
  When I sign in with a wrong password
  Then I see an error message`);
    expect(s.role).toBe("registered customer");
    expect(s.goal).toBe("sign in");
    expect(s.benefit).toBe("I can see my orders");
    expect(s.scenarios.map((x) => x.name)).toEqual(["Valid credentials show the dashboard", "Wrong password shows an error"]);
    expect(s.scenarios[0].steps.map((x) => x.keyword)).toEqual(["Given", "When", "Then"]);
  });

  it("turns acceptance-criteria bullets into scenarios", () => {
    const s = parseStory(`Title: Password reset
Acceptance criteria:
- A reset link is sent to registered emails
- Unknown emails show the same confirmation message
AC3: The link expires after 30 minutes`);
    expect(s.title).toBe("Password reset");
    expect(s.scenarios).toHaveLength(3);
    expect(s.scenarios[2].name).toBe("The link expires after 30 minutes");
  });

  it("scaffolds one test per scenario with steps and a goto", () => {
    const code = scaffoldSpec(parseStory("As a user, I want to log in.\nScenario: ok\nGiven x\nThen y"), "https://example.com/login");
    expect(code).toContain("import { test, expect } from '@playwright/test';");
    expect(code).toContain("await page.goto('https://example.com/login');");
    expect(code).toContain("test('ok', async ({ page }) => {");
    expect(code).toContain("await test.step('Given x'");
    expect(code.match(/TODO/g)).toHaveLength(2);
  });
});

describe("similarity scoring", () => {
  it("normalises tokens and synonyms", () => {
    expect(tokens("loginBtn")).toEqual(["login", "button"]);
    expect(tokens("signin-submit")).toEqual(["login", "send"]);
    expect(textSimilarity("Sign in", "Log in")).toBeGreaterThan(0.4);
    expect(textSimilarity("Sign in", "Continue with Google")).toBeLessThan(0.3);
  });

  it("ranks the redesigned login button above a distractor", () => {
    const ref = { tag: "button", role: "button", name: "Sign in", id: "login-btn", type: "submit", classes: "btn btn-primary" };
    const els: Fingerprint[] = [
      { index: 0, tag: "button", role: "button", name: "Continue with Google", id: "google-signin", type: "button", classes: "cta cta-secondary", visible: true },
      { index: 1, tag: "button", role: "button", name: "Log in", id: "signin-submit", type: "submit", classes: "cta cta-primary", visible: true },
      { index: 2, tag: "a", role: "link", name: "Help", visible: true },
    ];
    const ranked = rank(ref, els);
    expect(ranked[0].element.id).toBe("signin-submit");
    expect(ranked[0].score - ranked[1].score).toBeGreaterThan(0.1);
    expect(score(ref, els[2]).score).toBeLessThan(0.2);
  });

  it("ignores invisible elements", () => {
    const ranked = rank({ name: "Save" }, [{ index: 0, tag: "button", name: "Save", visible: false }]);
    expect(ranked).toHaveLength(0);
  });
});

describe("project guards and reports", () => {
  const root = path.resolve("/proj");

  it("keeps test writes inside tests/", () => {
    expect(resolveTestPath(root, "login.spec.ts")).toBe(path.join(root, "tests", "login.spec.ts"));
    expect(resolveTestPath(root, "tests/auth/login.spec.ts")).toBe(path.join(root, "tests", "auth", "login.spec.ts"));
    expect(() => resolveTestPath(root, "../evil.spec.ts")).toThrow(/inside tests/);
    expect(() => resolveTestPath(root, "notes.md")).toThrow(/must end/);
  });

  it("extracts the locator Playwright was waiting for", () => {
    expect(failingLocator("TimeoutError: locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#login-btn')\n"))
      .toBe("locator('#login-btn')");
    expect(failingLocator("Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('heading', { name: 'Welcome' })\nExpected: visible"))
      .toBe("getByRole('heading', { name: 'Welcome' })");
  });

  it("summarises a Playwright JSON report", () => {
    const s = summarize({
      suites: [{
        title: "login.spec.ts", file: "login.spec.ts", specs: [], suites: [{
          title: "Sign in", specs: [
            { title: "works", file: "login.spec.ts", tests: [{ results: [{ status: "passed", duration: 120 }] }] },
            { title: "fails", file: "login.spec.ts", tests: [{ results: [{ status: "failed", duration: 2100, error: { message: "waiting for locator('#x')" } }] }] },
          ],
        }],
      }],
    });
    expect(s).toMatchObject({ ok: false, passed: 1, failed: 1 });
    expect(s.tests[1]).toMatchObject({ title: "Sign in › fails", failingLocator: "locator('#x')" });
  });
});
