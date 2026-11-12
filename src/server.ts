/**
 * k11 Playwright QA MCP server.
 *
 * Gives an AI coding agent (Claude Code, Claude Desktop, any MCP client) the
 * facts it needs to write and maintain Playwright tests that actually work:
 * verified locators from the live page, story-to-spec scaffolding, guarded
 * test writing, test runs with structured failures, and self-healing locators.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { heal, type Reference } from "./heal.js";
import { countMatches, parseLocator, render, toPlaywright } from "./locators.js";
import { projectRoot, runTests, writeTest } from "./project.js";
import { explore, fingerprintOf } from "./snapshot.js";
import { BaselineStore } from "./store.js";
import { parseStory, scaffoldSpec } from "./story.js";

const VERSION = "0.1.0";

let browser: Browser | undefined;
async function withPage<T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> {
  browser ??= await chromium.launch({ headless: process.env.QA_MCP_HEADED !== "1" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    return await fn(page);
  } finally {
    await context.close();
  }
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createServer(): McpServer {
  const server = new McpServer({ name: "k11-playwright-qa", version: VERSION });
  const store = () => new BaselineStore(projectRoot());

  server.registerTool(
    "explore_page",
    {
      title: "Explore page",
      description:
        "Open a URL in a headless browser and list its meaningful elements with locators that were verified to match exactly one element (most stable first: getByTestId, getByRole, getByLabel, ...). Use these locators when writing tests instead of guessing selectors.",
      inputSchema: {
        url: z.string().describe("Page URL (http, https or file)"),
        interactive_only: z.boolean().default(true).describe("Only buttons, links, inputs and other controls"),
        max_elements: z.number().int().min(1).max(200).default(60),
      },
    },
    async ({ url, interactive_only, max_elements }) => {
      try {
        const elements = await withPage(url, (page) => explore(page, max_elements, interactive_only));
        return json({
          url,
          count: elements.length,
          elements: elements.map(({ index: _i, visible: _v, probe: _p, ...e }) => e),
          note: elements.some((e) => !e.best) ? "Elements without 'best' have no unique stable locator; consider adding a data-testid." : undefined,
        });
      } catch (e) {
        return fail(`explore_page failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "check_locator",
    {
      title: "Check locator",
      description: "Check how many elements a Playwright locator matches on a page (1 = good) and whether the match is visible.",
      inputSchema: { url: z.string(), locator: z.string().describe("e.g. page.getByRole('button', { name: 'Sign in' })") },
    },
    async ({ url, locator }) => {
      const spec = parseLocator(locator);
      if (!spec) return fail("Unsupported locator. Use one getByRole/getByTestId/getByLabel/getByPlaceholder/getByText/locator(...) expression.");
      try {
        return json(await withPage(url, async (page) => {
          const matches = await countMatches(page, spec);
          const visible = matches === 1 ? await toPlaywright(page, spec).isVisible() : undefined;
          return { locator: render(spec), matches, visible, verdict: matches === 1 ? "unique" : matches === 0 ? "not found" : "ambiguous" };
        }));
      } catch (e) {
        return fail(`check_locator failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "parse_user_story",
    {
      title: "Parse user story",
      description:
        "Turn a user story (As a.../I want.../so that..., Gherkin scenarios, or acceptance-criteria bullets) into structured scenarios and a Playwright Test skeleton with one test per scenario and one test.step per step.",
      inputSchema: { story: z.string(), url: z.string().optional().describe("Start page, added as page.goto in beforeEach") },
    },
    async ({ story, url }) => {
      const parsed = parseStory(story);
      return json({ story: parsed, skeleton: scaffoldSpec(parsed, url) });
    },
  );

  server.registerTool(
    "write_test",
    {
      title: "Write test file",
      description: "Write a Playwright spec into the project's tests/ folder. Refuses paths outside tests/ and will not overwrite unless overwrite=true.",
      inputSchema: {
        path: z.string().describe("Relative to tests/, e.g. login.spec.ts"),
        code: z.string(),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ path, code, overwrite }) => {
      try {
        return json({ written: await writeTest(projectRoot(), path, code, overwrite) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "run_tests",
    {
      title: "Run Playwright tests",
      description:
        "Run Playwright Test in the project and return per-test results. Failures include the error and, when the cause was a locator, the locator Playwright was waiting for (pass it to heal_locator).",
      inputSchema: {
        spec: z.string().optional().describe("Spec file relative to tests/; omit to run everything"),
        grep: z.string().optional().describe("Only run tests whose title matches"),
      },
    },
    async ({ spec, grep }) => {
      try {
        return json(await runTests(projectRoot(), { spec, grep }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "capture_baseline",
    {
      title: "Capture locator baselines",
      description:
        "While tests pass, record a fingerprint (role, name, test id, id, classes, text...) of the element each locator matches, saved in .qa-mcp/baselines.json. heal_locator uses these to find the element after the UI changes.",
      inputSchema: { url: z.string(), locators: z.array(z.string()).min(1).max(100) },
    },
    async ({ url, locators }) => {
      try {
        const result = await withPage(url, async (page) => {
          const saved: Record<string, Reference> = {};
          const skipped: { locator: string; reason: string }[] = [];
          for (const raw of locators) {
            const spec = parseLocator(raw);
            if (!spec) { skipped.push({ locator: raw, reason: "unsupported locator" }); continue; }
            const n = await countMatches(page, spec);
            if (n !== 1) { skipped.push({ locator: render(spec), reason: `matches ${n} elements` }); continue; }
            const fp = await fingerprintOf(page, toPlaywright(page, spec));
            if (fp) {
              const { index: _i, visible: _v, ...ref } = fp;
              saved[render(spec)] = ref as Reference;
            }
          }
          return { saved, skipped };
        });
        await store().put(url, result.saved);
        return json({ captured: Object.keys(result.saved), skipped: result.skipped, file: ".qa-mcp/baselines.json" });
      } catch (e) {
        return fail(`capture_baseline failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "heal_locator",
    {
      title: "Heal locator",
      description:
        "For a locator that no longer matches (or matches several elements), find the most likely intended element on the current page and suggest a verified replacement with a confidence score and reasons. Never edits files: review the suggestion, update the test, then re-run.",
      inputSchema: { url: z.string(), locator: z.string() },
    },
    async ({ url, locator }) => {
      const spec = parseLocator(locator);
      try {
        const baseline = spec ? await store().get(url, render(spec)) : undefined;
        return json(await withPage(url, (page) => heal(page, locator, spec, baseline)));
      } catch (e) {
        return fail(`heal_locator failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerPrompt(
    "story_to_playwright",
    {
      title: "User story → Playwright test",
      description: "Guided workflow: user story to a passing, maintainable Playwright test.",
      argsSchema: { story: z.string(), url: z.string() },
    },
    ({ story, url }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Write a Playwright Test spec for this user story, using the k11-playwright-qa tools.",
            "",
            `Start URL: ${url}`,
            "User story:",
            story,
            "",
            "Workflow:",
            "1. parse_user_story (with the URL) to get scenarios and a skeleton.",
            "2. explore_page on the URL (and on later pages you reach) to get verified locators.",
            "3. Fill in every TODO using ONLY verified locators (prefer getByTestId/getByRole) and web-first assertions (await expect(...).toBeVisible()/toHaveText()/toHaveURL()). No fixed waits.",
            "4. write_test to tests/<feature>.spec.ts.",
            "5. run_tests on that spec. For locator failures call heal_locator; fix logic failures yourself. Repeat until it passes or a real product bug is found (report it, don't hide it).",
            "6. capture_baseline for the locators the test uses, so future UI changes can be healed.",
            "Finish with: the file path, what each test covers, and any acceptance criteria you could not automate and why.",
          ].join("\n"),
        },
      }],
    }),
  );

  return server;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => undefined);
  browser = undefined;
}

export async function startStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}
