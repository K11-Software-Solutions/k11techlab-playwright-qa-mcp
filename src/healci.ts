/**
 * heal-ci: heal broken locators in CI with an audit trail.
 *
 *   run tests → for each locator failure: find the page, heal against the committed
 *   baseline → apply only confident suggestions → re-run the affected specs →
 *   revert any change whose test still fails → write a Markdown + JSON report.
 *
 * Mobile web: each failure is healed on the device its Playwright project emulates
 * (heal.config.json "projects" mapping, a device-named project, or the template names
 * "Mobile Chrome"/"Mobile Safari"). When one broken locator fails on several devices,
 * they must agree on the replacement, and a change is kept only if the test then passes
 * in every project, so a mobile fix can't silently break desktop.
 *
 * Every applied change in the report carries its evidence: the old and new
 * locator, confidence, the reasons, the runner-up candidate, and the re-run result.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { closeBrowser, withPage } from "./browser.js";
import { DESKTOP, deviceForProject } from "./devices.js";
import { heal, type HealResult } from "./heal.js";
import { parseLocator, render, type LocatorSpec } from "./locators.js";
import { runTests, type TestResult } from "./project.js";
import { lastGotoBefore, replaceLocator, type Replacement } from "./rewrite.js";
import type { Session } from "./session.js";
import { BaselineStore } from "./store.js";
import { VERSION } from "./version.js";

export interface HealTarget {
  /** Spec file (path suffix match), e.g. "account.spec.ts" */
  spec: string;
  /** Page the test is on when it fails; absolute or relative to baseUrl */
  url?: string;
  session?: Session;
}
export interface HealConfig {
  baseUrl?: string;
  minConfidence?: number;
  targets?: HealTarget[];
  /** Playwright project name → device, e.g. { "Phones": "iPhone 15" } */
  projects?: Record<string, string>;
}

export interface HealCiOptions {
  apply: boolean;
  minConfidence?: number;
  configPath?: string;
  reportDir?: string;
  verify?: boolean;
  log?: (msg: string) => void;
}

export type Outcome = "applied" | "suggested" | "reverted" | "needs_review" | "not_found" | "skipped";

export interface HealItem {
  test: string;
  file: string;
  line?: number;
  locator: string;
  /** Playwright project and the device it emulates (mobile web). */
  project?: string;
  device?: string;
  page?: string;
  outcome: Outcome;
  confidence?: number;
  suggestion?: string;
  reasons?: string[];
  runnerUp?: { locator?: string; score: number };
  candidates?: HealResult["candidates"];
  replacements?: Replacement[];
  verified?: boolean;
  note?: string;
}

export interface HealReport {
  tool: string;
  generatedAt: string;
  mode: "apply" | "dry-run";
  minConfidence: number;
  testsRun: number;
  failures: number;
  items: HealItem[];
  otherFailures: { test: string; file: string; error?: string }[];
  counts: Record<Outcome, number>;
}

export const DEFAULT_MIN_CONFIDENCE = 0.7;

async function loadConfig(root: string, configPath?: string): Promise<HealConfig> {
  const file = path.resolve(root, configPath ?? ".qa-mcp/heal.config.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as HealConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !configPath) return {};
    throw new Error(`Could not read heal config ${file}: ${(e as Error).message}`);
  }
}

function targetFor(cfg: HealConfig, file: string): HealTarget | undefined {
  const norm = file.replace(/\\/g, "/");
  return cfg.targets?.find((t) => norm.endsWith(t.spec.replace(/\\/g, "/")));
}

function resolvePageUrl(cfg: HealConfig, target: HealTarget | undefined, source: string, t: TestResult): string | undefined {
  const raw = target?.url ?? lastGotoBefore(source, t.errorLine ?? t.line);
  if (!raw) return undefined;
  try {
    return new URL(raw, cfg.baseUrl).href;
  } catch {
    return undefined;
  }
}

