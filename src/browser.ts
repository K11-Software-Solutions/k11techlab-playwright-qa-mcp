/** Shared headless browser and session-aware page opening. */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveStorageState, runSteps, type Session } from "./session.js";

let browser: Browser | undefined;

export async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  try {
    browser = await chromium.launch({ headless: process.env.QA_MCP_HEADED !== "1" });
  } catch (e) {
    const msg = (e as Error).message;
    if (/Executable doesn't exist|browserType\.launch/i.test(msg) && /install/i.test(msg)) {
      throw new Error("Chromium for Playwright is not installed. Run once: npx -y k11-playwright-qa-mcp install-browsers");
    }
    throw e;
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => undefined);
  browser = undefined;
}

export interface Opened {
  page: Page;
  context: BrowserContext;
  /** URL after the session's steps: the page being explored or healed. */
  finalUrl: string;
  steps: string[];
}

/** Open url with an optional saved login and steps; the caller must close the context. */
export async function openPage(url: string, root: string, session?: Session): Promise<Opened> {
  const storageState = await resolveStorageState(root, session?.storage_state);
  const context = await (await getBrowser()).newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const steps = await runSteps(page, session?.steps, url);
    if (steps.length) await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    return { page, context, finalUrl: page.url(), steps };
  } catch (e) {
    await context.close();
    throw e;
  }
}

export async function withPage<T>(url: string, root: string, session: Session | undefined, fn: (o: Opened) => Promise<T>): Promise<T> {
  const opened = await openPage(url, root, session);
  try {
    return await fn(opened);
  } finally {
    await opened.context.close();
  }
}
