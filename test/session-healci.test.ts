import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseLocator } from "../src/locators.js";
import { describeStep, resolveEnv, validateSteps } from "../src/session.js";
import { lastGotoBefore, replaceLocator } from "../src/rewrite.js";
import { healCi } from "../src/healci.js";
import { runTests } from "../src/project.js";
// @ts-expect-error plain ESM helper without types
import { startDemoServer } from "../demo/server.mjs";
import { closeBrowser, createServer } from "../src/server.js";

const PASSWORD = "correct-horse";

describe("session helpers", () => {
  it("reads secrets from the environment and fails loudly when missing", () => {
    expect(resolveEnv("${ENV:A}-${ENV:B}", { A: "x", B: "y" })).toBe("x-y");
    expect(() => resolveEnv("${ENV:MISSING}", {})).toThrow(/MISSING is not set/);
  });

  it("never echoes literal fill values", () => {
    expect(describeStep({ action: "fill", locator: "page.getByLabel('Password')", value: "hunter2" })).toBe("fill page.getByLabel('Password') with •••");
    expect(describeStep({ action: "fill", locator: "page.getByLabel('Password')", value: "${ENV:APP_PASSWORD}" })).toContain("${ENV:APP_PASSWORD}");
  });

  it("validates steps before touching the browser", () => {
    expect(() => validateSteps([{ action: "click" }])).toThrow(/Step 1 \(click\): needs locator/);
    expect(() => validateSteps([{ action: "fill", locator: "page.getByLabel('x')" }])).toThrow(/needs value/);
    expect(() => validateSteps([{ action: "click", locator: "page.getByRole('x').first()" }])).toThrow(/unsupported locator/);
    expect(() => validateSteps([{ action: "goto" }])).toThrow(/needs url/);
  });
});

describe("source rewriting", () => {
  const broken = parseLocator("page.locator('#view-orders')")!;
  const healed = parseLocator("page.getByRole('button', { name: 'View orders' })")!;

  it("replaces equivalent calls, keeps the receiver, and reports lines", () => {
    const src = [
      "await page.locator('#view-orders').click();",
      'await this.page.locator("#view-orders").hover();',
      "await page.locator('#other').click(); // locator('#view-orders') in a comment is untouched",
    ].join("\n");
    const { code, replacements } = replaceLocator(src, broken, healed);
    expect(code.split("\n")[0]).toBe("await page.getByRole('button', { name: 'View orders' }).click();");
    expect(code.split("\n")[1]).toBe("await this.page.getByRole('button', { name: 'View orders' }).hover();");
    expect(code.split("\n")[2]).toContain("page.locator('#other')");
    expect(code.split("\n")[2]).toContain("// locator('#view-orders')");
    expect(replacements.map((r) => r.line)).toEqual([1, 2]);
  });

  it("finds the page a test was on", () => {
    const src = "test.beforeEach(async ({ page }) => {\n  await page.goto('/account.html');\n});\ntest('x', async ({ page }) => {\n  await page.goto(`${base}/x`);\n});";
    expect(lastGotoBefore(src, 3)).toBe("/account.html");
    expect(lastGotoBefore(src, 6)).toBeUndefined(); // template literal with a variable
  });
});

