#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { startStdio, VERSION } from "./server.js";

const cmd = process.argv[2];

if (cmd === "install-browsers") {
  // Install the Chromium build that matches this package's Playwright version.
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  const r = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h") {
  console.log(`k11-playwright-qa-mcp ${VERSION}

Usage:
  k11-playwright-qa-mcp                    start the MCP server on stdio
  k11-playwright-qa-mcp install-browsers   install the Chromium build this server needs
  k11-playwright-qa-mcp --version

Environment:
  QA_MCP_ROOT     project folder (default: current directory)
  QA_MCP_HEADED   set to 1 to show the browser`);
} else {
  startStdio().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
