/**
 * The shared review_user_story cases (test/fixtures/review_cases.json). The same file is in
 * k11 Selenium QA (tests/fixtures/review_cases.json), whose Python implementation must produce
 * exactly these questions too, so the two tools can't drift apart. Change both together.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewStory } from "../src/clarify.js";
import { parseStory } from "../src/story.js";

interface Case { name: string; story: string; context?: string; expect: { ready: boolean; questions: { kind: string; question: string; quote?: string }[] } }
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/review_cases.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("shared review cases (also run by k11 Selenium QA)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = reviewStory(parseStory(c.story), c.story, c.context);
    const got = r.questions.map(({ kind, question, quote }) => ({ kind, question, ...(quote ? { quote } : {}) }));
    expect({ ready: r.ready, questions: got }).toEqual(c.expect);
  });

  it("cover every question kind, and stories that must get none", () => {
    const kinds = new Set(cases.flatMap((c) => c.expect.questions.map((q) => q.kind)));
    expect([...kinds].sort()).toEqual(["criteria", "failure-path", "limit", "outcome", "precondition", "role", "undefined-term", "vague-term"]);
    expect(cases.filter((c) => c.expect.ready).length).toBeGreaterThanOrEqual(3);
  });
});
