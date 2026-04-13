/**
 * Integration test server.
 *
 * Serves static files (dist + test HTML) via HTTP and runs a WebSocket
 * server with a TestCore connected through RemoteShellProxy.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import { RemoteShellProxy } from "../../src/RemoteShellProxy.js";
import type { ServerTransport, ServerMessage, ClientMessage } from "../../src/types.js";

// ---------------------------------------------------------------------------
// TestCore — a simple headless Core for testing
// ---------------------------------------------------------------------------

class TestCore extends EventTarget {
  static wcBindable: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "test:value-changed" },
      { name: "loading", event: "test:loading-changed" },
      { name: "error", event: "test:error-changed" },
    ],
    inputs: [
      { name: "url" },
    ],
    commands: [
      { name: "doFetch", async: true },
      { name: "abort" },
    ],
  };

  private _value: unknown = null;
  private _loading = false;
  private _error: unknown = null;
  private _url = "";
  private _target: EventTarget;

  constructor(target?: EventTarget) {
    super();
    this._target = target ?? this;
  }

  get value() { return this._value; }
  get loading() { return this._loading; }
  get error() { return this._error; }
  get url() { return this._url; }
  set url(v: string) { this._url = v; }

  async doFetch(): Promise<unknown> {
    this._loading = true;
    this._target.dispatchEvent(new CustomEvent("test:loading-changed", { detail: true }));

    // Simulate async work.
    await new Promise((r) => setTimeout(r, 50));

    const result = { data: "fetched:" + this._url };
    this._value = result;
    this._loading = false;
    this._target.dispatchEvent(new CustomEvent("test:value-changed", { detail: result }));
    this._target.dispatchEvent(new CustomEvent("test:loading-changed", { detail: false }));
    return result;
  }

  abort(): void {
    this._loading = false;
    this._target.dispatchEvent(new CustomEvent("test:loading-changed", { detail: false }));
  }
}

// ---------------------------------------------------------------------------
// ws → ServerTransport adapter
// ---------------------------------------------------------------------------

function createWsServerTransport(ws: import("ws").WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) {
      ws.send(JSON.stringify(message));
    },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => {
        handler(JSON.parse(String(data)));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/javascript",
  ".json": "application/json",
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(port: number): Promise<{ close: () => Promise<void>; port: number }> {
  return new Promise((resolve) => {
    const packagesDir = path.resolve(import.meta.dirname, "../../../");
    const integrationDir = import.meta.dirname;

    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";

      // Route: /client.html
      if (url === "/" || url === "/client.html") {
        const file = path.join(integrationDir, "client.html");
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // Route: /packages/... (serve built dist files)
      if (url.startsWith("/packages/")) {
        const file = path.join(packagesDir, url.replace("/packages/", ""));
        if (fs.existsSync(file)) {
          const ext = path.extname(file);
          res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws) => {
      const core = new TestCore();
      const transport = createWsServerTransport(ws);
      const shell = new RemoteShellProxy(core, transport);
      ws.on("close", () => shell.dispose());
    });

    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((r) => {
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
}
