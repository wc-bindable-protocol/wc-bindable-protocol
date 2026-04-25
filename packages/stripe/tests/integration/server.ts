import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RemoteShellProxy } from "../../../remote/dist/index.js";
import type { ClientMessage, ServerMessage, ServerTransport } from "../../../remote/dist/types.js";
import { StripeCore } from "../../src/core/StripeCore.js";
import type {
  IStripeProvider,
  IntentCreationResult,
  PaymentIntentOptions,
  SetupIntentOptions,
  StripeAmount,
  StripeEvent,
  StripeIntentView,
  StripeMode,
  StripePaymentMethod,
} from "../../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PACKAGES_ROOT = path.join(REPO_ROOT, "packages");

interface StoredIntent {
  id: string;
  mode: StripeMode;
  clientSecret: string;
  status: string;
  amount?: StripeAmount;
  paymentMethod?: StripePaymentMethod;
}

export interface ServerState {
  intents: Map<string, StoredIntent>;
  resumeFixtures: Map<string, StoredIntent>;
  createCalls: Array<{ mode: StripeMode; options: PaymentIntentOptions | SetupIntentOptions }>;
  retrieveCalls: Array<{ mode: StripeMode; id: string }>;
  cancelCalls: string[];
  connections: number;
}

export interface RunningServer {
  port: number;
  state: ServerState;
  close(): Promise<void>;
  reset(): void;
}

function createState(): ServerState {
  return {
    intents: new Map(),
    resumeFixtures: new Map(),
    createCalls: [],
    retrieveCalls: [],
    cancelCalls: [],
    connections: 0,
  };
}

function resolveSafeStaticPath(allowedRoot: string, urlPath: string): string | null {
  const cleaned = urlPath.split("?")[0].split("#")[0];
  let decoded: string;
  try { decoded = decodeURIComponent(cleaned); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const subPath = decoded.replace(/^\/+/, "");
  const absolute = path.resolve(allowedRoot, subPath);
  const rel = path.relative(allowedRoot, absolute);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return absolute;
}

function isAllowedPackageAsset(packagesRoot: string, absolutePath: string): boolean {
  const rel = path.relative(packagesRoot, absolutePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep);
  if (segments.length < 2) return false;
  return segments[1] === "dist";
}

function createWsServerTransport(ws: import("ws").WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) {
      ws.send(JSON.stringify(message));
    },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => handler(JSON.parse(String(data))));
    },
    onClose(handler: () => void) {
      ws.on("close", handler);
    },
  };
}

class FakeStripeProvider implements IStripeProvider {
  private _state: ServerState;
  private _paymentCounter = 0;
  private _setupCounter = 0;

  constructor(state: ServerState) {
    this._state = state;
  }

  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    const id = `pi_e2e_${++this._paymentCounter}`;
    const clientSecret = `${id}_secret_ok`;
    const amount = { value: opts.amount, currency: opts.currency };
    this._state.createCalls.push({ mode: "payment", options: { ...opts } });
    this._state.intents.set(id, {
      id,
      mode: "payment",
      clientSecret,
      status: "requires_payment_method",
      amount,
    });
    return { intentId: id, clientSecret, mode: "payment", amount };
  }

  async createSetupIntent(opts: SetupIntentOptions): Promise<IntentCreationResult> {
    const id = `seti_e2e_${++this._setupCounter}`;
    const clientSecret = `${id}_secret_ok`;
    this._state.createCalls.push({ mode: "setup", options: { ...opts } });
    this._state.intents.set(id, {
      id,
      mode: "setup",
      clientSecret,
      status: "requires_payment_method",
    });
    return { intentId: id, clientSecret, mode: "setup" };
  }

  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    this._state.retrieveCalls.push({ mode, id });
    const stored = this._state.resumeFixtures.get(id) ?? this._state.intents.get(id);
    if (!stored) {
      throw new Error(`unknown intent: ${id}`);
    }
    return {
      id: stored.id,
      status: stored.status,
      mode: stored.mode,
      amount: stored.amount,
      paymentMethod: stored.paymentMethod,
      clientSecret: stored.clientSecret,
    };
  }

  async cancelPaymentIntent(id: string): Promise<void> {
    this._state.cancelCalls.push(id);
    const stored = this._state.intents.get(id);
    if (stored) stored.status = "canceled";
  }

  verifyWebhook(): StripeEvent {
    throw new Error("webhook not used in integration tests");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export async function startServer(port = 0): Promise<RunningServer> {
  const state = createState();

  const httpServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/client.html")) {
        const body = fs.readFileSync(path.join(__dirname, "client.html"));
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/packages/")) {
        const file = resolveSafeStaticPath(PACKAGES_ROOT, url.pathname.slice("/packages".length));
        if (!file || !isAllowedPackageAsset(PACKAGES_ROOT, file) || !fs.existsSync(file)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ext = path.extname(file);
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (error: unknown) {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : "internal");
    }
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    state.connections++;
    const provider = new FakeStripeProvider(state);
    const core = new StripeCore(provider);
    core.registerIntentBuilder((request) => {
      if (request.mode === "setup") {
        return {
          mode: "setup",
          customer: request.hint.customerId ?? "cus_default",
        };
      }
      return {
        mode: "payment",
        amount: request.hint.amountValue ?? 1111,
        currency: request.hint.amountCurrency ?? "usd",
      };
    });
    const transport = createWsServerTransport(ws);
    new RemoteShellProxy(core, transport);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, () => resolve()));
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    port: actualPort,
    state,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
    reset() {
      state.intents.clear();
      state.resumeFixtures.clear();
      state.createCalls.length = 0;
      state.retrieveCalls.length = 0;
      state.cancelCalls.length = 0;
      state.connections = 0;
    },
  };
}