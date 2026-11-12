import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { heal, type Reference } from "../src/heal.js";
import { parseLocator, toPlaywright } from "../src/locators.js";
import { explore, fingerprintOf } from "../src/snapshot.js";

const v1 = pathToFileURL(path.resolve("demo/v1/login.html")).href;
const v2 = pathToFileURL(path.resolve("demo/v2/login.html")).href;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

async function open(url: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(url);
  return page;
}

async function baselineFor(url: string, code: string): Promise<Reference> {
  const page = await open(url);
  const fp = await fingerprintOf(page, toPlaywright(page, parseLocator(code)!));
  await page.close();
  const { index: _i, visible: _v, ...ref } = fp!;
  return ref as Reference;
}

describe("explore_page", () => {
  it("returns unique, stable locators for the login form", async () => {
    const page = await open(v1);
    const els = await explore(page, 40, true);
    await page.close();
    const byId = Object.fromEntries(els.map((e) => [e.id ?? e.name, e]));
    expect(byId["login-btn"].best).toBe("page.getByRole('button', { name: 'Sign in' })");
    expect(byId["email"].best).toBe("page.getByRole('textbox', { name: 'Email address' })");
    // password inputs have no ARIA role, so the label is the most stable unique locator
    expect(byId["password"].best).toBe("page.getByLabel('Password')");
    expect(els.every((e) => e.best)).toBe(true);
  });
});

describe("heal_locator", () => {
  it("reports a working locator as healthy", async () => {
    const page = await open(v1);
    const r = await heal(page, "page.locator('#login-btn')", parseLocator("page.locator('#login-btn')"));
    await page.close();
    expect(r.status).toBe("healthy");
  });

  it("heals the submit button after the redesign using the baseline, ignoring the Google button", async () => {
    const code = "page.locator('#login-btn')";
    const baseline = await baselineFor(v1, code);
    const page = await open(v2);
    const r = await heal(page, code, parseLocator(code), baseline);
    await page.close();
    expect(r.status).toBe("healed");
    expect(r.suggestion).toBe("page.getByRole('button', { name: 'Log in' })");
    expect(r.referenceSource).toBe("baseline");
    expect(r.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("heals renamed form fields using the baseline", async () => {
    for (const [code, expected] of [
      ["page.locator('#email')", "page.getByRole('textbox', { name: 'Email address' })"],
      ["page.locator('#password')", "page.getByLabel('Password')"],
    ]) {
      const baseline = await baselineFor(v1, code);
      const page = await open(v2);
      const r = await heal(page, code, parseLocator(code), baseline);
      await page.close();
      expect(r.status, code).toBe("healed");
      expect(r.suggestion, code).toBe(expected);
    }
  });

  it("without a baseline, still ranks the right element first but asks for review", async () => {
    const code = "page.getByRole('button', { name: 'Sign in' })";
    const page = await open(v2);
    const r = await heal(page, code, parseLocator(code));
    await page.close();
    expect(r.referenceSource).toBe("implied");
    expect(["healed", "needs_review"]).toContain(r.status);
    expect(r.candidates?.[0].locator).toBe("page.getByRole('button', { name: 'Log in' })");
  });

  it("refuses to evaluate unsupported locator code", async () => {
    const page = await open(v2);
    const r = await heal(page, "process.exit()", null);
    await page.close();
    expect(r.status).toBe("unparseable");
  });
});