export async function healCi(root: string, opts: HealCiOptions): Promise<{ report: HealReport; markdownPath: string; jsonPath: string }> {
  const log = opts.log ?? (() => undefined);
  const cfg = await loadConfig(root, opts.configPath);
  const min = opts.minConfidence ?? cfg.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const store = new BaselineStore(root);

  log("Running tests…");
  const run = await runTests(root);
  const failing = run.tests.filter((t) => ["failed", "timedOut", "interrupted"].includes(t.status));
  const items: HealItem[] = [];
  const otherFailures: HealReport["otherFailures"] = [];
  const originals = new Map<string, string>(); // file → source before any edit (for revert)
  const current = new Map<string, string>(); // file → source including edits so far
  const changedTests = new Map<string, HealItem[]>(); // file → items applied there

  try {
    // Group failures by spec file and broken locator: one source change fixes every test and
    // device that uses it, so they must agree on the replacement.
    type Member = { t: TestResult; item: HealItem };
    const groups = new Map<string, { file: string; broken: LocatorSpec; members: Member[] }>();
    for (const t of failing) {
      const file = t.filePath ?? path.resolve(root, t.file);
      const relFile = path.relative(root, file).replace(/\\/g, "/");
      if (!t.failingLocator) {
        otherFailures.push({ test: t.title, file: relFile, error: t.error?.split("\n")[0] });
        continue;
      }
      const broken = parseLocator(t.failingLocator);
      const { device } = deviceForProject(t.project, cfg.projects);
      const item: HealItem = { test: t.title, file: relFile, line: t.errorLine ?? t.line, locator: broken ? render(broken) : t.failingLocator,
        ...(t.project ? { project: t.project } : {}), ...(device !== DESKTOP || t.project ? { device } : {}), outcome: "skipped" };
      items.push(item);
      if (!broken) { item.note = "Locator form not supported for healing"; continue; }
      const key = `${file}\u0000${render(broken)}`;
      if (!groups.has(key)) groups.set(key, { file, broken, members: [] });
      groups.get(key)!.members.push({ t, item });
    }

    for (const { file, broken, members } of groups.values()) {
      const source = current.get(file) ?? (await fs.readFile(file, "utf8"));
      const target = targetFor(cfg, file);
      const results = new Map<string, HealResult & { page: string }>(); // url|device → result
      const resultOf = new Map<HealItem, HealResult>();
      const healed: HealItem[] = [];
      for (const { t, item } of members) {
        const url = resolvePageUrl(cfg, target, source, t);
        if (!url) {
          item.note = "Could not tell which page the test was on. Add a target for this spec in .qa-mcp/heal.config.json.";
          continue;
        }
        const device = item.device ?? DESKTOP;
        const cacheKey = `${url}|${device}`;
        if (!results.has(cacheKey)) {
          log(`Healing ${render(broken)} on ${url}${device !== DESKTOP ? ` (${device})` : ""}`);
          results.set(cacheKey, await withPage(url, root, target?.session, async ({ page, finalUrl }) => {
            const baseline = await store.get(finalUrl, render(broken), device);
            return { page: finalUrl, ...(await heal(page, render(broken), broken, baseline)) };
          }, device));
        }
        const result = results.get(cacheKey)!;
        resultOf.set(item, result);
        Object.assign(item, {
          page: result.page,
          confidence: result.confidence,
          suggestion: result.suggestion,
          reasons: result.reasons,
          candidates: result.candidates,
          runnerUp: result.candidates?.[1] ? { locator: result.candidates[1].locator, score: result.candidates[1].score } : undefined,
        });
        if (result.status === "healthy") { item.outcome = "skipped"; item.note = "Locator matches on the page now; the failure has another cause."; continue; }
        if (result.status === "not_found") { item.outcome = "not_found"; item.note = result.note; continue; }
        if (result.status !== "healed" || !result.suggestion || (result.confidence ?? 0) < min) {
          item.outcome = "needs_review";
          item.note = result.status === "healed" ? `Confidence below the ${min} threshold for automatic changes.` : result.note;
          continue;
        }
        healed.push(item);
      }
      if (!healed.length) continue;
      // Every failing member must be confidently healed to the same locator; otherwise a person decides.
      const unresolved = members.filter((m) => !healed.includes(m.item) && !m.item.note?.startsWith("Locator matches on the page now"));
      let suggestions = [...new Set(healed.map((i) => i.suggestion!))];
      if (suggestions.length > 1) {
        // Devices found different "best" locators (e.g. separate desktop and mobile elements with their own
        // test ids). Prefer a locator verified unique on every one of those pages, most stable first.
        const options = healed.map((i) => [i.suggestion!, ...(resultOf.get(i)?.alternatives ?? [])]);
        const shared = options[0].find((loc) => options.every((o) => o.includes(loc)));
        if (shared) {
          const perDevice = healed.map((i) => `${i.device ?? DESKTOP}: ${i.suggestion}`).join("; ");
          for (const i of healed) {
            i.suggestion = shared;
            i.reasons = [...(i.reasons ?? []), `shared locator, unique on every device (device-specific best: ${perDevice})`];
          }
          const conf = Math.min(...healed.map((i) => i.confidence ?? 0));
          for (const i of healed) i.confidence = conf;
          suggestions = [shared];
        }
      }
      if (suggestions.length > 1 || unresolved.length) {
        const why = suggestions.length > 1
          ? `Devices disagree on the replacement (${healed.map((i) => `${i.device ?? DESKTOP}: ${i.suggestion}`).join("; ")}); use a locator that works on every device, or branch on isMobile in the test.`
          : `Other tests or devices using this locator could not be healed with confidence (${unresolved.map((m) => m.item.device ?? m.item.test).join(", ")}).`;
        for (const i of healed) { i.outcome = "needs_review"; i.note = why; }
        continue;
      }
      const { code, replacements } = replaceLocator(source, broken, parseLocator(suggestions[0])!);
      if (!replacements.length) {
        for (const i of healed) { i.outcome = "needs_review"; i.note = "Locator not found in the spec source (built dynamically?)."; }
        continue;
      }
      for (const i of healed) i.replacements = replacements;
      if (!opts.apply) { for (const i of healed) i.outcome = "suggested"; continue; }
      if (!originals.has(file)) originals.set(file, source);
      await fs.writeFile(file, code, "utf8");
      current.set(file, code);
      for (const i of healed) i.outcome = "applied";
      changedTests.set(file, [...(changedTests.get(file) ?? []), ...healed]);
    }

    // Verify: re-run the changed specs. A change is kept only if its own test passes;
    // failing ones are reverted individually by rebuilding the file from the original
    // with just the kept changes, then re-verifying (at most 3 rounds).
    if (opts.apply && opts.verify !== false && changedTests.size) {
      for (let round = 1; round <= 3 && changedTests.size; round++) {
        log(`Re-running healed specs (round ${round})…`);
        const rerun = await runTests(root, { files: [...changedTests.keys()] });
        // A test counts as passing only if it passes in every Playwright project (desktop and mobile).
        const passed = (file: string, test: string) => {
          const runs = rerun.tests.filter((r) => (r.filePath ?? path.resolve(root, r.file)) === file && r.title === test);
          return runs.length > 0 && runs.every((r) => r.status === "passed");
        };
        let anyReverted = false;
        for (const [file, applied] of [...changedTests]) {
          // one source change serves every test using the locator: if any of them fails, revert it for all
          const badLocators = new Set(applied.filter((a) => !passed(file, a.test)).map((a) => a.locator));
          const keep = applied.filter((a) => !badLocators.has(a.locator));
          const drop = applied.filter((a) => badLocators.has(a.locator));
          for (const a of keep) a.verified = true;
          for (const a of drop) {
            a.verified = false;
            a.outcome = "reverted";
            a.note = "A test using this healed locator still failed on re-run (in at least one project); the change was reverted (other changes in the file were kept).";
          }
          if (!drop.length) { changedTests.delete(file); continue; }
          anyReverted = true;
          let code = originals.get(file)!;
          for (const [loc, sugg] of new Map(keep.map((a) => [a.locator, a.suggestion!]))) code = replaceLocator(code, parseLocator(loc)!, parseLocator(sugg)!).code;
          await fs.writeFile(file, code, "utf8");
          if (keep.length) changedTests.set(file, keep);
          else changedTests.delete(file);
        }
        if (!anyReverted) break;
      }
    }
  } finally {
    await closeBrowser();
  }

  const counts = { applied: 0, suggested: 0, reverted: 0, needs_review: 0, not_found: 0, skipped: 0 } as Record<Outcome, number>;
  for (const i of items) counts[i.outcome]++;
  const report: HealReport = {
    tool: `k11-playwright-qa-mcp heal-ci ${VERSION}`,
    generatedAt: new Date().toISOString(),
    mode: opts.apply ? "apply" : "dry-run",
    minConfidence: min,
    testsRun: run.tests.length,
    failures: failing.length,
    items,
    otherFailures,
    counts,
  };
  const dir = path.resolve(root, opts.reportDir ?? ".qa-mcp/heal-report");
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, "heal-report.json");
  const markdownPath = path.join(dir, "heal-report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await fs.writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, markdownPath, jsonPath };
}

