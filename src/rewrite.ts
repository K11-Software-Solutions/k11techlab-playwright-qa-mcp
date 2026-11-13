/**
 * Replace a locator in test source code.
 *
 * Finds Playwright locator calls (`.getByRole(...)`, `.locator(...)`, ...) by
 * scanning the source with string-aware bracket matching, parses each call with
 * the same safe parser as the tools, and replaces only calls equivalent to the
 * broken locator. The receiver (`page`, `this.page`, a fixture) is kept.
 */
import { parseLocator, render, type LocatorSpec } from "./locators.js";

export interface Replacement {
  line: number;
  before: string;
  after: string;
}

const CALL_RE = /\.(getBy(?:Role|TestId|Label|Placeholder|Text)|locator)\s*\(/g;

/** Index of the parenthesis that closes the one at `open`, skipping strings and template literals. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

export function sameLocator(a: LocatorSpec, b: LocatorSpec): boolean {
  return a.kind === b.kind && a.value === b.value && (a.name ?? null) === (b.name ?? null);
}

/** Call text without the receiver, e.g. getByRole('button', { name: 'Log in' }). */
export function renderCall(spec: LocatorSpec): string {
  return render(spec).replace(/^page\./, "");
}

export function replaceLocator(source: string, broken: LocatorSpec, healed: LocatorSpec): { code: string; replacements: Replacement[] } {
  const edits: { start: number; end: number; before: string }[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(source))) {
    const start = m.index + 1; // skip the dot
    const open = source.indexOf("(", start);
    const close = closingParen(source, open);
    if (close < 0) continue;
    const call = source.slice(start, close + 1);
    const spec = parseLocator(call);
    if (spec && sameLocator(spec, broken)) edits.push({ start, end: close + 1, before: call });
  }
  const after = renderCall(healed);
  let code = source;
  const replacements: Replacement[] = [];
  for (const e of [...edits].reverse()) {
    replacements.unshift({ line: source.slice(0, e.start).split("\n").length, before: e.before, after });
    code = code.slice(0, e.start) + after + code.slice(e.end);
  }
  return { code, replacements };
}

/** Last literal page.goto('...') at or before a line: where the test was when it failed. */
export function lastGotoBefore(source: string, line?: number): string | undefined {
  const upto = line ? source.split("\n").slice(0, line).join("\n") : source;
  const all = [...upto.matchAll(/\.goto\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)];
  const last = all[all.length - 1];
  return last && !last[2].includes("${") ? last[2] : undefined;
}
