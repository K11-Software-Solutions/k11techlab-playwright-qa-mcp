/**
 * Page exploration: fingerprint interactive and meaningful elements, then
 * propose locators for each and keep only those that match exactly one
 * element on the live page.
 */
import type { Page } from "playwright";
import { countMatches, LocatorSpec, PRIORITY, render } from "./locators.js";

export interface Fingerprint {
  index: number;
  tag: string;
  role?: string;
  name?: string; // approximate accessible name
  text?: string;
  id?: string;
  nameAttr?: string;
  testId?: string;
  type?: string;
  placeholder?: string;
  label?: string;
  classes?: string;
  href?: string;
  visible: boolean;
  probe?: boolean; // internal: element marked by fingerprintOf()
}

export interface ExploredElement extends Fingerprint {
  best?: string; // most stable unique locator, rendered
  alternatives: string[];
}

/** Runs inside the browser. Must be self-contained. */
function collect(maxElements: number): Fingerprint[] {
  const SELECTOR = [
    "a[href]", "button", "input", "select", "textarea", "[role]", "h1", "h2", "h3",
    "[data-testid]", "[data-test]", "[data-qa]", "label", "img[alt]", "[contenteditable=true]",
    "[data-qa-mcp-probe]",
  ].join(",");
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const implicitRole = (el: Element): string | undefined => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (el.getAttribute("role")) return el.getAttribute("role") ?? undefined;
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img" && el.getAttribute("alt")) return "img";
    if (tag === "input") {
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (["text", "email", "search", "tel", "url"].includes(type)) return type === "search" ? "searchbox" : "textbox";
    }
    return undefined;
  };
  const labelFor = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l) return clean(l.textContent);
    }
    const wrap = el.closest("label");
    return wrap ? clean(wrap.textContent) : "";
  };
  const accName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" "));
    const tag = el.tagName.toLowerCase();
    if (["input", "select", "textarea"].includes(tag)) {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (["submit", "button", "reset"].includes(type)) return clean((el as HTMLInputElement).value);
      return labelFor(el) || clean(el.getAttribute("title")) || clean(el.getAttribute("placeholder"));
    }
    if (tag === "img") return clean(el.getAttribute("alt"));
    return clean((el as HTMLElement).innerText ?? el.textContent) || clean(el.getAttribute("title"));
  };
  const out: Fingerprint[] = [];
  const els = Array.from(document.querySelectorAll(SELECTOR));
  for (let i = 0; i < els.length && out.length < maxElements; i++) {
    const el = els[i] as HTMLElement;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.getAttribute("type") ?? "") === "hidden") continue;
    const fp: Fingerprint = { index: out.length, tag, visible };
    const set = (k: keyof Fingerprint, v: string | undefined | null) => {
      const c = clean(v);
      if (c) (fp as unknown as Record<string, unknown>)[k] = c.slice(0, 120);
    };
    set("role", implicitRole(el));
    set("name", accName(el));
    set("text", tag === "input" ? "" : (el.innerText ?? el.textContent));
    set("id", el.getAttribute("id"));
    set("nameAttr", el.getAttribute("name"));
    set("testId", el.getAttribute("data-testid") ?? el.getAttribute("data-test") ?? el.getAttribute("data-qa"));
    set("type", el.getAttribute("type"));
    set("placeholder", el.getAttribute("placeholder"));
    set("label", ["input", "select", "textarea"].includes(tag) ? labelFor(el) : "");
    set("classes", el.getAttribute("class"));
    set("href", el.getAttribute("href"));
    if (el.hasAttribute("data-qa-mcp-probe")) fp.probe = true;
    out.push(fp);
  }
  return out;
}

export async function fingerprintPage(page: Page, maxElements = 150): Promise<Fingerprint[]> {
  return page.evaluate(collect, maxElements);
}

/** Fingerprint of the single element a locator matches (used for baselines). */
export async function fingerprintOf(page: Page, locator: import("playwright").Locator): Promise<Fingerprint | undefined> {
  await locator.evaluate((el) => el.setAttribute("data-qa-mcp-probe", "1"));
  try {
    const fp = (await fingerprintPage(page, 2000)).find((f) => f.probe);
    if (!fp) return undefined;
    const { probe: _probe, index: _index, visible: _visible, ...rest } = fp;
    return { ...rest, index: -1, visible: true };
  } finally {
    await locator.evaluate((el) => el.removeAttribute("data-qa-mcp-probe")).catch(() => undefined);
  }
}

/** Candidate locators for one element, most stable first (not yet verified). */
export function candidates(fp: Fingerprint): LocatorSpec[] {
  const out: LocatorSpec[] = [];
  if (fp.testId) out.push({ kind: "testid", value: fp.testId });
  if (fp.role && fp.name) out.push({ kind: "role", value: fp.role, name: fp.name });
  if (fp.label) out.push({ kind: "label", value: fp.label });
  if (fp.placeholder) out.push({ kind: "placeholder", value: fp.placeholder });
  if (fp.text && fp.text.length <= 60 && !["input", "select", "textarea"].includes(fp.tag))
    out.push({ kind: "text", value: fp.text });
  if (fp.id && /^[A-Za-z][\w-]*$/.test(fp.id)) out.push({ kind: "css", value: `#${fp.id}` });
  if (fp.nameAttr) out.push({ kind: "css", value: `${fp.tag}[name="${fp.nameAttr}"]` });
  return out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

/** Keep candidates that match exactly one element on the live page. */
export async function uniqueLocators(page: Page, fp: Fingerprint): Promise<string[]> {
  const ok: string[] = [];
  for (const spec of candidates(fp)) {
    if ((await countMatches(page, spec)) === 1) ok.push(render(spec));
  }
  return ok;
}

export async function explore(page: Page, maxElements = 80, onlyInteractive = false): Promise<ExploredElement[]> {
  const fps = await fingerprintPage(page, maxElements * 2);
  const interactive = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "listbox", "spinbutton", "slider", "tab", "menuitem", "switch", "option"]);
  const picked = fps
    .filter((f) => f.visible)
    .filter((f) => !onlyInteractive || (f.role !== undefined && interactive.has(f.role)) || ["input", "select", "textarea"].includes(f.tag))
    .slice(0, maxElements);
  const out: ExploredElement[] = [];
  for (const fp of picked) {
    const uniq = await uniqueLocators(page, fp);
    out.push({ ...fp, best: uniq[0], alternatives: uniq.slice(1) });
  }
  return out;
}
