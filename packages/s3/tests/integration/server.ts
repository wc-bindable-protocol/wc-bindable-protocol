/**
 * E2E test server for s3-uploader.
 *
 * Serves three things over a single HTTP listener:
 *   1. A mock S3 endpoint at `/<bucket>/<key>` that handles single PUT/GET/DELETE
 *      and the multipart Initiate / Upload Part / Complete / Abort flows.
 *      No SigV4 verification — the presigned URL is treated as opaque.
 *   2. The test client HTML at `/client.html`.
 *   3. Built workspace files at `/packages/...` (so the importmap resolves).
 *
 * A WebSocketServer wraps an `S3Core` + `AwsS3Provider` per connection. The
 * provider is configured with `endpoint` pointing at this same server, so
 * presigned URLs route back here instead of AWS.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { RemoteShellProxy } from "../../../remote/dist/index.js";
import type { ServerTransport, ServerMessage, ClientMessage } from "../../../remote/dist/types.js";
import { S3Core } from "../../src/core/S3Core.js";
import { AwsS3Provider } from "../../src/providers/AwsS3Provider.js";
import { resolveSafeStaticPath, isAllowedPackageAsset } from "./staticPath.js";

// ---------------------------------------------------------------------------
// In-memory blob store + multipart bookkeeping
// ---------------------------------------------------------------------------

interface StoredObject {
  body: Buffer;
  contentType?: string;
  etag: string; // md5 hex
}

interface MultipartState {
  key: string;
  contentType?: string;
  // partNumber -> { body, etag }
  parts: Map<number, { body: Buffer; etag: string }>;
  aborted: boolean;
}

interface ServerState {
  objects: Map<string, StoredObject>;       // "<bucket>/<key>" -> object
  multiparts: Map<string, MultipartState>;  // uploadId -> state
  postProcessLog: Array<Record<string, any>>;
  /** Test-only: total PUT attempts seen (single + per-part). */
  putCount: number;
  /**
   * Test-only: a queue of failures to inject on subsequent PUT requests.
   * Each entry is consumed once. Optional `match(path, query)` lets a test
   * fail a specific part rather than the next PUT in arrival order.
   */
  putFailures: Array<{ status: number; match?: (path: string, q: URLSearchParams) => boolean }>;
  /**
   * Test-only: the most recently accepted WebSocket. The transport-failure
   * spec uses this to force-close the connection mid-upload.
   */
  activeWs: import("ws").WebSocket | null;
  /**
   * Test-only: when set, the part-PUT handler closes the active WS the first
   * time it sees a part-PUT request (after responding to that part). Lets a
   * spec exercise "WS dropped after some bytes have already landed in S3".
   */
  closeWsOnFirstPart: boolean;
  /** Internal: tracks whether the closeWsOnFirstPart trigger has fired. */
  _wsClosedByTrigger: boolean;
  /**
   * Test-only: every `reportProgress` RPC the server sees is recorded here
   * with its raw argument values (not rAF-coalesced). This is the only place
   * we can observe whether progress actually reaches Core — the client-side
   * `s3-uploader:progress-changed` events are coalesced and frequently lose the
   * mid-upload byte counts on fast local-loopback uploads.
   */
  reportProgressCalls: Array<{ loaded: unknown; total: unknown }>;
}

function createState(): ServerState {
  return {
    objects: new Map(),
    multiparts: new Map(),
    postProcessLog: [],
    putCount: 0,
    putFailures: [],
    activeWs: null,
    closeWsOnFirstPart: false,
    _wsClosedByTrigger: false,
    reportProgressCalls: [],
  };
}

function md5Hex(buf: Buffer): string {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function objectKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

/** Pop the first matching queued failure, if any, and return its status. */
function consumeFailure(state: ServerState, path: string, q: URLSearchParams): { status: number } | null {
  for (let i = 0; i < state.putFailures.length; i++) {
    const f = state.putFailures[i];
    let matched = false;
    if (!f.match) {
      matched = true;
    } else {
      try {
        matched = !!f.match(path, q);
      } catch {
        // A broken match predicate must not take down the whole PUT
        // handler — previously an exception here bubbled up through the
        // `async` IIFE to the outermost `.catch(() => send(res, 500, ...))`
        // and fail-injected unrelated requests. Skip this entry and try
        // the next one instead.
        matched = false;
      }
    }
    if (matched) {
      state.putFailures.splice(i, 1);
      return { status: f.status };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ws → ServerTransport adapter (matches ai-agent pattern)
// ---------------------------------------------------------------------------

function createWsServerTransport(ws: import("ws").WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) { ws.send(JSON.stringify(message)); },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => handler(JSON.parse(String(data))));
    },
    onClose(handler: () => void) { ws.on("close", handler); },
  };
}

// ---------------------------------------------------------------------------
// Mock S3 HTTP routing
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer = ""): void {
  // Always advertise the headers the browser needs to read on PUT responses.
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag",
    ...headers,
  });
  res.end(body);
}

