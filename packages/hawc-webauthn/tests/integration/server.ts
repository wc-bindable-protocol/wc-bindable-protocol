/**
 * E2E test server for hawc-webauthn.
 *
 * Mounts on a single HTTP listener:
 *   1. POST /api/webauthn/challenge — backed by createWebAuthnHandlers
 *   2. POST /api/webauthn/verify    — backed by createWebAuthnHandlers
 *   3. GET  /client.html            — Playwright entry page
 *   4. GET  /packages/...           — built workspace files (so the
 *      browser-side importmap resolves @wc-bindable/hawc-webauthn from
 *      the local dist/, not from npm)
 *
 * The verifier is a stub that trusts whatever Chrome's virtual
 * authenticator produced — same compromise as hawc-s3's "no SigV4
 * verification" mock S3 endpoint. Real cryptographic verification
 * lives in `@simplewebauthn/server` and is exercised by its own test
 * suite; here we exercise the orchestration glue (Shell → fetch →
 * handlers → Core → store + verifier callback) end-to-end across the
 * real network and real browser DOM.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WebAuthnCore,
  InMemoryChallengeStore,
  InMemoryCredentialStore,
  createWebAuthnHandlers,
  type IWebAuthnVerifier,
  type VerifiedRegistration,
  type VerifiedAuthentication,
} from "../../dist/server/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Stub verifier — trusts the structure, increments the sign counter
// ---------------------------------------------------------------------------

class StubVerifier implements IWebAuthnVerifier {
  private counters = new Map<string, number>();

  async verifyRegistration(p: any): Promise<VerifiedRegistration> {
    const credentialId = p.response.id;
    this.counters.set(credentialId, 0);
    return { credentialId, publicKey: `pk-${credentialId}`, counter: 0 };
  }

  async verifyAuthentication(p: any): Promise<VerifiedAuthentication> {
    const id = p.credential.credentialId;
    const next = (this.counters.get(id) ?? p.credential.counter) + 1;
    this.counters.set(id, next);
    return { credentialId: id, newCounter: next };
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface TestServer {
  port: number;
  close(): Promise<void>;
  /** Reset between tests so per-test challenge / credential state is fresh. */
  reset(): void;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json",
};

/**
 * Resolve a request path under the workspace root, refusing anything that
 * escapes the repo. Mirrors hawc-s3's `staticPath` guard — without it a
 * traversal in the test harness would let a misbehaving page read host
 * files outside the repo.
 */
function safeStaticPath(requestPath: string): string | null {
  const normalized = path.normalize(requestPath);
  if (normalized.includes("..")) return null;
  const abs = path.join(REPO_ROOT, normalized.replace(/^\/+/, ""));
  if (!abs.startsWith(REPO_ROOT)) return null;
  return abs;
}

export async function startServer(port = 0): Promise<TestServer> {
  const challengeStore = new InMemoryChallengeStore();
  const credentialStore = new InMemoryCredentialStore();
  const verifier = new StubVerifier();
  let core = new WebAuthnCore({
    rpId: "localhost",
    rpName: "Test RP",
    // Test pages are served on http://localhost:<port>; the origin must
    // match what the browser sends in clientDataJSON.origin. We compute
    // it after `server.listen`.
    origin: "http://localhost",
    challengeStore, credentialStore, verifier,
  });
  let handlers = createWebAuthnHandlers(core, {
    // Session id from a header the test page attaches. Real apps would
    // derive this from a cookie.
    resolveSessionId: (req) => req.headers.get("x-session-id"),
    resolveUser: (id) => ({ id, name: `${id}@test`, displayName: id }),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      // Static client.html and built dist files.
      if (req.method === "GET") {
        if (url.pathname === "/client.html") {
          const body = fs.readFileSync(path.join(__dirname, "client.html"));
          res.writeHead(200, { "content-type": STATIC_TYPES[".html"] });
          res.end(body);
          return;
        }
        if (url.pathname.startsWith("/packages/")) {
          const abs = safeStaticPath(url.pathname);
          if (!abs || !fs.existsSync(abs)) {
            res.writeHead(404); res.end(); return;
          }
          const ext = path.extname(abs);
          res.writeHead(200, { "content-type": STATIC_TYPES[ext] ?? "application/octet-stream" });
          fs.createReadStream(abs).pipe(res);
          return;
        }
      }

      // Bridge node:http → Fetch Request for the handlers.
      if (req.method === "POST" && (url.pathname === "/api/webauthn/challenge" || url.pathname === "/api/webauthn/verify")) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const bodyBytes = Buffer.concat(chunks);
        const fetchReq = new Request(`http://localhost${url.pathname}`, {
          method: "POST",
          headers: { ...(req.headers as any) },
          body: bodyBytes.length > 0 ? bodyBytes : undefined,
        });
        const response = url.pathname.endsWith("/challenge")
          ? await handlers.challenge(fetchReq)
          : await handlers.verify(fetchReq);
        const respBody = await response.text();
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(respBody);
        return;
      }

      res.writeHead(404); res.end();
    } catch (e: any) {
      res.writeHead(500); res.end(e?.message ?? "internal");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  // Now that we know the actual port, rebuild Core with a matching origin
  // so verify() sees the correct clientDataJSON.origin. (Stub verifier
  // doesn't actually check origin, but real verifiers do — keep the wire
  // honest so a future swap to SimpleWebAuthnVerifier works without
  // touching the harness.)
  core = new WebAuthnCore({
    rpId: "localhost",
    rpName: "Test RP",
    origin: `http://localhost:${actualPort}`,
    challengeStore, credentialStore, verifier,
  });
  handlers = createWebAuthnHandlers(core, {
    resolveSessionId: (req) => req.headers.get("x-session-id"),
    resolveUser: (id) => ({ id, name: `${id}@test`, displayName: id }),
  });

  return {
    port: actualPort,
    async close() { await new Promise<void>((r) => server.close(() => r())); },
    reset() {
      // Each test starts from a clean store. Re-creating the core keeps
      // its in-memory state separate from any prior test run.
      const cs = new InMemoryChallengeStore();
      const cr = new InMemoryCredentialStore();
      const v = new StubVerifier();
      core = new WebAuthnCore({
        rpId: "localhost",
        rpName: "Test RP",
        origin: `http://localhost:${actualPort}`,
        challengeStore: cs, credentialStore: cr, verifier: v,
      });
      handlers = createWebAuthnHandlers(core, {
        resolveSessionId: (req) => req.headers.get("x-session-id"),
        resolveUser: (id) => ({ id, name: `${id}@test`, displayName: id }),
      });
    },
  };
}
