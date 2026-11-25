/**
 * Review a user story before generating tests from it: what would a careful tester ask first?
 *
 * Generating tests from an unclear story doesn't remove the ambiguity; it hides it inside test
 * code, as guesses nobody agreed to. This review finds the gaps and turns each into a question
 * for a person to answer, with the reason it matters and, where it applies, the exact words in
 * the story that raised it.
 *
 * The rules are deterministic, so the same story always gets the same questions, and they can
 * be tested. The agent may ask more, but should never ask fewer.
 *
 *   outcome       a scenario has no observable result, or the result is vague ("works", "correctly")
 *   criteria      no acceptance criteria at all; the only "scenario" is the goal itself
 *   role          no user role (permissions and test accounts depend on it)
 *   vague-term    words a test can't check: fast, easy, many, appropriate, user-friendly...
 *   limit         a limit or threshold without a number ("up to", "maximum", "expires")
 *   failure-path  no scenario says what happens when things go wrong
 *   precondition  scenarios with actions but no starting state (who is signed in, what data exists)
 *   undefined-term  with context: a term the story relies on that the context never explains
 */
import type { Story } from "./story.js";

export type QuestionKind =
  | "outcome" | "criteria" | "role" | "vague-term" | "limit" | "failure-path" | "precondition" | "undefined-term";

export interface Question {
  kind: QuestionKind;
  question: string;
  why: string;
  quote?: string;
}

export interface Review {
  ready: boolean;
  questions: Question[];
  assumptions: string[];
}

const VAGUE = [
  "fast", "quickly", "quick", "slow", "easy", "easily", "simple", "simply", "intuitive", "user-friendly", "user friendly",
  "seamless", "seamlessly", "many", "several", "some", "few", "large", "small", "appropriate", "appropriately",
  "properly", "correctly", "as needed", "as expected", "efficient", "efficiently", "reasonable", "secure", "robust",
  "and/or", "etc", "usually", "normally", "relevant", "nice", "better",
];
const VAGUE_OUTCOME = /\b(works?|working|is successful|succeeds?|correctly|properly|as expected|is handled|handles it|is fine|is ok(ay)?)\b/i;
const OBSERVABLE = /\b(see|sees|shown?|shows|display(s|ed)?|visible|message|redirect(s|ed)?|page|url|receives?|email|download(s|ed)?|disabled|enabled|error|text|title|heading|count|list|button|link|status|toast|banner|notification|"[^"]+")\b/i;
const FAILURE = /\b(invalid|wrong|incorrect|error|fail(s|ed|ure)?|denied|forbidden|unauthori[sz]ed|expired?|empty|missing|blank|not\b|no\b|cannot|can't|unknown|locked|timeout|offline|duplicate|too (long|many|short))\b/i;
const LIMIT = /\b(up to|at most|at least|maximum|minimum|max|min|limit(ed)?|expire(s|d)?|timeout|within|no more than|no less than|threshold|retries|attempts)\b/i;
const HAS_NUMBER = /\d/;
const STOP_TERMS = new Set(["As", "I", "Given", "When", "Then", "And", "But", "Scenario", "Title", "Story", "Feature",
  "Acceptance", "AC", "The", "A", "An", "If", "So", "On", "In", "My", "Our", "This", "That", "It"]);

function sentences(text: string): string[] {
  return text.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^[-*•]\s*|^\d+[.)]\s*/, "").trim()).filter(Boolean);
}

