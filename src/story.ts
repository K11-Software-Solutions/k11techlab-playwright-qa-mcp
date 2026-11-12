/**
 * User story parsing and Playwright spec scaffolding.
 *
 * Accepts the common formats teams actually write:
 *   As a <role>, I want <goal> so that <benefit>.
 *   Scenario: ... / Given ... When ... Then ... And ... But ...
 *   Acceptance criteria as bullets or numbered lines (each becomes a scenario).
 */
export interface Step {
  keyword: "Given" | "When" | "Then" | "And" | "But" | "Check";
  text: string;
}
export interface Scenario {
  name: string;
  steps: Step[];
}
export interface Story {
  title: string;
  role?: string;
  goal?: string;
  benefit?: string;
  scenarios: Scenario[];
}

const STEP_RE = /^(given|when|then|and|but)\b[:\s]*(.*)$/i;

export function parseStory(raw: string): Story {
  const text = raw.replace(/\r/g, "");
  const story: Story = { title: "", scenarios: [] };

  const asA = text.match(/as an?\s+(.+?),?\s+i (?:want|need|would like)(?: to)?\s+(.+?)(?:,?\s+so that\s+(.+?))?(?:\.|\n|$)/i);
  if (asA) {
    story.role = asA[1].trim();
    story.goal = asA[2].trim();
    if (asA[3]) story.benefit = asA[3].trim();
  }
  const titleLine = text.match(/^(?:title|story|feature)\s*:\s*(.+)$/im);
  story.title = (titleLine?.[1] ?? story.goal ?? text.split("\n").find((l) => l.trim()) ?? "User story").trim();
  story.title = story.title.charAt(0).toUpperCase() + story.title.slice(1);

  let current: Scenario | null = null;
  const bullets: string[] = [];
  for (const line0 of text.split("\n")) {
    const line = line0.trim();
    if (!line) continue;
    const sc = line.match(/^scenario(?: outline)?\s*:\s*(.+)$/i);
    if (sc) {
      current = { name: sc[1].trim(), steps: [] };
      story.scenarios.push(current);
      continue;
    }
    const st = line.replace(/^[-*•]\s*/, "").match(STEP_RE);
    if (st) {
      if (!current) {
        current = { name: `Scenario ${story.scenarios.length + 1}`, steps: [] };
        story.scenarios.push(current);
      }
      const kw = (st[1][0].toUpperCase() + st[1].slice(1).toLowerCase()) as Step["keyword"];
      current.steps.push({ keyword: kw, text: st[2].trim() });
      continue;
    }
    const b = line.match(/^(?:[-*•]|\d+[.)]|ac\s*\d+\s*[:.-])\s*(.+)$/i);
    if (b && !/^as an?\s/i.test(b[1])) bullets.push(b[1].trim());
  }
  if (!story.scenarios.length) {
    for (const b of bullets) story.scenarios.push({ name: b, steps: [{ keyword: "Check", text: b }] });
  }
  if (!story.scenarios.length && story.goal) {
    story.scenarios.push({ name: story.goal, steps: [{ keyword: "Check", text: story.goal }] });
  }
  return story;
}

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Playwright Test skeleton: one test per scenario, one test.step per step, TODOs to fill. */
export function scaffoldSpec(story: Story, url?: string): string {
  const lines = ["import { test, expect } from '@playwright/test';", ""];
  if (story.role || story.goal) {
    lines.push(`// Story: As ${story.role ? `a ${story.role}` : "a user"}, I want ${story.goal ?? "…"}` +
      `${story.benefit ? ` so that ${story.benefit}` : ""}.`);
  }
  lines.push(`test.describe(${lit(story.title)}, () => {`);
  if (url) {
    lines.push("  test.beforeEach(async ({ page }) => {", `    await page.goto(${lit(url)});`, "  });", "");
  }
  story.scenarios.forEach((sc, i) => {
    lines.push(`  test(${lit(sc.name)}, async ({ page }) => {`);
    for (const st of sc.steps) {
      lines.push(`    await test.step(${lit(`${st.keyword} ${st.text}`)}, async () => {`);
      lines.push(st.keyword === "Then" || st.keyword === "Check"
        ? "      // TODO: web-first assertion, e.g. await expect(page.getByRole(...)).toBeVisible();"
        : "      // TODO: action using a verified locator from explore_page");
      lines.push("    });");
    }
    lines.push("  });");
    if (i < story.scenarios.length - 1) lines.push("");
  });
  lines.push("});", "");
  return lines.join("\n");
}
