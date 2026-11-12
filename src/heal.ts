/**
 * Self-healing locators.
 *
 * When a locator stops matching, compare every element on the current page with
 * the element's last known fingerprint (from a baseline captured while the test
 * passed, or implied by the locator itself) and propose the best replacement.
 * Suggestions are never applied automatically: the caller decides.
 */
import type { Page } from "playwright";
import { countMatches, impliedFingerprint, LocatorSpec, render } from "./locators.js";
import { Fingerprint, fingerprintPage, uniqueLocators } from "./snapshot.js";

export type Reference = Partial<Record<keyof Fingerprint, string>>;

const SYNONYMS: Record<string, string> = {
  btn: "button", pwd: "password", passwd: "password", pass: "password", signin: "login", logon: "login",
  login: "login", log: "login", sign: "login", mail: "email", "e-mail": "email", usr: "user",
  username: "user", submit: "send", qty: "quantity", del: "delete", remove: "delete", nav: "navigation",
};

export function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => SYNONYMS[t] ?? t);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** 0..1 similarity: best of token overlap and normalised edit distance. */
export function textSimilarity(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  const x = [...ta].join(" ");
  const y = [...tb].join(" ");
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length, 1);
  return Math.max(inter / union, lev);
}

/** Feature weights; only features present in the reference count. */
const WEIGHTS: [keyof Fingerprint, number, "exact" | "fuzzy"][] = [
  ["testId", 3, "exact"],
  ["name", 2.5, "fuzzy"],
  ["id", 2, "fuzzy"],
  ["role", 1.5, "exact"],
  ["nameAttr", 1.5, "fuzzy"],
  ["text", 1.5, "fuzzy"],
  ["label", 1.5, "fuzzy"],
  ["placeholder", 1, "fuzzy"],
  ["type", 1, "exact"],
  ["tag", 1, "exact"],
  ["classes", 1, "fuzzy"],
  ["href", 1, "fuzzy"],
];

export interface Scored {
  element: Fingerprint;
  score: number;
  reasons: string[];
}

export function score(ref: Reference, el: Fingerprint): Scored {
  let total = 0;
  let got = 0;
  const reasons: string[] = [];
  for (const [key, w, mode] of WEIGHTS) {
    const r = ref[key];
    if (r === undefined || r === "") continue;
    total += w;
    const v = el[key] as string | undefined;
    const s = mode === "exact" ? (v !== undefined && v.toLowerCase() === String(r).toLowerCase() ? 1 : 0) : textSimilarity(String(r), v);
    got += w * s;
    if (s >= 0.99) {
      reasons.push(v !== undefined && v.toLowerCase() !== String(r).toLowerCase()
        ? `${key} equivalent: "${r}" → "${v}"`
        : `${key} matches`);
    }
    else if (s >= 0.4) reasons.push(`${key} similar (${Math.round(s * 100)}%): "${r}" → "${v}"`);
    else if (v !== undefined && mode === "exact") reasons.push(`${key} differs: "${r}" → "${v}"`);
  }
  return { element: el, score: total ? got / total : 0, reasons };
}

export function rank(ref: Reference, elements: Fingerprint[], top = 3): Scored[] {
  return elements
    .filter((e) => e.visible)
    .map((e) => score(ref, e))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

export interface HealResult {
  status: "healthy" | "healed" | "needs_review" | "ambiguous" | "not_found" | "unparseable";
  original: string;
  matches?: number;
  suggestion?: string;
  confidence?: number;
  reasons?: string[];
  candidates?: { locator?: string; score: number; reasons: string[] }[];
  referenceSource?: "baseline" | "implied";
  note?: string;
}

export const AUTO_SCORE = 0.55;
export const AUTO_MARGIN = 0.1;

export async function heal(page: Page, original: string, spec: LocatorSpec | null, baseline?: Reference): Promise<HealResult> {
  if (!spec) {
    return { status: "unparseable", original, note: "Use a single getByRole/getByTestId/getByLabel/getByPlaceholder/getByText/locator expression." };
  }
  const matches = await countMatches(page, spec);
  if (matches === 1) return { status: "healthy", original: render(spec), matches };

  const ref: Reference = baseline ?? (impliedFingerprint(spec) as Reference);
  const elements = await fingerprintPage(page, 400);
  const ranked = rank(ref, elements, 3);
  const withLocators = [];
  for (const r of ranked) {
    const uniq = await uniqueLocators(page, r.element);
    withLocators.push({ locator: uniq[0], score: Math.round(r.score * 100) / 100, reasons: r.reasons });
  }
  const best = withLocators[0];
  const margin = best && withLocators[1] ? best.score - withLocators[1].score : best ? best.score : 0;
  const base: HealResult = {
    status: "needs_review",
    original: render(spec),
    matches,
    candidates: withLocators,
    referenceSource: baseline ? "baseline" : "implied",
  };
  if (!best || best.score < 0.3) return { ...base, status: "not_found", note: "No element on the page resembles the original." };
  if (matches > 1) base.status = "ambiguous";
  if (best.locator && best.score >= AUTO_SCORE && margin >= AUTO_MARGIN) {
    return { ...base, status: matches > 1 ? "ambiguous" : "healed", suggestion: best.locator, confidence: best.score, reasons: best.reasons };
  }
  return {
    ...base,
    suggestion: best.locator,
    confidence: best.score,
    reasons: best.reasons,
    note: !baseline
      ? "No baseline fingerprint for this locator, so matching used only what the locator itself implies. Run capture_baseline while tests pass to make healing more reliable."
      : "Best match is not clearly better than the alternatives; confirm before applying.",
  };
}