function tryHandleS3(state: ServerState, req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL): boolean {
  // Path-style URL: /<bucket>/<key...>. The first segment is the bucket.
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  // Heuristic: real S3 bucket names contain '-', '.', or lowercase chars; the
  // demo only uses one. Pre-existing routes (/api, /packages, /client.html)
  // are checked by the caller before us, so any unknown path with ≥2 segments
  // is treated as <bucket>/<key>.
  const bucket = segments[0];
  if (bucket === "packages" || bucket === "api") return false;
  const key = segments.slice(1).join("/");
  const fullKey = objectKey(bucket, key);
  const q = parsedUrl.searchParams;
  const method = req.method ?? "GET";

  // Multipart: initiate
  if (method === "POST" && q.has("uploads")) {
    const contentType = req.headers["content-type"];
    const uploadId = "u-" + crypto.randomBytes(8).toString("hex");
    state.multiparts.set(uploadId, {
      key: fullKey,
      contentType: typeof contentType === "string" ? contentType : undefined,
      parts: new Map(),
      aborted: false,
    });
    const xml = `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
    send(res, 200, { "Content-Type": "application/xml" }, xml);
    return true;
  }

  // Multipart: complete
  if (method === "POST" && q.has("uploadId") && !q.has("partNumber")) {
    const uploadId = q.get("uploadId")!;
    const mp = state.multiparts.get(uploadId);
    (async () => {
      const body = (await readBody(req)).toString("utf8");
      if (!mp || mp.aborted) {
        send(res, 404, { "Content-Type": "application/xml" },
          `<Error><Code>NoSuchUpload</Code><Message>upload not found</Message></Error>`);
        return;
      }
      // Parse the part list from the XML body. Tolerant regex; the test client
      // always sends well-formed Complete bodies.
      const partRefs = [...body.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>"?([^"<]+)"?<\/ETag><\/Part>/g)]
        .map(m => ({ partNumber: Number(m[1]), etag: m[2] }))
        .sort((a, b) => a.partNumber - b.partNumber);
      const merged: Buffer[] = [];
      for (const ref of partRefs) {
        const stored = mp.parts.get(ref.partNumber);
        if (!stored) {
          send(res, 400, { "Content-Type": "application/xml" },
            `<Error><Code>InvalidPart</Code><Message>missing part ${ref.partNumber}</Message></Error>`);
          return;
        }
        merged.push(stored.body);
      }
      const buf = Buffer.concat(merged);
      const etag = md5Hex(buf) + "-" + partRefs.length;
      state.objects.set(fullKey, { body: buf, contentType: mp.contentType, etag });
      state.multiparts.delete(uploadId);
      const xml = `<?xml version="1.0"?><CompleteMultipartUploadResult><Location>http://localhost/${bucket}/${key}</Location><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`;
      send(res, 200, { "Content-Type": "application/xml" }, xml);
    })().catch(() => send(res, 500, {}, "internal"));
    return true;
  }

  // Multipart: abort
  if (method === "DELETE" && q.has("uploadId")) {
    const uploadId = q.get("uploadId")!;
    const mp = state.multiparts.get(uploadId);
    if (mp) mp.aborted = true;
    state.multiparts.delete(uploadId);
    send(res, 204, {});
    return true;
  }

  // Multipart: upload part
  if (method === "PUT" && q.has("uploadId") && q.has("partNumber")) {
    const uploadId = q.get("uploadId")!;
    const partNumber = Number(q.get("partNumber"));
    const mp = state.multiparts.get(uploadId);
    (async () => {
      const body = await readBody(req);
      state.putCount++;
      const failure = consumeFailure(state, parsedUrl.pathname, q);
      if (failure) {
        send(res, failure.status, {}, "injected failure");
        return;
      }
      if (!mp || mp.aborted) {
        send(res, 404, {}, "no such upload");
        return;
      }
      const etag = md5Hex(body);
      mp.parts.set(partNumber, { body, etag });
      // Return a quoted ETag header — matches real S3.
      send(res, 200, { "ETag": `"${etag}"` });
      // Test hook: simulate a transport failure mid-upload by closing the WS
      // after the first part PUT successfully lands. The remaining part PUTs
      // (if any) keep going to S3, but the control channel for completeMultipart
      // is now dead — exactly the pathology the spec is meant to verify.
      if (state.closeWsOnFirstPart && !state._wsClosedByTrigger && state.activeWs) {
        state._wsClosedByTrigger = true;
        state.activeWs.close();
      }
    })().catch(() => send(res, 500, {}, "internal"));
    return true;
  }

  // Single PUT
  if (method === "PUT") {
    (async () => {
      const body = await readBody(req);
      state.putCount++;
      const failure = consumeFailure(state, parsedUrl.pathname, q);
      if (failure) {
        send(res, failure.status, {}, "injected failure");
        return;
      }
      const contentType = typeof req.headers["content-type"] === "string"
        ? req.headers["content-type"] as string : undefined;
      const etag = md5Hex(body);
      state.objects.set(fullKey, { body, contentType, etag });
      send(res, 200, { "ETag": `"${etag}"` });
    })().catch(() => send(res, 500, {}, "internal"));
    return true;
  }

  // GET
  if (method === "GET") {
    const obj = state.objects.get(fullKey);
    if (!obj) { send(res, 404, {}, "not found"); return true; }
    send(res, 200, {
      "Content-Type": obj.contentType ?? "application/octet-stream",
      "ETag": `"${obj.etag}"`,
    }, obj.body);
    return true;
  }

  // DELETE
  if (method === "DELETE") {
    state.objects.delete(fullKey);
    send(res, 204, {});
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
};

