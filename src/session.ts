/**
 * Sessions: reach pages behind a login or several steps into a flow.
 *
 * A session is an optional saved login (Playwright storageState file) plus a short
 * list of steps run after the first page loads. Steps use the same safe locator
 * parser as everything else (no eval), and values can read secrets from the
 * environment with ${ENV:NAME}, so passwords never appear in tool arguments,
 * results or logs.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { parseLocator, render, toPlaywright } from "./locators.js";

export const STEP_ACTIONS = ["goto", "click", "fill", "press", "select", "check", "uncheck", "wait_for"] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export interface FlowStep {
  action: StepAction;
  locator?: string;
  value?: string;
  url?: string;
}

export interface Session {
  storage_state?: string; // path relative to the project root
  steps?: FlowStep[];
}

export const MAX_STEPS = 25;
const ENV_RE = /\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replace ${ENV:NAME} with the environment value. Throws if a variable is missing. */
export function resolveEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_RE, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set`);
    return v;
  });
}

/** Text safe to echo back: env placeholders kept, other fill values masked. */
export function describeStep(step: FlowStep): string {
  const target = step.locator ? (parseLocator(step.locator) ? render(parseLocator(step.locator)!) : step.locator) : "";
  switch (step.action) {
    case "goto":
      return `goto ${step.url}`;
    case "fill": {
      const shown = step.value && /^\$\{ENV:[A-Za-z_][A-Za-z0-9_]*\}$/.test(step.value) ? step.value : "•••";
      return `fill ${target} with ${shown}`;
    }
    case "press":
    case "select":
      return `${step.action} ${target} ${step.value ?? ""}`.trim();
    default:
      return `${step.action} ${target}`;
  }
}

/** Validate steps up front so a bad step fails before any browser work. */
export function validateSteps(steps: FlowStep[] = []): void {
  if (steps.length > MAX_STEPS) throw new Error(`At most ${MAX_STEPS} steps are allowed`);
  steps.forEach((s, i) => {
    const where = `Step ${i + 1} (${s.action})`;
    if (!STEP_ACTIONS.includes(s.action)) throw new Error(`${where}: unknown action`);
    if (s.action === "goto") {
      if (!s.url) throw new Error(`${where}: needs url`);
      return;
    }
    if (!s.locator) throw new Error(`${where}: needs locator`);
    if (!parseLocator(s.locator)) throw new Error(`${where}: unsupported locator ${s.locator}`);
    if (["fill", "press", "select"].includes(s.action) && s.value === undefined) throw new Error(`${where}: needs value`);
  });
}

/** Resolve a storageState path, keeping it inside the project root. */
export async function resolveStorageState(root: string, rel?: string): Promise<string | undefined> {
  if (!rel) return undefined;
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error("storage_state must be inside the project folder");
  }
  try {
    await fs.access(full);
  } catch {
    throw new Error(`storage_state file not found: ${rel}. Create it with save_login_state.`);
  }
  return full;
}

/** Run steps on the page. Errors name the step but never include secret values. */
export async function runSteps(page: Page, steps: FlowStep[] = [], baseUrl?: string): Promise<string[]> {
  validateSteps(steps);
  const done: string[] = [];
  for (const [i, s] of steps.entries()) {
    const label = describeStep(s);
    try {
      if (s.action === "goto") {
        await page.goto(new URL(resolveEnv(s.url!), baseUrl ?? page.url()).href, { waitUntil: "domcontentloaded" });
      } else {
        const loc = toPlaywright(page, parseLocator(s.locator!)!);
        const value = s.value !== undefined ? resolveEnv(s.value) : undefined;
        switch (s.action) {
          case "click":
            await loc.click({ timeout: 10_000 });
            break;
          case "fill":
            await loc.fill(value!, { timeout: 10_000 });
            break;
          case "press":
            await loc.press(value!, { timeout: 10_000 });
            break;
          case "select":
            await loc.selectOption(value!, { timeout: 10_000 });
            break;
          case "check":
            await loc.check({ timeout: 10_000 });
            break;
          case "uncheck":
            await loc.uncheck({ timeout: 10_000 });
            break;
          case "wait_for":
            await loc.waitFor({ state: "visible", timeout: 15_000 });
            break;
        }
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      done.push(label);
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      throw new Error(`Step ${i + 1} failed: ${label}: ${msg}`);
    }
  }
  return done;
}
