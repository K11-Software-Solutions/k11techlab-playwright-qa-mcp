/**
 * Locator specs: a small, safe representation of Playwright locators.
 *
 * Locator strings coming from tests or from the model are PARSED, never eval'd.
 * Only the stable, user-facing strategies Playwright recommends are supported,
 * plus a CSS fallback.
 */
import type { Locator, Page } from "playwright";

export type LocatorKind = "testid" | "role" | "label" | "placeholder" | "text" | "css";

export interface LocatorSpec {
  kind: LocatorKind;
  value: string; // role name for "role", otherwise the text / id / selector
  name?: string; // accessible name, only for "role"
}

/** Lower number = more stable. Mirrors Playwright's own locator guidance. */
export const PRIORITY: Record<LocatorKind, number> = {
  testid: 0,
  role: 1,
  label: 2,
  placeholder: 3,
  text: 4,
  css: 5,
};

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function render(spec: LocatorSpec): string {
  switch (spec.kind) {
    case "testid":
      return `page.getByTestId(${q(spec.value)})`;
    case "role":
      return spec.name !== undefined
        ? `page.getByRole(${q(spec.value)}, { name: ${q(spec.name)} })`
        : `page.getByRole(${q(spec.value)})`;
    case "label":
      return `page.getByLabel(${q(spec.value)})`;
    case "placeholder":
      return `page.getByPlaceholder(${q(spec.value)})`;
    case "text":
      return `page.getByText(${q(spec.value)})`;
    case "css":
      return `page.locator(${q(spec.value)})`;
  }
}

const STR = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60((?:[^\x60\\]|\\.)*)\x60)`;
const unq = (m: RegExpMatchArray, i: number) =>
  (m[i] ?? m[i + 1] ?? m[i + 2] ?? "").replace(/\\(.)/g, "$1");

/**
 * Parse a single Playwright locator expression such as
 *   page.getByRole('button', { name: 'Sign in' })   getByTestId("login")   locator('#id')
 * Returns null for anything else (chains, filters, arbitrary code).
 */
export function parseLocator(input: string): LocatorSpec | null {
  const s = input.trim().replace(/;$/, "").replace(/^(?:await\s+)?(?:this\.)?(?:page\.)?/, "");
  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(String.raw`^getByRole\(\s*${STR}\s*(?:,\s*\{\s*name\s*:\s*${STR}\s*(?:,\s*exact\s*:\s*(?:true|false)\s*)?\}\s*)?\)$`)))) {
    const name = m[4] !== undefined || m[5] !== undefined || m[6] !== undefined ? unq(m, 4) : undefined;
    return { kind: "role", value: unq(m, 1), ...(name !== undefined ? { name } : {}) };
  }
  const simple: [RegExp, LocatorKind][] = [
    [new RegExp(String.raw`^getByTestId\(\s*${STR}\s*\)$`), "testid"],
    [new RegExp(String.raw`^getByLabel\(\s*${STR}\s*(?:,\s*\{[^}]*\})?\s*\)$`), "label"],
    [new RegExp(String.raw`^getByPlaceholder\(\s*${STR}\s*(?:,\s*\{[^}]*\})?\s*\)$`), "placeholder"],
    [new RegExp(String.raw`^getByText\(\s*${STR}\s*(?:,\s*\{[^}]*\})?\s*\)$`), "text"],
    [new RegExp(String.raw`^locator\(\s*${STR}\s*\)$`), "css"],
  ];
  for (const [re, kind] of simple) {
    if ((m = s.match(re))) return { kind, value: unq(m, 1) };
  }
  return null;
}

export function toPlaywright(page: Page, spec: LocatorSpec): Locator {
  switch (spec.kind) {
    case "testid":
      return page.getByTestId(spec.value);
    case "role":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return page.getByRole(spec.value as any, spec.name !== undefined ? { name: spec.name, exact: true } : {});
    case "label":
      return page.getByLabel(spec.value, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(spec.value, { exact: true });
    case "text":
      return page.getByText(spec.value, { exact: true });
    case "css":
      return page.locator(spec.value);
  }
}

/** Count matches on the live page; invalid selectors count as 0. */
export async function countMatches(page: Page, spec: LocatorSpec): Promise<number> {
  try {
    return await toPlaywright(page, spec).count();
  } catch {
    return 0;
  }
}

/** Best-effort partial fingerprint implied by a locator, used when no baseline exists. */
export function impliedFingerprint(spec: LocatorSpec): Record<string, string> {
  switch (spec.kind) {
    case "testid":
      return { testId: spec.value };
    case "role":
      return spec.name !== undefined ? { role: spec.value, name: spec.name } : { role: spec.value };
    case "label":
      return { name: spec.value };
    case "placeholder":
      return { placeholder: spec.value };
    case "text":
      return { text: spec.value };
    case "css": {
      const out: Record<string, string> = {};
      const id = spec.value.match(/#([\w-]+)/);
      if (id) out.id = id[1];
      const tag = spec.value.match(/^([a-z][a-z0-9]*)/i);
      if (tag) out.tag = tag[1].toLowerCase();
      const attr = spec.value.match(/\[(?:data-testid|data-test|data-qa)=["']?([^"'\]]+)/);
      if (attr) out.testId = attr[1];
      const nameAttr = spec.value.match(/\[name=["']?([^"'\]]+)/);
      if (nameAttr) out.nameAttr = nameAttr[1];
      const classes = [...spec.value.matchAll(/\.([\w-]+)/g)].map((c) => c[1]);
      if (classes.length) out.classes = classes.join(" ");
      return out;
    }
  }
}
