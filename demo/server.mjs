/**
 * Tiny static server for the login demo. /account.html is served from the
 * current app version (v1 or v2), so tests can "deploy" a redesign at the same
 * URL and watch baselines heal it.
 *
 *   node demo/server.mjs [port] [v1|v2]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function startDemoServer({ port = 0, version = "v1" } = {}) {
  let current = version;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "login.html" : path.basename(url.pathname);
    const file = name === "account.html" ? path.join(here, "app", current, name) : path.join(here, "app", name);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}`,
    setVersion: (v) => (current = v),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startDemoServer({ port: Number(process.argv[2] ?? 4810), version: process.argv[3] ?? "v1" });
  console.log(`Demo app on ${s.url}/login.html`);
}
