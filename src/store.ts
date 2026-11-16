/** Baseline fingerprints, stored in the project at .qa-mcp/baselines.json. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DESKTOP } from "./devices.js";
import type { Reference } from "./heal.js";

interface Entry {
  fingerprint: Reference;
  capturedAt: string;
}
type Baselines = Record<string, Record<string, Entry>>;

/** Baselines are kept per page and per device: a mobile layout's elements differ from desktop's. */
export function pageKey(url: string, device: string = DESKTOP): string {
  let key: string;
  try {
    const u = new URL(url);
    key = u.protocol === "file:" ? `file://${path.basename(u.pathname)}` : `${u.origin}${u.pathname}`;
  } catch {
    key = url;
  }
  return device === DESKTOP ? key : `${key} @ ${device}`;
}

export class BaselineStore {
  constructor(private readonly root: string) {}

  get file(): string {
    return path.join(this.root, ".qa-mcp", "baselines.json");
  }

  async load(): Promise<Baselines> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Baselines;
    } catch {
      return {};
    }
  }

  async get(url: string, locator: string, device: string = DESKTOP): Promise<Reference | undefined> {
    return (await this.load())[pageKey(url, device)]?.[locator]?.fingerprint;
  }

  async put(url: string, entries: Record<string, Reference>, device: string = DESKTOP): Promise<void> {
    const all = await this.load();
    const key = pageKey(url, device);
    all[key] ??= {};
    const now = new Date().toISOString();
    for (const [loc, fp] of Object.entries(entries)) all[key][loc] = { fingerprint: fp, capturedAt: now };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(all, null, 2) + "\n", "utf8");
  }
}