export interface RunningServer {
  port: number;
  state: ServerState;
  close: () => Promise<void>;
}

export function startServer(port: number): Promise<RunningServer> {
  return new Promise((resolve) => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../../");
    const integrationDir = import.meta.dirname;
    const packagesRoot = path.join(repoRoot, "packages");
    const state = createState();

    const httpServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // CORS preflight for any S3-style request, so the browser can PUT to /bucket/key.
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }

      // /api/uploads — server-side post-process log snapshot for debugging.
      if (url.pathname === "/api/uploads") {
        send(res, 200, { "Content-Type": "application/json" }, JSON.stringify(state.postProcessLog));
        return;
      }

      // Client HTML
      if (url.pathname === "/" || url.pathname === "/client.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(path.join(integrationDir, "client.html")).pipe(res);
        return;
      }

      // Built workspace files — `dist/` only. Everything else (src/, tests/,
      // package.json, etc.) is 404 even when the path is safely under the
      // packages root. See `isAllowedPackageAsset` for rationale.
      if (url.pathname.startsWith("/packages/")) {
        const file = resolveSafeStaticPath(packagesRoot, url.pathname.slice("/packages".length));
        if (
          file &&
          isAllowedPackageAsset(packagesRoot, file) &&
          fs.existsSync(file) &&
          fs.statSync(file).isFile()
        ) {
          const ext = path.extname(file);
          res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
          fs.createReadStream(file).pipe(res);
          return;
        }
        res.writeHead(404); res.end("Not found"); return;
      }

      // Mock S3
      if (tryHandleS3(state, req, res, url)) return;

      res.writeHead(404); res.end("Not found");
    });

    const wss = new WebSocketServer({ server: httpServer });

    // Fixed fake credentials — real S3 verifies these but our mock does not.
    const provider = new AwsS3Provider({
      region: "us-east-1",
      credentials: { accessKeyId: "TEST", secretAccessKey: "TEST" },
      endpoint: undefined, // patched per-connection below once we know the listening port
      forcePathStyle: true,
    });
    let resolvedEndpoint = "";

    wss.on("connection", (ws) => {
      // Track the active socket so tests can force-close it to exercise the
      // transport-failure cleanup path. Real consumers do not need this.
      state.activeWs = ws;

      // Construct a per-connection provider so its endpoint matches the actual
      // listening port (which may have been chosen by the OS via port 0).
      const connProvider = new AwsS3Provider({
        region: "us-east-1",
        credentials: { accessKeyId: "TEST", secretAccessKey: "TEST" },
        endpoint: resolvedEndpoint,
        forcePathStyle: true,
      });
      const core = new S3Core(connProvider);
      core.bucket = "test-bucket";
      core.registerPostProcess((ctx) => {
        state.postProcessLog.push({ ...ctx, completedAt: new Date().toISOString() });
      });
      // Instrument reportProgress so tests can verify the RPC's argument
      // shape at the Core boundary — avoids the client-side rAF coalescing
      // that hides mid-upload byte counts on fast local uploads. MUST be
      // patched before RemoteShellProxy attaches: the proxy reads the method
      // from the Core at connect time. We keep the original's type-checks
      // by delegating after recording, so observable Core behavior is
      // unchanged for other tests.
      const origReport = core.reportProgress.bind(core);
      core.reportProgress = (loaded: unknown, total: unknown) => {
        state.reportProgressCalls.push({ loaded, total });
        return origReport(loaded as number, total as number);
      };
      const transport = createWsServerTransport(ws);
      new RemoteShellProxy(core, transport);

      // Connection cleanup: when the WS drops (client disconnect, network
      // failure, deliberate close), abort whatever upload was in flight so
      // S3 does not retain orphan multipart parts. Without this, the Core's
      // `_multipart` slot stays set and the uploadId becomes unreachable.
      ws.on("close", () => {
        if (state.activeWs === ws) state.activeWs = null;
        core.abort();
      });
    });

    httpServer.listen(port, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolvedEndpoint = `http://localhost:${actualPort}`;
      // Silence the unused-variable warning on `provider` — kept around in case
      // a future test wants to share a single instance across connections.
      void provider;
      resolve({
        port: actualPort,
        state,
        close: () => new Promise<void>((r) => { wss.close(); httpServer.close(() => r()); }),
      });
    });
  });
}