describe("logged-in pages, flows and heal-ci (demo app)", () => {
  let demo: { url: string; setVersion: (v: string) => void; close: () => Promise<void> };
  const fixture = path.resolve("test/fixtures/heal-project");
  const work = path.resolve("test/.tmp-heal");
  const prev = { root: process.env.QA_MCP_ROOT, pw: process.env.DEMO_PASSWORD, url: process.env.DEMO_URL };
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    if (r.isError) throw new Error(r.content[0].text);
    return { raw: r.content[0].text, data: JSON.parse(r.content[0].text) };
  };

  beforeAll(async () => {
    demo = await startDemoServer({ version: "v1" });
    await fs.rm(work, { recursive: true, force: true });
    await fs.cp(fixture, work, { recursive: true });
    process.env.QA_MCP_ROOT = work;
    process.env.DEMO_PASSWORD = PASSWORD;
    process.env.DEMO_URL = demo.url;
    const server = createServer();
    client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await client?.close();
    await closeBrowser();
    await demo?.close();
    process.env.QA_MCP_ROOT = prev.root;
    process.env.DEMO_PASSWORD = prev.pw;
    process.env.DEMO_URL = prev.url;
    await fs.rm(work, { recursive: true, force: true });
  });

  it("save_login_state logs in, saves the session and never echoes the password", async () => {
    const { raw, data } = await call("save_login_state", {
      url: `${demo.url}/login.html`,
      name: "demo",
      steps: [
        { action: "fill", locator: "page.getByLabel('Email address')", value: "alex@example.com" },
        { action: "fill", locator: "page.getByLabel('Password')", value: "${ENV:DEMO_PASSWORD}" },
        { action: "click", locator: "page.getByRole('button', { name: 'Sign in' })" },
      ],
      success_locator: "page.getByRole('heading', { name: 'My account' })",
    });
    expect(data.saved).toBe(".qa-mcp/auth/demo.json");
    expect(data.landed_on).toBe(`${demo.url}/account.html`);
    expect(raw).not.toContain(PASSWORD);
    expect(await fs.readFile(path.join(work, ".gitignore"), "utf8")).toContain(".qa-mcp/auth/");
  });

  it("explore_page without a login lands on the login page; with storage_state it sees the account", async () => {
    const anon = (await call("explore_page", { url: `${demo.url}/account.html` })).data;
    expect(anon.url).toBe(`${demo.url}/login.html`);
    const authed = (await call("explore_page", { url: `${demo.url}/account.html`, session: { storage_state: ".qa-mcp/auth/demo.json" } })).data;
    expect(authed.url).toBe(`${demo.url}/account.html`);
    expect(authed.elements.map((e: { best?: string }) => e.best)).toContain("page.getByRole('button', { name: 'View orders' })");
  });

  it("explore_page can reach a page by running steps, and refuses storage files outside the project", async () => {
    const viaSteps = (await call("explore_page", {
      url: `${demo.url}/login.html`,
      session: {
        steps: [
          { action: "fill", locator: "page.getByLabel('Email address')", value: "alex@example.com" },
          { action: "fill", locator: "page.getByLabel('Password')", value: "${ENV:DEMO_PASSWORD}" },
          { action: "click", locator: "page.getByRole('button', { name: 'Sign in' })" },
          { action: "click", locator: "page.getByRole('button', { name: 'View orders' })" },
          { action: "wait_for", locator: "page.getByText('Order #1001 – Trail backpack')" },
        ],
      },
      interactive_only: false,
    })).data;
    expect(viaSteps.url).toBe(`${demo.url}/account.html`);
    expect(viaSteps.steps_run).toHaveLength(5);
    expect(JSON.stringify(viaSteps)).not.toContain(PASSWORD);
    await expect(call("explore_page", { url: `${demo.url}/login.html`, session: { storage_state: "../../secrets.json" } }))
      .rejects.toThrow(/inside the project/);
  });

  it("heal-ci heals, verifies, reverts and reports after a redesign", async () => {
    const session = { storage_state: ".qa-mcp/auth/demo.json" };
    await call("capture_baseline", {
      url: `${demo.url}/account.html`,
      session,
      locators: ["page.locator('#view-orders')", "page.getByRole('link', { name: 'Edit profile' })", "page.locator('#cart-btn')"],
    });
    const v1 = await runTests(work);
    expect(v1.passed).toBe(4);

    await fs.mkdir(path.join(work, ".qa-mcp"), { recursive: true });
    await fs.writeFile(path.join(work, ".qa-mcp/heal.config.json"), JSON.stringify({
      baseUrl: demo.url,
      targets: [{ spec: "account.spec.ts", url: "/account.html", session }],
    }));
    demo.setVersion("v2");
    const specFile = path.join(work, "tests/account.spec.ts");
    const before = await fs.readFile(specFile, "utf8");

    // Dry run: suggestions only, file untouched.
    const dry = await healCi(work, { apply: false });
    expect(dry.report.counts.suggested).toBe(2);
    expect(await fs.readFile(specFile, "utf8")).toBe(before);

    const { report, markdownPath } = await healCi(work, { apply: true });
    const by = (loc: string) => report.items.find((i) => i.locator.includes(loc))!;

    expect(by("#view-orders")).toMatchObject({ outcome: "applied", verified: true, suggestion: "page.getByRole('button', { name: 'View orders' })" });
    expect(by("#view-orders").confidence).toBeGreaterThanOrEqual(0.7);
    expect(by("#view-orders").runnerUp?.locator).toBe("page.getByRole('button', { name: 'View returns' })");
    expect(by("#cart-btn")).toMatchObject({ outcome: "reverted", verified: false });
    expect(["needs_review", "not_found"]).toContain(by("Edit profile").outcome);
    expect(report.otherFailures.map((f) => f.test)).toContain("Account › has the account title");

    const after = await fs.readFile(specFile, "utf8");
    expect(after).toContain("page.getByRole('button', { name: 'View orders' }).click()");
    expect(after).toContain("page.locator('#cart-btn')"); // reverted
    const md = await fs.readFile(markdownPath, "utf8");
    expect(md).toContain("**1 healed and verified**");
    expect(md).toContain("### Needs a person");
    expect(md).toContain("### Failures not caused by locators");
  });
});
