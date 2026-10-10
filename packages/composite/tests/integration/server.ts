/**
 * Static file server for the composite integration suite.
 *
 * The suite exists because `happy-dom` — the default vitest environment for
 * this repository — does not implement custom element **upgrade**: an
 * instance created before `customElements.define()` keeps
 * `constructor === HTMLElement`, and an element already in the document has
 * its node replaced instead of upgraded in place (happy-dom 20.8.3). A
 * composite element created before its tag is defined is exactly that case,
 * so the composite's handling of inputs written to it beforehand can only be
 * verified in a real browser. Same server as the core suite.
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
export function startServer(port: number, requiredDist: string[] = ["core/dist/index.js", "composite/dist/index.js"]): Promise<IntegrationServer> {
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
