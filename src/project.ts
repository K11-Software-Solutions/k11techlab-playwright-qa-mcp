/**
 * Project access: guarded test-file writes and running Playwright Test.
 * Tests are run by invoking the project's own Playwright CLI with Node directly
 * (no shell), so arguments cannot be used for command injection.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function projectRoot(): string {
  return path.resolve(process.env.QA_MCP_ROOT ?? process.cwd());
}

export function resolveTestPath(root: string, rel: string, testsDir = "tests"): string {
  if (!/\.(spec|test)\.(ts|js|mjs)$/.test(rel)) throw new Error("Test files must end in .spec.ts, .test.ts, .spec.js or .test.js");
  const base = path.resolve(root, testsDir);
  const full = path.resolve(base, rel.replace(new RegExp(`^${testsDir}[\\\\/]`), ""));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`Path must stay inside ${testsDir}/`);
  return full;
}

export async function writeTest(root: string, rel: string, code: string, overwrite = false): Promise<string> {
  const full = resolveTestPath(root, rel);
  if (!overwrite) {
    try {
      await fs.access(full);
      throw new Error(`${path.relative(root, full)} already exists; pass overwrite=true to replace it`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, code, "utf8");
  return path.relative(root, full).replace(/\\/g, "/");
}

export interface TestResult {
  title: string;
  file: string;
  status: string;
  durationMs: number;
  error?: string;
  failingLocator?: string;
}
export interface RunSummary {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  tests: TestResult[];
  stderr?: string;
}

/** Extract the locator Playwright was waiting for from an error message. */
export function failingLocator(message: string): string | undefined {
  const plain = message.replace(/\x1b\[[0-9;]*m/g, "");
  const m = plain.match(/(?:waiting for|Locator:)\s+((?:getBy\w+|locator)\(.+?\))(?:\s|$)/);
  return m?.[1];
}

interface PwSuite {
  title: string;
  file?: string;
  specs?: { title: string; file: string; tests: { results: { status: string; duration: number; error?: { message?: string } }[]; status?: string }[] }[];
  suites?: PwSuite[];
}

export function summarize(report: { suites?: PwSuite[]; stats?: Record<string, number> }): RunSummary {
  const tests: TestResult[] = [];
  const walk = (suites: PwSuite[] = [], prefix: string[] = []) => {
    for (const s of suites) {
      const p = s.title && !s.file?.endsWith(s.title) ? [...prefix, s.title] : prefix;
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests) {
          const last = t.results[t.results.length - 1];
          const status = t.status === "flaky" ? "flaky" : last?.status ?? "skipped";
          const msg = t.results.find((r) => r.error?.message)?.error?.message;
          tests.push({
            title: [...p, spec.title].join(" › "),
            file: spec.file,
            status,
            durationMs: last?.duration ?? 0,
            ...(msg && status !== "passed" ? { error: msg.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 1500), failingLocator: failingLocator(msg) } : {}),
          });
        }
      }
      walk(s.suites, p);
    }
  };
  walk(report.suites);
  const count = (st: string[]) => tests.filter((t) => st.includes(t.status)).length;
  const failed = count(["failed", "timedOut", "interrupted"]);
  return { ok: failed === 0, passed: count(["passed"]), failed, skipped: count(["skipped"]), flaky: count(["flaky"]), tests };
}

export async function runTests(root: string, opts: { spec?: string; grep?: string; timeoutMs?: number } = {}): Promise<RunSummary> {
  const req = createRequire(path.join(root, "package.json"));
  let cli: string;
  try {
    cli = req.resolve("@playwright/test/cli");
  } catch {
    throw new Error("@playwright/test is not installed in this project. Run: npm i -D @playwright/test && npx playwright install");
  }
  const args = [cli, "test", "--reporter=json"];
  if (opts.spec) args.push(path.relative(root, resolveTestPath(root, opts.spec)).replace(/\\/g, "/"));
  if (opts.grep) args.push("--grep", opts.grep);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, FORCE_COLOR: "0" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 300_000);
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      const start = out.indexOf("{");
      try {
        const summary = summarize(JSON.parse(out.slice(start)));
        if (err.trim()) summary.stderr = err.slice(0, 2000);
        resolve(summary);
      } catch {
        reject(new Error(`Could not parse Playwright JSON report. stderr: ${err.slice(0, 1500) || out.slice(0, 1500)}`));
      }
    });
  });
}
