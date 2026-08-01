/**
 * Static file server for the core integration suite.
 *
 * The suite exists because `happy-dom` — the default vitest environment for
 * this repository — does not implement custom element **upgrade** at all,
 * which is exactly the platform behavior `syncOn: "define"` is built on.
 * Two divergences matter (both verified against happy-dom 20.8.3):
 *
 *   1. After `customElements.define()`, an instance created beforehand keeps
 *      `constructor === HTMLElement` forever; neither insertion nor
 *      `customElements.upgrade()` swaps its prototype.
 *   2. For an element already in the document, `define()` *replaces the
 *      node* rather than upgrading it in place, orphaning the original
 *      reference while `isConnected` still reports `true`.
 *
 * The unit tests work around (1) by simulating the prototype swap, which
 * pins our own logic but cannot prove the platform half of the contract.
 * These tests run against a real browser, so both halves are real.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
};

export interface IntegrationServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Serve `harness.html` plus the built `dist/` output of every workspace
 * package under `/packages/...`.
 *
 * The suite runs against **built output**, not `src/`, so `npm run build`
 * must have run first. Rather than let that surface as a 404 and a confusing
 * assertion failure three layers down, the required entry points are checked
 * up front.
 */
export function startServer(port: number, requiredDist: string[] = ["core/dist/index.js"]): Promise<IntegrationServer> {
  const packagesDir = path.resolve(import.meta.dirname, "../../../");
  const harnessDir = import.meta.dirname;

  for (const rel of requiredDist) {
    const file = path.join(packagesDir, rel);
    if (!fs.existsSync(file)) {
      throw new Error(
        `Integration suite needs built output: ${file} is missing.\n` +
        `Run \`npm run build\` from the repository root first.`,
      );
    }
  }

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0];

      if (url === "/" || url.endsWith(".html")) {
        const name = url === "/" ? "harness.html" : path.basename(url);
        const file = path.join(harnessDir, name);
        if (fs.existsSync(file)) {
          res.writeHead(200, { "Content-Type": "text/html" });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      if (url.startsWith("/packages/")) {
        const file = path.join(packagesDir, url.replace("/packages/", ""));
        // Keep the served tree inside packages/ even if a test asks for
        // something like /packages/../../secret.
        if (file.startsWith(packagesDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, {
            "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
          });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(port, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
  });
}