const code = (s?: string) => (s ? `\`${s.replace(/`/g, "'")}\`` : "–");
const pct = (n?: number) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);

export function toMarkdown(r: HealReport): string {
  const L: string[] = [];
  L.push("## Locator healing report", "");
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  L.push(`${n(r.testsRun, "test", "tests")} run, ${r.failures} failed. ` +
    `**${r.counts.applied} healed and verified**, ${r.counts.suggested} suggested, ${r.counts.reverted} reverted, ` +
    `${n(r.counts.needs_review, "needs", "need")} review, ${r.counts.not_found} not found, ` +
    `${n(r.otherFailures.length, "failure", "failures")} not caused by locators.`, "");
  L.push(`Mode: **${r.mode}**. Changes are applied only when confidence is at least **${pct(r.minConfidence)}**, ` +
    "clearly ahead of the runner-up, and the healed test passes on re-run.", "");

  const changed = r.items.filter((i) => i.outcome === "applied" || i.outcome === "suggested");
  if (changed.length) {
    L.push(r.mode === "apply" ? "### Changes" : "### Suggested changes", "");
    L.push("| Test | File | Old locator | New locator | Confidence | Runner-up | Re-run |", "|---|---|---|---|---|---|---|");
    const dev = (i: HealItem) => (i.device && i.device !== DESKTOP ? ` (${i.device})` : i.project ? ` (${i.project})` : "");
    for (const i of changed) {
      const lines = i.replacements?.map((x) => x.line).join(", ");
      L.push(`| ${i.test}${dev(i)} | ${i.file}${lines ? `:${lines}` : ""} | ${code(i.locator)} | ${code(i.suggestion)} | ${pct(i.confidence)} | ` +
        `${i.runnerUp ? `${code(i.runnerUp.locator)} (${pct(i.runnerUp.score)})` : "–"} | ${i.verified === true ? "passed" : i.verified === false ? "failed" : "not run"} |`);
    }
    L.push("");
    for (const i of changed) {
      L.push(`<details><summary>Why ${code(i.suggestion)} replaces ${code(i.locator)}</summary>`, "");
      L.push(`Page: ${i.page ?? "–"}`, "");
      for (const reason of i.reasons ?? []) L.push(`- ${reason}`);
      L.push("", "</details>", "");
    }
  }

  const review = r.items.filter((i) => !["applied", "suggested"].includes(i.outcome));
  if (review.length) {
    L.push("### Needs a person", "");
    L.push("| Test | Locator | Outcome | Best candidate | Note |", "|---|---|---|---|---|");
    for (const i of review) {
      const best = i.candidates?.[0];
      L.push(`| ${i.test}${i.device && i.device !== DESKTOP ? ` (${i.device})` : ""} | ${code(i.locator)} | ${i.outcome.replace("_", " ")} | ${best ? `${code(best.locator)} (${pct(best.score)})` : "–"} | ${i.note ?? ""} |`);
    }
    L.push("");
  }

  if (r.otherFailures.length) {
    L.push("### Failures not caused by locators", "", "These may be real bugs and were not touched:", "");
    for (const f of r.otherFailures) L.push(`- **${f.test}** (${f.file}): ${f.error ?? "see test output"}`);
    L.push("");
  }
  L.push(`<sub>Generated by ${r.tool} at ${r.generatedAt}. Full evidence: heal-report.json.</sub>`, "");
  return L.join("\n");
}
