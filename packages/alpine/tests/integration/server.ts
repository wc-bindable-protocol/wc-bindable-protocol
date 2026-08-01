/**
 * Static file server for the Alpine integration suite.
 *
 * The unit suite cannot express late definition for this adapter. happy-dom
 * does not upgrade custom elements in place: for an element already in the
 * document, `customElements.define()` **replaces the node**, orphaning the
 * original reference (`parentElement` becomes undefined) while `isConnected`
 * still reports `true`. Every other adapter's unit test survives that by
 * asserting on the reference it holds — which keeps its listeners — but
 * Alpine's callback resolves scope by walking `el`'s ancestors, and an
 * orphan has none. See `packages/alpine/tests/wcBindable.test.ts`.
 *
 * A real browser upgrades in place and preserves node identity, so the
 * scenario is expressible here and nowhere else.
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

export function startServer(port: number): Promise<IntegrationServer> {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../");
  const packagesDir = path.join(repoRoot, "packages");
  const harnessDir = import.meta.dirname;

  // The suite runs against built output, not src/. Fail here with something
  // actionable rather than as a 404 three layers down.
  const alpineEsm = path.join(repoRoot, "node_modules/alpinejs/dist/module.esm.js");
  for (const file of [
    path.join(packagesDir, "core/dist/index.js"),
    path.join(packagesDir, "alpine/dist/index.js"),
    alpineEsm,
  ]) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `Integration suite needs ${file}, which is missing.\n` +
        `Run \`npm install --legacy-peer-deps\` and \`npm run build\` from the repository root first.`,
      );
    }
  }

  const serve = (res: http.ServerResponse, file: string) => {
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0];

      if (url === "/" || url.endsWith(".html")) {
        const name = url === "/" ? "harness.html" : path.basename(url);
        const file = path.join(harnessDir, name);
        if (fs.existsSync(file)) return serve(res, file);
      }

      // Alpine itself, vendored out of node_modules so the page can import
      // it as a bare specifier through the harness import map.
      if (url === "/vendor/alpine.esm.js") return serve(res, alpineEsm);

      if (url.startsWith("/packages/")) {
        const file = path.join(packagesDir, url.replace("/packages/", ""));
        if (file.startsWith(packagesDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          return serve(res, file);
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
