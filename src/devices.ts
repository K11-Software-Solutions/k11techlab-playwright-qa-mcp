/**
 * Mobile web: Playwright device profiles (screen size, pixel density, touch, mobile
 * user agent and layout). Pages are emulated in Chromium; that's the right check for
 * responsive layouts and locators, though not for Safari-specific rendering.
 *
 * "desktop" (or no device) keeps the default desktop context, so existing baselines and
 * behaviour don't change.
 */
import { devices } from "playwright";
import type { BrowserContextOptions } from "playwright";

export const DESKTOP = "desktop";

/** Playwright's project-template names and what they emulate. */
const TEMPLATE_PROJECTS: Record<string, string> = {
  "mobile chrome": "Pixel 5",
  "mobile safari": "iPhone 12",
  "chromium": DESKTOP,
  "firefox": DESKTOP,
  "webkit": DESKTOP,
  "desktop chrome": DESKTOP,
  "desktop firefox": DESKTOP,
  "desktop safari": DESKTOP,
  "desktop edge": DESKTOP,
  "microsoft edge": DESKTOP,
  "google chrome": DESKTOP,
};

/** Canonical device name, or throws with close matches. */
export function resolveDevice(name?: string | null): string {
  if (!name || name.trim().toLowerCase() === DESKTOP) return DESKTOP;
  const wanted = name.trim().toLowerCase();
  const exact = Object.keys(devices).find((d) => d.toLowerCase() === wanted);
  if (exact) return exact.startsWith("Desktop ") ? DESKTOP : exact;
  const close = Object.keys(devices).filter((d) => d.toLowerCase().includes(wanted.split(" ")[0])).slice(0, 8);
  throw new Error(`Unknown device '${name}'. Use "desktop" or a Playwright device name${close.length ? `, e.g. ${close.map((c) => `"${c}"`).join(", ")}` : ""} (list_devices shows them all).`);
}

/** Browser-context options for a device (empty for desktop). Chromium can't emulate Firefox's isMobile. */
export function contextOptions(device: string): BrowserContextOptions {
  if (device === DESKTOP) return {};
  const d = devices[device];
  if (!d) throw new Error(`Unknown device '${device}'`);
  const { defaultBrowserType: _b, ...opts } = d;
  return opts;
}

/** Which device a Playwright project emulates: explicit mapping, a device-named project, or the template names. */
export function deviceForProject(project: string | undefined, mapping: Record<string, string> = {}): { device: string; how: string } {
  if (!project) return { device: DESKTOP, how: "no project" };
  if (mapping[project]) return { device: resolveDevice(mapping[project]), how: "heal.config.json projects mapping" };
  try {
    const d = resolveDevice(project);
    if (d !== DESKTOP || /^desktop/i.test(project)) return { device: d, how: "project named after the device" };
  } catch {
    /* not a device name */
  }
  const t = TEMPLATE_PROJECTS[project.trim().toLowerCase()];
  if (t) return { device: t, how: "Playwright template project name" };
  return { device: DESKTOP, how: "unknown project: assumed desktop (map it in heal.config.json \"projects\")" };
}

export function listDevices(): { phones: string[]; tablets: string[]; desktop: string[] } {
  const names = Object.keys(devices).filter((n) => !/landscape/i.test(n));
  const isTablet = (n: string) => /ipad|tab|nexus (7|10)|kindle|galaxy tab/i.test(n);
  return {
    phones: names.filter((n) => devices[n].isMobile && !isTablet(n)),
    tablets: names.filter((n) => devices[n].isMobile && isTablet(n)),
    desktop: [DESKTOP],
  };
}

export function deviceSummary(device: string): Record<string, unknown> {
  if (device === DESKTOP) return { device };
  const d = devices[device];
  return { device, viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch };
}
