#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { VERSION } from "./version.js";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): boolean {
  return rest.includes(`--${name}`);
}
function option(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

const HELP = `k11-playwright-qa-mcp ${VERSION}

Usage:
  k11-playwright-qa-mcp                    start the MCP server on stdio
  k11-playwright-qa-mcp install-browsers   install the Chromium build this tool needs
  k11-playwright-qa-mcp heal-ci [options]  heal broken locators and write an audit report
  k11-playwright-qa-mcp --version

heal-ci options:
  --apply                 edit spec files (default: dry run, report only)
  --min-confidence <n>    only apply heals at or above this confidence (default 0.7)
  --config <file>         heal config (default .qa-mcp/heal.config.json)
  --report-dir <dir>      where to write heal-report.md/.json (default .qa-mcp/heal-report)
  --no-verify             skip re-running healed specs (not recommended)

Environment:
  QA_MCP_ROOT     project folder (default: current directory)
  QA_MCP_HEADED   set to 1 to show the browser`;

async function main(): Promise<void> {
  if (cmd === "install-browsers") {
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    const r = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  if (cmd === "--version" || cmd === "-v") return void console.log(VERSION);
  if (cmd === "--help" || cmd === "-h") return void console.log(HELP);

  if (cmd === "heal-ci") {
    const { healCi } = await import("./healci.js");
    const { projectRoot } = await import("./project.js");
    const min = option("min-confidence");
    const { report, markdownPath, jsonPath } = await healCi(projectRoot(), {
      apply: flag("apply"),
      minConfidence: min !== undefined ? Number(min) : undefined,
      configPath: option("config"),
      reportDir: option("report-dir"),
      verify: !flag("no-verify"),
      log: (m) => console.error(m),
    });
    const c = report.counts;
    console.log(`heal-ci: ${report.failures} failing, ${c.applied} healed, ${c.suggested} suggested, ${c.reverted} reverted, ` +
      `${c.needs_review} need review, ${c.not_found} not found, ${report.otherFailures.length} other failures`);
    console.log(`report: ${markdownPath}`);
    // GitHub Actions integration: outputs for later steps, and the report in the run summary.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `healed=${c.applied}\nsuggested=${c.suggested}\nreport=${markdownPath}\nreport_json=${jsonPath}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(markdownPath, "utf8"));
    return;
  }

  if (cmd && !cmd.startsWith("-")) {
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }
  const { startStdio } = await import("./server.js");
  await startStdio();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