function wordRe(term: string): RegExp {
  return new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z]|$)`, "i");
}

/** Terms a story relies on: quoted phrases and Capitalised Multi Word names that aren't sentence starts. */
function namedTerms(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/"([^"]{2,40})"/g)) out.add(m[1].trim());
  for (const s of sentences(raw)) {
    const words = s.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const run: string[] = [];
      while (i < words.length && /^[A-Z][a-zA-Z0-9-]+$/.test(words[i].replace(/[,.;:!?)]+$/, "")) && !STOP_TERMS.has(words[i])) {
        run.push(words[i].replace(/[,.;:!?)]+$/, ""));
        i++;
      }
      if (run.length) out.add(run.join(" "));
    }
  }
  return [...out];
}

export function reviewStory(story: Story, raw: string, context?: string): Review {
  const questions: Question[] = [];
  const all = sentences(raw);
  const onlyGoal = story.scenarios.length === 1 && story.scenarios[0].steps.length === 1
    && story.scenarios[0].steps[0].keyword === "Check" && story.scenarios[0].steps[0].text === story.goal;

  if (!story.scenarios.length || onlyGoal) {
    questions.push({
      kind: "criteria",
      question: "What are the acceptance criteria? List what must be true for this story to be done.",
      why: "Without criteria, tests can only check that the page loads, and anything else they assert is a guess.",
    });
  } else {
    for (const sc of story.scenarios) {
      const outcomes = sc.steps.filter((s) => s.keyword === "Then" || s.keyword === "Check");
      const text = outcomes.map((s) => s.text).join(" ");
      if (!outcomes.length) {
        questions.push({
          kind: "outcome",
          question: `In "${sc.name}", what should the user see or what should change at the end?`,
          why: "A scenario with no Then has nothing to assert.",
        });
      } else if (VAGUE_OUTCOME.test(text) && !OBSERVABLE.test(text)) {
        questions.push({
          kind: "outcome",
          question: `In "${sc.name}", what exactly shows that it worked: a message, a page, a value, an email?`,
          why: "\"Works\" or \"correctly\" can't be asserted; a test needs something observable.",
          quote: outcomes.map((s) => `${s.keyword} ${s.text}`).join("; "),
        });
      }
      const acts = sc.steps.some((s) => s.keyword === "When");
      if (acts && !sc.steps.some((s) => s.keyword === "Given")) {
        questions.push({
          kind: "precondition",
          question: `In "${sc.name}", what is the starting state: who is signed in, and what data already exists?`,
          why: "Tests need set-up; guessing it makes them pass for the wrong reason or fail on a clean environment.",
        });
      }
    }
  }

  if (!story.role) {
    questions.push({
      kind: "role",
      question: "Who is the user: a visitor, a signed-in customer, an admin? Does anyone else get different behaviour?",
      why: "Permissions, test accounts and what the page shows all depend on the role.",
    });
  }

  const seen = new Set<string>();
  const outcomeQuotes = new Set(questions.filter((q) => q.kind === "outcome" && q.quote).flatMap((q) => q.quote!.split("; ")));
  for (const s of all) {
    for (const term of VAGUE) {
      if (outcomeQuotes.has(s)) continue;                 // already asked about as a vague outcome
      if (wordRe(term).test(s) && !seen.has(term)) {
        seen.add(term);
        questions.push({
          kind: "vague-term",
          question: `"${term}" can't be tested as written. What is the measurable version (a number, a time, a specific behaviour)?`,
          why: "A test needs a threshold or a concrete expectation.",
          quote: s,
        });
      }
    }
    if (LIMIT.test(s) && !HAS_NUMBER.test(s)) {
      questions.push({
        kind: "limit",
        question: "What is the actual number for this limit, and what happens exactly at it and one past it?",
        why: "Boundary tests need the boundary.",
        quote: s,
      });
    }
  }

  const scenarioText = story.scenarios.map((sc) => `${sc.name} ${sc.steps.map((s) => s.text).join(" ")}`).join(" ");
  if (story.scenarios.length && !onlyGoal && !FAILURE.test(scenarioText)) {
    questions.push({
      kind: "failure-path",
      question: "What should happen when it goes wrong: invalid input, no permission, an expired session, a server error?",
      why: "Every scenario is a success path, so failures are untested; this is where most production bugs are.",
    });
  }

  if (context) {
    for (const term of namedTerms(raw)) {
      if (!wordRe(term).test(context)) {
        questions.push({
          kind: "undefined-term",
          question: `What does "${term}" mean here? The context provided doesn't mention it.`,
          why: "The story depends on it, and a test built on a wrong reading checks the wrong thing.",
          quote: term,
        });
      }
    }
  }

  const assumptions = [
    !story.role ? "The tests will use a standard signed-in user." : `The tests will use a ${story.role} account.`,
    "Anything a question above asks about will be left as a TODO, not guessed.",
  ];
  return { ready: questions.length === 0, questions, assumptions };
}
