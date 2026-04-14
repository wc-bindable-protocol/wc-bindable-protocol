/**
 * Demo server for @wc-bindable/hawc-s3 in remote mode.
 *
 * Starts:
 *   - HTTP server (serves index.html and strictly the `dist/` subtree of
 *     workspace packages — source, package.json, tests, etc. are NOT served)
 *   - WebSocket server bridging the browser <hawc-s3> Shell to a server-side S3Core
 *
 * Required env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 *   S3_BUCKET     — bucket the demo will sign URLs for
 *
 * Optional env:
 *   PORT          — defaults to 8080
 *   S3_ENDPOINT   — for S3-compatible stores (R2, MinIO)
 *   S3_FORCE_PATH_STYLE=1
 *   S3_PREFIX     — default key prefix (e.g. "demo/")
 *
 * Run (from repo root):
 *   npm run build
 *   node examples/s3-remote/server.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
// Use the /server subpath — the default barrel re-exports the browser custom
// elements, which extend HTMLElement and crash at evaluation time in Node.
import { S3Core, AwsS3Provider } from "@wc-bindable/hawc-s3/server";
import { RemoteShellProxy } from "@wc-bindable/remote";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const packagesRoot = path.join(repoRoot, "packages");

/**
 * Resolve a request path safely against an allowed root.
 * Returns the absolute path on success, or null if the request would escape
 * the allowed root via `..`, percent-encoded `..`, null bytes, or absolute
 * components. The naive `path.join(root, urlPath)` is *not* safe — it
 * normalizes traversal sequences, so a request like `/packages/../package.json`
 * would resolve to a file outside the allowed area.
 */
function resolveSafeStaticPath(allowedRoot, urlPath) {
  const cleaned = urlPath.split("?")[0].split("#")[0];
  let decoded;
  try { decoded = decodeURIComponent(cleaned); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const subPath = decoded.replace(/^\/+/, "");
  const absolute = path.resolve(allowedRoot, subPath);
  // Containment check: if `path.relative` either climbs out (`..`) or is
  // absolute (different drive on Windows), the candidate is outside the root.
  const rel = path.relative(allowedRoot, absolute);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return absolute;
}

/**
 * Second-layer allowlist for `/packages/...` requests. Path traversal is
 * blocked by `resolveSafeStaticPath` above; THIS restricts what is served
 * even when the request stays safely inside `packagesRoot`.
 *
 * Without this, the demo reads as "serve workspace packages" but actually
 * leaks every source file, TypeScript config, package.json, test fixture,
 * and node_modules stash under `packages/`. Copy-pasted into a production
 * environment, that would be a textbook source-disclosure vulnerability.
 *
 * Allowed subpaths (relative to each package):
 *   - `<pkg>/dist/**`  — compiled output referenced by the importmap
 *
 * Anything else (src/, __tests__/, tests/, package.json, tsconfig.json,
 * node_modules/, etc.) returns false → 404.
 */
function isAllowedPackageAsset(packagesRoot, absolutePath) {
  const rel = path.relative(packagesRoot, absolutePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep);
  // rel = "<pkg>/<subdir>/..." — need at least the <pkg>/<subdir> prefix.
  if (segments.length < 2) return false;
  return segments[1] === "dist";
}

const PORT = Number(process.env.PORT ?? 8080);
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX ?? "";
const ENDPOINT = process.env.S3_ENDPOINT;
const FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === "1";

if (!BUCKET) {
  console.error("[s3-remote] S3_BUCKET env var is required.");
  process.exit(1);
}
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error("[s3-remote] AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars are required.");
  process.exit(1);
}
if (!process.env.AWS_REGION) {
  console.error("[s3-remote] AWS_REGION env var is required.");
  process.exit(1);
}

// One provider instance can be safely shared across connections — it is
// stateless beyond the credential bundle it captured at construction time.
const provider = new AwsS3Provider({
  endpoint: ENDPOINT,
  forcePathStyle: FORCE_PATH_STYLE,
});

// In-memory upload log so the demo can render past uploads without a DB.
const uploadLog = [];

// Adapt the `ws` socket to the ServerTransport contract used by RemoteShellProxy.
function createWsServerTransport(ws) {
  return {
    send(message) { ws.send(JSON.stringify(message)); },
    onMessage(handler) {
      ws.on("message", (data) => handler(JSON.parse(String(data))));
    },
    onClose(handler) { ws.on("close", handler); },
  };
}

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
};

const httpServer = http.createServer((req, res) => {
  const url = req.url ?? "/";

  // Echo back a small JSON snapshot so the client can render server-side
  // post-process state without holding its own database.
  if (url === "/api/uploads") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(uploadLog));
    return;
  }

  // Serve the demo client.
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    return;
  }

  // Serve built workspace packages — `dist/` subtree only. See
  // `isAllowedPackageAsset` for why the allowlist exists in addition to the
  // traversal check.
  if (url.startsWith("/packages/")) {
    const file = resolveSafeStaticPath(packagesRoot, url.slice("/packages".length));
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
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  console.log("[s3-remote] client connected");

  const core = new S3Core(provider);
  // Inputs the browser typically supplies via attributes; pre-seeding here
  // means a client that omits them still gets a usable signing context.
  core.bucket = BUCKET;
  if (PREFIX) core.prefix = PREFIX;

  // Server-side post-process hook (the C案 server side):
  // runs once the browser confirms the upload has landed in S3.
  core.registerPostProcess(async ({ bucket, key, etag, size, contentType }) => {
    const entry = {
      bucket, key, etag, size, contentType,
      completedAt: new Date().toISOString(),
    };
    uploadLog.push(entry);
    console.log("[s3-remote] post-process:", entry);
    // A real app would: insert a DB row, kick off a thumbnailer, etc.
  });

  const transport = createWsServerTransport(ws);
  // RemoteShellProxy wires the Core's wcBindable surface to the transport;
  // garbage-collected once the WS closes (via its onClose handler).
  new RemoteShellProxy(core, transport);

  // Connection cleanup: when the WS drops while a multipart upload is in
  // flight, ask the Core to abort it. Otherwise S3 retains the orphan parts
  // (and bills for them) — the client cannot signal abortMultipart through a
  // dead control channel, so this server-side hook is the only path that
  // actually cleans up. Cheap no-op when no upload is in flight.
  ws.on("close", () => {
    core.abort();
    console.log("[s3-remote] client disconnected");
  });
});

httpServer.listen(PORT, () => {
  console.log(`[s3-remote] http://localhost:${PORT}`);
  console.log(`[s3-remote] bucket=${BUCKET} prefix=${PREFIX || "(none)"} region=${process.env.AWS_REGION}`);
  if (ENDPOINT) console.log(`[s3-remote] endpoint=${ENDPOINT} forcePathStyle=${FORCE_PATH_STYLE}`);
});
