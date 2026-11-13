import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runTests } from "../src/project.js";
import { closeBrowser, createServer } from "../src/server.js";

const fixture = path.resolve("test/fixtures/project");
const v1 = pathToFileURL(path.resolve("demo/v1/login.html")).href;
const v2 = pathToFileURL(path.resolve("demo/v2/login.html")).href;

describe("run_tests", () => {
  it("runs Playwright and reports the broken locator", async () => {
    const r = await runTests(fixture);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    const broken = r.tests.find((t) => t.status !== "passed")!;
    expect(broken.title).toContain("fragile CSS locator");
    expect(broken.failingLocator).toBe("locator('#login-btn')");
  });
});

describe("MCP server over the protocol", () => {
  const prevRoot = process.env.QA_MCP_ROOT;
  const tmpRoot = path.resolve("test/.tmp-root");
  afterAll(async () => {
    await closeBrowser();
    process.env.QA_MCP_ROOT = prevRoot;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("lists tools and prompts, and the full capture → heal loop works", async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    process.env.QA_MCP_ROOT = tmpRoot;
    const server = createServer();
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["capture_baseline", "check_locator", "explore_page", "heal_locator", "parse_user_story", "run_tests", "save_login_state", "write_test"]);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("story_to_playwright");

    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

    const story = text(await client.callTool({ name: "parse_user_story", arguments: { story: "As a shopper, I want to sign in.\n- Valid login shows my name", url: v1 } }));
    expect(story.skeleton).toContain("test('Valid login shows my name'");

    const written = text(await client.callTool({ name: "write_test", arguments: { path: "login.spec.ts", code: story.skeleton } }));
    expect(written.written).toBe("tests/login.spec.ts");
    const again = await client.callTool({ name: "write_test", arguments: { path: "login.spec.ts", code: "x" } });
    expect(again.isError).toBe(true);
    const escape = await client.callTool({ name: "write_test", arguments: { path: "../../oops.spec.ts", code: "x" } });
    expect(escape.isError).toBe(true);

    const cap = text(await client.callTool({ name: "capture_baseline", arguments: { url: v1, locators: ["page.locator('#login-btn')", "page.locator('#nope')"] } }));
    expect(cap.captured).toEqual(["page.locator('#login-btn')"]);
    expect(cap.skipped[0].reason).toContain("0 elements");

    const healed = text(await client.callTool({ name: "heal_locator", arguments: { url: v2, locator: "page.locator('#login-btn')" } }));
    expect(healed.status).toBe("healed");
    expect(healed.referenceSource).toBe("baseline");
    expect(healed.suggestion).toBe("page.getByRole('button', { name: 'Log in' })");

    const check = text(await client.callTool({ name: "check_locator", arguments: { url: v2, locator: healed.suggestion } }));
    expect(check.verdict).toBe("unique");

    await client.close();
  });
});
