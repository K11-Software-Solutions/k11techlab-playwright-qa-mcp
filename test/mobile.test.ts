/**
 * Mobile web: device profiles, per-device baselines, cross-device checks, and heal-ci
 * across Playwright projects (desktop + "Mobile Chrome").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DESKTOP, deviceForProject, listDevices, resolveDevice } from "../src/devices.js";
import { healCi } from "../src/healci.js";
import { pageKey } from "../src/store.js";
import { closeBrowser, createServer } from "../src/server.js";

/** A responsive shop page: separate desktop and mobile checkout buttons (one hidden by CSS). */
function shopHtml(desktopLabel: string, mobileLabel: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shop</title><style>
  .mob { display: none } @media (max-width: 700px) { .desk { display: none } .mob { display: block } }
</style></head><body>
  <nav class="desk"><a href="#">Home</a><a href="#">Deals</a><button id="checkout-desktop" data-testid="checkout-desktop">${desktopLabel}</button></nav>
  <div class="mob"><button aria-label="Open menu">☰</button><button id="checkout-mobile" data-testid="checkout-mobile">${mobileLabel}</button></div>
  <p id="msg"></p>
  <script>for (const b of document.querySelectorAll('[id^=checkout]')) b.onclick = () => (document.getElementById('msg').textContent = 'Checkout started');</script>
</body></html>`;
}

describe("device profiles", () => {
  it("resolves names, desktop and Playwright projects", () => {
    expect(resolveDevice(undefined)).toBe(DESKTOP);
    expect(resolveDevice("iphone 15")).toBe("iPhone 15");
    expect(resolveDevice("Desktop Chrome")).toBe(DESKTOP);
    expect(() => resolveDevice("iPhone 99")).toThrow(/Unknown device.*iPhone/);
    expect(deviceForProject("Mobile Chrome").device).toBe("Pixel 5");
    expect(deviceForProject("Mobile Safari").device).toBe("iPhone 12");
    expect(deviceForProject("chromium").device).toBe(DESKTOP);
    expect(deviceForProject("Pixel 7").device).toBe("Pixel 7");
    expect(deviceForProject("phones", { phones: "iPhone 15" })).toEqual({ device: "iPhone 15", how: "heal.config.json projects mapping" });
    expect(deviceForProject("my-project").how).toMatch(/assumed desktop/);
    const l = listDevices();
    expect(l.phones).toContain("iPhone 15");
    expect(l.tablets.some((t) => t.startsWith("iPad"))).toBe(true);
  });

  it("keeps baselines apart per device, and desktop keys unchanged", () => {
    expect(pageKey("http://x.test/shop.html?a=1")).toBe("http://x.test/shop.html");
    expect(pageKey("http://x.test/shop.html", "iPhone 15")).toBe("http://x.test/shop.html @ iPhone 15");
  });
});

describe("mobile web with the MCP tools and heal-ci", () => {
  let labels = { desktop: "Checkout", mobile: "Checkout" };
  let server: http.Server;
  let url = "";
  const work = path.resolve("test/.tmp-mobile");
  const prevRoot = process.env.QA_MCP_ROOT;
  const prevUrl = process.env.SHOP_URL;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };

  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(shopHtml(labels.desktop, labels.mobile)); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fs.rm(work, { recursive: true, force: true });
    await fs.cp(path.resolve("test/fixtures/mobile-project"), work, { recursive: true });
    process.env.QA_MCP_ROOT = work;
    process.env.SHOP_URL = url;
    await fs.mkdir(path.join(work, ".qa-mcp"), { recursive: true });
    await fs.writeFile(path.join(work, ".qa-mcp/heal.config.json"), JSON.stringify({ baseUrl: url }), "utf8");
    const s = createServer();
    client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([s.connect(a), client.connect(b)]);
  });

  afterAll(async () => {
    await closeBrowser();
    await new Promise((r) => server.close(r));
    await fs.rm(work, { recursive: true, force: true });
    process.env.QA_MCP_ROOT = prevRoot;
    process.env.SHOP_URL = prevUrl;
  });

  it("explores the mobile layout and checks locators across devices", async () => {
    const mobile = await call("explore_page", { url: `${url}/shop.html`, device: "Pixel 5" });
    expect(mobile.device).toMatchObject({ device: "Pixel 5", isMobile: true });
    const names = mobile.elements.map((e: { name?: string }) => e.name);
    expect(names).toContain("Open menu");
    expect(names).not.toContain("Deals");                     // desktop-only nav is hidden on mobile
    const desktop = await call("explore_page", { url: `${url}/shop.html` });
    expect(desktop.device).toBeUndefined();
    expect(desktop.elements.map((e: { name?: string }) => e.name)).toContain("Deals");

    const both = await call("check_locator", { url: `${url}/shop.html`, locator: "page.getByTestId('checkout-mobile')", devices: ["desktop", "Pixel 5"] });
    expect(both.verdict).toBe("differs between devices");
    expect(both.devices).toEqual([{ device: DESKTOP, matches: 1, visible: false }, { device: "Pixel 5", matches: 1, visible: true }]);  // in the DOM on desktop, but hidden
    const role = await call("check_locator", { url: `${url}/shop.html`, locator: "page.getByRole('button', { name: 'Checkout' })", devices: ["desktop", "Pixel 5"] });
    expect(role.verdict).toBe("unique and visible on every device");
  });

  it("captures separate baselines for desktop and mobile", async () => {
    const loc = "page.getByRole('button', { name: 'Checkout' })";
    await call("capture_baseline", { url: `${url}/shop.html`, locators: [loc] });
    const m = await call("capture_baseline", { url: `${url}/shop.html`, locators: [loc], device: "Pixel 5" });
    expect(m.device).toBe("Pixel 5");
    const saved = JSON.parse(await fs.readFile(path.join(work, ".qa-mcp/baselines.json"), "utf8"));
    expect(Object.keys(saved).sort()).toEqual([`${url}/shop.html`, `${url}/shop.html @ Pixel 5`]);
    expect(saved[`${url}/shop.html @ Pixel 5`][loc].fingerprint.testId).toBe("checkout-mobile");
    expect(saved[`${url}/shop.html`][loc].fingerprint.testId).toBe("checkout-desktop");
  });

  it("heals on the mobile device and warns when the fix isn't unique on desktop", async () => {
    labels = { desktop: "Checkout", mobile: "Buy now" };
    const r = await call("heal_locator", { url: `${url}/shop.html`, locator: "page.getByRole('button', { name: 'Checkout' })",
      device: "Pixel 5", check_devices: ["desktop"] });
    expect(r.device).toBe("Pixel 5");
    expect(r.suggestion).toMatch(/Buy now|checkout-mobile/);
    expect(r.other_devices[0].device).toBe(DESKTOP);
    labels = { desktop: "Checkout", mobile: "Checkout" };
  });

  it("run_tests can target one Playwright project", async () => {
    const r = await call("run_tests", { project: "Mobile Chrome" });
    expect(r.tests.map((t: { project: string }) => t.project)).toEqual(["Mobile Chrome"]);
    expect(r.ok).toBe(true);
  });

  it("heal-ci: a redesign on both layouts is healed once, verified on desktop and mobile", async () => {
    // (Playwright matches role names by substring, so the new label must not contain "Checkout")
    labels = { desktop: "Place order", mobile: "Place order" };
    const { report } = await healCi(work, { apply: true });
    const items = report.items;
    expect(items.map((i) => [i.project, i.device, i.outcome])).toEqual(expect.arrayContaining([
      ["chromium", DESKTOP, "applied"], ["Mobile Chrome", "Pixel 5", "applied"]]));
    expect(new Set(items.map((i) => i.suggestion)).size).toBe(1);
    expect(items.every((i) => i.verified)).toBe(true);
    const spec = await fs.readFile(path.join(work, "tests/checkout.spec.ts"), "utf8");
    expect(spec).toContain("getByRole('button', { name: 'Place order' })");
    const md = await fs.readFile(path.join(work, ".qa-mcp/heal-report/heal-report.md"), "utf8");
    expect(md).toContain("starts checkout (Pixel 5)");
  });

  it("heal-ci: a mobile-only rename is not allowed to break desktop", async () => {
    const before = await fs.readFile(path.join(work, "tests/checkout.spec.ts"), "utf8");
    labels = { desktop: "Place order", mobile: "Buy now" };
    const { report } = await healCi(work, { apply: true });
    const mob = report.items.find((i) => i.project === "Mobile Chrome")!;
    expect(report.items.map((i) => i.project)).toEqual(["Mobile Chrome"]);   // desktop still passed
    expect(["reverted", "needs_review"]).toContain(mob.outcome);
    expect(await fs.readFile(path.join(work, "tests/checkout.spec.ts"), "utf8")).toBe(before);
  });
});
