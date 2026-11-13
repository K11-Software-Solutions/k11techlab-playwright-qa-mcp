/**
 * k11 Playwright QA MCP server.
 *
 * Gives an AI coding agent (Claude Code, Claude Desktop, any MCP client) the
 * facts it needs to write and maintain Playwright tests that actually work:
 * verified locators from the live page (including pages behind a login or
 * several steps into a flow), story-to-spec scaffolding, guarded test writing,
 * test runs with structured failures, and self-healing locators.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser, getBrowser, withPage } from "./browser.js";
import { heal, type Reference } from "./heal.js";
import { countMatches, parseLocator, render, toPlaywright } from "./locators.js";
import { projectRoot, runTests, writeTest } from "./project.js";
import { runSteps, STEP_ACTIONS, validateSteps, type Session } from "./session.js";
import { explore, fingerprintOf } from "./snapshot.js";
import { BaselineStore } from "./store.js";
import { parseStory, scaffoldSpec } from "./story.js";

import { VERSION } from "./version.js";
export { closeBrowser, VERSION };

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const stepSchema = z.object({
  action: z.enum(STEP_ACTIONS),
  locator: z.string().optional().describe("Playwright locator, e.g. page.getByLabel('Email')"),
  value: z.string().optional().describe("For fill/press/select. Use ${ENV:NAME} for secrets such as passwords."),
  url: z.string().optional().describe("For goto; may be relative to the start URL"),
});

const sessionSchema = z
  .object({
    storage_state: z.string().optional().describe("Saved login file (from save_login_state), relative to the project"),
    steps: z.array(stepSchema).max(25).optional().describe("Steps to run after the start URL loads, before exploring or healing"),
  })
  .optional()
  .describe("Reach pages behind a login or several steps into a flow");

export function createServer(): McpServer {
  const server = new McpServer({ name: "k11-playwright-qa", version: VERSION });
  const store = () => new BaselineStore(projectRoot());

  server.registerTool(
    "explore_page",
    {
      title: "Explore page",
      description:
        "Open a URL in a headless browser (optionally with a saved login and/or steps to reach a deeper page) and list its meaningful elements with locators verified to match exactly one element, most stable first. Use these locators when writing tests instead of guessing selectors.",
      inputSchema: {
        url: z.string().describe("Start URL (http, https or file)"),
        session: sessionSchema,
        interactive_only: z.boolean().default(true).describe("Only buttons, links, inputs and other controls"),
        max_elements: z.number().int().min(1).max(200).default(60),
      },
    },
    async ({ url, session, interactive_only, max_elements }) => {
      try {
        return json(await withPage(url, projectRoot(), session as Session, async ({ page, finalUrl, steps }) => {
          const elements = await explore(page, max_elements, interactive_only);
          return {
            url: finalUrl,
            ...(steps.length ? { steps_run: steps } : {}),
            count: elements.length,
            elements: elements.map(({ index: _i, visible: _v, probe: _p, ...e }) => e),
            note: elements.some((e) => !e.best) ? "Elements without 'best' have no unique stable locator; consider adding a data-testid." : undefined,
          };
        }));
      } catch (e) {
        return fail(`explore_page failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "check_locator",
    {
      title: "Check locator",
      description: "Check how many elements a Playwright locator matches on a page (1 = good) and whether the match is visible. Accepts the same session as explore_page.",
      inputSchema: {
        url: z.string(),
        locator: z.string().describe("e.g. page.getByRole('button', { name: 'Sign in' })"),
        session: sessionSchema,
      },
    },
    async ({ url, locator, session }) => {
      const spec = parseLocator(locator);
      if (!spec) return fail("Unsupported locator. Use one getByRole/getByTestId/getByLabel/getByPlaceholder/getByText/locator(...) expression.");
      try {
        return json(await withPage(url, projectRoot(), session as Session, async ({ page, finalUrl }) => {
          const matches = await countMatches(page, spec);
          const visible = matches === 1 ? await toPlaywright(page, spec).isVisible() : undefined;
          return { url: finalUrl, locator: render(spec), matches, visible, verdict: matches === 1 ? "unique" : matches === 0 ? "not found" : "ambiguous" };
        }));
      } catch (e) {
        return fail(`check_locator failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "save_login_state",
    {
      title: "Save login state",
      description:
        "Log in once by running steps on a login page, then save the browser's cookies and storage to .qa-mcp/auth/<name>.json. Pass that file as session.storage_state to other tools, or to Playwright's storageState in tests. Put passwords in environment variables and reference them as ${ENV:NAME}; never pass them literally. The saved file contains session tokens: keep .qa-mcp/auth out of version control.",
      inputSchema: {
        url: z.string().describe("Login page URL"),
        steps: z.array(stepSchema).min(1).max(25),
        name: z.string().regex(/^[\w-]{1,40}$/).default("default"),
        success_locator: z.string().optional().describe("Locator that must be visible after login, e.g. page.getByRole('heading', { name: 'My account' })"),
      },
    },
    async ({ url, steps, name, success_locator }) => {
      const root = projectRoot();
      try {
        validateSteps(steps);
        const okSpec = success_locator ? parseLocator(success_locator) : null;
        if (success_locator && !okSpec) return fail("Unsupported success_locator.");
        const context = await (await getBrowser()).newContext();
        try {
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const run = await runSteps(page, steps, url);
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
          if (okSpec) await toPlaywright(page, okSpec).waitFor({ state: "visible", timeout: 15_000 });
          const rel = `.qa-mcp/auth/${name}.json`;
          const full = path.join(root, rel);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await context.storageState({ path: full });
          await ensureGitignored(root, ".qa-mcp/auth/");
          return json({ saved: rel, landed_on: page.url(), steps_run: run, verified: okSpec ? render(okSpec) : undefined });
        } finally {
          await context.close();
        }
      } catch (e) {
        return fail(`save_login_state failed: ${(e as Error).message}`);
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
    async ({ path: rel, code, overwrite }) => {
      try {
        return json({ written: await writeTest(projectRoot(), rel, code, overwrite) });
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
        "Run Playwright Test in the project and return per-test results. Failures include the error, its location and, when the cause was a locator, the locator Playwright was waiting for (pass it to heal_locator).",
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
        "While tests pass, record a fingerprint (role, name, test id, id, classes, text...) of the element each locator matches, saved in .qa-mcp/baselines.json under the page reached. heal_locator uses these after the UI changes. Accepts the same session as explore_page for pages behind a login.",
      inputSchema: { url: z.string(), locators: z.array(z.string()).min(1).max(100), session: sessionSchema },
    },
    async ({ url, locators, session }) => {
      try {
        const result = await withPage(url, projectRoot(), session as Session, async ({ page, finalUrl }) => {
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
          return { saved, skipped, finalUrl };
        });
        await store().put(result.finalUrl, result.saved);
        return json({ page: result.finalUrl, captured: Object.keys(result.saved), skipped: result.skipped, file: ".qa-mcp/baselines.json" });
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
        "For a locator that no longer matches (or matches several elements), find the most likely intended element on the current page and suggest a verified replacement with a confidence score and reasons. Accepts the same session as explore_page. Never edits files: review the suggestion, update the test, then re-run.",
      inputSchema: { url: z.string(), locator: z.string(), session: sessionSchema },
    },
    async ({ url, locator, session }) => {
      const spec = parseLocator(locator);
      try {
        return json(await withPage(url, projectRoot(), session as Session, async ({ page, finalUrl }) => {
          const baseline = spec ? await store().get(finalUrl, render(spec)) : undefined;
          return { page: finalUrl, ...(await heal(page, locator, spec, baseline)) };
        }));
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
            "2. explore_page on the URL to get verified locators. For pages behind a login, first call save_login_state (passwords as ${ENV:NAME}) and pass session.storage_state; for pages several steps into a flow, pass session.steps.",
            "3. Fill in every TODO using ONLY verified locators (prefer getByTestId/getByRole) and web-first assertions (await expect(...).toBeVisible()/toHaveText()/toHaveURL()). No fixed waits.",
            "4. write_test to tests/<feature>.spec.ts.",
            "5. run_tests on that spec. For locator failures call heal_locator (with the same session); fix logic failures yourself. Repeat until it passes or a real product bug is found (report it, don't hide it).",
            "6. capture_baseline for the locators the test uses (with the same session), so future UI changes can be healed.",
            "Finish with: the file path, what each test covers, and any acceptance criteria you could not automate and why.",
          ].join("\n"),
        },
      }],
    }),
  );

  return server;
}

/** Make sure a path is listed in the project's .gitignore (creates the file if needed). */
async function ensureGitignored(root: string, entry: string): Promise<void> {
  const file = path.join(root, ".gitignore");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""))) return;
  await fs.writeFile(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`, "utf8");
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
