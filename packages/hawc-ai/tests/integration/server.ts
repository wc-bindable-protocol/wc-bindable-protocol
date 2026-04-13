/**
 * E2E test server for hawc-ai remote mode.
 *
 * - Serves static files (dist + test HTML) via HTTP
 * - Provides /api/ai endpoint that returns mock OpenAI-compatible responses
 * - Runs a WebSocket server with AiCore connected through RemoteShellProxy
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type { ServerTransport, ServerMessage, ClientMessage } from "@wc-bindable/remote";
import { AiCore } from "../../src/core/AiCore.js";

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
    onClose(handler: () => void) {
      ws.on("close", handler);
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
  ".json": "application/json",
};

// ---------------------------------------------------------------------------
// Mock AI API responses
// ---------------------------------------------------------------------------

function buildNonStreamResponse(prompt: string): string {
  return JSON.stringify({
    choices: [{ message: { content: `Echo: ${prompt}` } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function buildStreamResponse(prompt: string): string {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Echo" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: ": " } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: prompt } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  return lines.join("");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(port: number): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  return new Promise((resolve) => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../../");
    const integrationDir = import.meta.dirname;

    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";

      // Route: /api/ai/* — mock OpenAI-compatible API
      if (url.startsWith("/api/ai/error")) {
        // handled below
      } else if (url.startsWith("/api/ai")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const prompt = parsed.messages?.at(-1)?.content ?? "";
            const wantStream = parsed.stream !== false;

            if (wantStream) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });
              res.end(buildStreamResponse(prompt));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(buildNonStreamResponse(prompt));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request" }));
          }
        });
        return;
      }

      // Route: /api/ai/error* — always returns 500
      if (url.startsWith("/api/ai/error")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        });
        return;
      }

      // Route: /client.html
      if (url === "/" || url === "/client.html") {
        const file = path.join(integrationDir, "client.html");
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // Route: /packages/... (serve built dist files)
      if (url.startsWith("/packages/")) {
        const file = path.join(repoRoot, url);
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
      const core = new AiCore();
      core.provider = "openai";
      const transport = createWsServerTransport(ws);
      new RemoteShellProxy(core, transport);
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
