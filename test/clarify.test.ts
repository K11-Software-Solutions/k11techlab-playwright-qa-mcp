import { describe, expect, it } from "vitest";
import { reviewStory, type QuestionKind } from "../src/clarify.js";
import { parseStory } from "../src/story.js";

const review = (raw: string, context?: string) => reviewStory(parseStory(raw), raw, context);
const kinds = (raw: string, context?: string) => review(raw, context).questions.map((q) => q.kind);

const CLEAR = `As a registered customer, I want to sign in so that I can see my orders.

Scenario: Valid credentials show the dashboard
  Given I am on the login page
  When I sign in with valid credentials
  Then I see "Welcome back"

Scenario: Wrong password shows an error
  Given I am on the login page
  When I sign in with a wrong password
  Then I see an error message`;

describe("review_user_story: what a tester would ask", () => {
  it("a clear story has no questions and is ready", () => {
    const r = review(CLEAR);
    expect(r.ready).toBe(true);
    expect(r.questions).toEqual([]);
  });

  it("a one-line wish asks for criteria, a role and measurable terms", () => {
    const r = review("I want the search to be fast and easy to use.");
    expect(r.ready).toBe(false);
    expect(kinds("I want the search to be fast and easy to use.")).toEqual(["criteria", "role", "vague-term", "vague-term"]);
    expect(r.questions.find((q) => q.kind === "vague-term")?.quote).toBe("I want the search to be fast and easy to use.");
  });

  it("asks what 'works correctly' looks like, once", () => {
    const raw = `As a shopper, I want to apply a discount code.
Scenario: code applies
  Given I have items in my cart
  When I enter a valid code
  Then the discount works correctly
Scenario: bad code
  Given I have items in my cart
  When I enter an invalid code
  Then I see "Code not recognised"`;
    const qs = review(raw).questions;
    expect(qs.map((q) => q.kind)).toEqual(["outcome"]);
    expect(qs[0].question).toContain('"code applies"');
    expect(qs[0].quote).toBe("Then the discount works correctly");
  });

  it("asks for the number behind a limit, but not when the number is there", () => {
    const base = `As an admin, I want to invite teammates.
Scenario: invite sent
  Given I am signed in as an admin
  When I invite a teammate by email
  Then I see "Invitation sent"
Scenario: invalid email
  Given I am signed in as an admin
  When I invite "not-an-email"
  Then I see an error message`;
    expect(kinds(`${base}\nInvitations expire after a while.`)).toContain("limit");
    expect(kinds(`${base}\nInvitations expire after 7 days.`)).not.toContain("limit");
  });

  it("asks about failures when every scenario is a happy path", () => {
    const raw = `As a customer, I want to download my invoice.
Scenario: download
  Given I have a paid order
  When I click "Download invoice"
  Then a PDF downloads`;
    expect(kinds(raw)).toEqual(["failure-path"]);
  });

  it("asks for the starting state when a scenario acts without one", () => {
    const raw = `As a customer, I want to cancel my order.
Scenario: cancel
  When I cancel my order
  Then I see "Order cancelled"
Scenario: too late
  Given my order has shipped
  When I try to cancel it
  Then I see an error message`;
    expect(kinds(raw)).toEqual(["precondition"]);
  });

  it("asks for an outcome when a scenario has no Then", () => {
    const raw = `As a customer, I want to save my address.
Scenario: save
  Given I am on my profile
  When I save a new address
Scenario: missing postcode
  Given I am on my profile
  When I save an address without a postcode
  Then I see an error message`;
    expect(kinds(raw)).toEqual(["outcome"]);
  });

  it("with context, asks about terms the context never explains", () => {
    const raw = `As a Gold Member, I want free shipping on "Express Plus" orders.
- Gold Member orders over $50 show free shipping at checkout
- Orders without membership show the standard shipping price`;
    const context = "Gold Member: customers who spent over $500 last year.";
    const qs = review(raw, context).questions.filter((q) => q.kind === "undefined-term");
    expect(qs.map((q) => q.quote)).toEqual(["Express Plus"]);
    expect(review(raw).questions.some((q) => q.kind === "undefined-term")).toBe(false);   // no context, no guessing
  });

  it("every question says why it matters", () => {
    const qs = review("I want the search to be fast and easy to use, with several filters as needed.").questions;
    expect(qs.length).toBeGreaterThan(3);
    for (const q of qs) expect(q.why.length).toBeGreaterThan(20);
  });

  it("is deterministic", () => {
    const raw = "I want the search to be fast and easy to use.";
    expect(review(raw)).toEqual(review(raw));
  });
});

describe("review_user_story: negative controls (it must not over-ask)", () => {
  const cases: [string, string][] = [
    ["word inside another word", CLEAR.replace("Welcome back", "Welcome back, steadfast customer")],
    ["a number satisfies a limit", CLEAR + "\nAccounts lock after 5 attempts."],
    ["quoted text is observable", CLEAR.replace('Then I see "Welcome back"', 'Then the page works and shows "Welcome back"')],
  ];
  it.each(cases)("%s", (_label, raw) => {
    expect(review(raw).questions).toEqual([]);
  });

  it("each kind can be produced (none of the rules is dead)", () => {
    const produced = new Set<QuestionKind>([
      ...kinds("I want the search to be fast."),
      ...kinds("As a user, I want x.\nScenario: s\nWhen I go\nThen it works\nIt expires eventually."),
      ...kinds('As a "Gold Member", I want perks.\n- I see my perks', "nothing relevant"),
    ]);
    for (const k of ["criteria", "role", "vague-term", "outcome", "precondition", "limit", "failure-path", "undefined-term"] as QuestionKind[]) {
      expect(produced.has(k), k).toBe(true);
    }
  });
});
