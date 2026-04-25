/**
 * End-to-end test that exercises the boundaries existing unit tests cover only
 * with mocks: a real RSA-signed JWT, a real Sec-WebSocket-Protocol handshake
 * across an actual `ws` socket pair, the real `createAuthenticatedWSS`
 * verifyClient → handleConnection pipeline, in-band token refresh through
 * `auth:refresh`, and the AuthCore `handleRedirectCallback` path.
 *
 * Only `createRemoteJWKSet` is mocked — and even then, only to swap in a
 * `createLocalJWKSet` resolver bound to a key pair we generated in-process,
 * so the real `jwtVerify` still runs the actual signature, issuer, audience,
 * and expiry validation against a real JWK set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";

// Hold the JWKS resolver in a module-level slot. The mock factory below
// returns a delegating function that calls into this slot, so the test
// can refresh the keyset (rotation, multi-key, etc.) at any point without
// having to re-mock. `jwtVerify`, `SignJWT`, and the rest of `jose` are
// the real implementations (we only override `createRemoteJWKSet`).
let activeJwksResolver: ReturnType<typeof createLocalJWKSet> | null = null;

vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => {
      // The Auth0 verifier caches the resolver per-issuer, so this is
      // typically called once per (test-file, domain). Returning a thunk
      // that defers to `activeJwksResolver` lets each `it` install its
      // own keyset while still exercising the real verifier.
      return (...args: any[]) => {
        if (!activeJwksResolver) {
          throw new Error("[e2e] activeJwksResolver not installed");
        }
        return (activeJwksResolver as any)(...args);
      };
    }),
  };
});

import { createAuthenticatedWSS } from "../src/server/createAuthenticatedWSS";
import { PROTOCOL_PREFIX } from "../src/protocolPrefix";
import { AuthCore } from "../src/core/AuthCore";
import { _clearJwksCache } from "../src/server/verifyAuth0Token";

// --- key + JWT helpers ---------------------------------------------------

interface KeyMaterial {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

async function newKeyMaterial(kid: string): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk, kid };
}

async function signToken(
  material: KeyMaterial,
  payload: Record<string, unknown>,
  opts: { issuer: string; audience: string; expiresIn?: string | number; sub?: string },
): Promise<string> {
  const sub = opts.sub ?? "auth0|user-123";
  const jwt = new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "RS256", kid: material.kid })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt()
    .setSubject(sub);
  if (opts.expiresIn !== undefined) jwt.setExpirationTime(opts.expiresIn as any);
  return jwt.sign(material.privateKey);
}

function installKeySet(materials: KeyMaterial[]): void {
  activeJwksResolver = createLocalJWKSet({ keys: materials.map(m => m.publicJwk) });
}

// --- WSS lifecycle helpers ----------------------------------------------

async function startWss(args: {
  domain: string;
  audience: string;
  onEvent?: (e: any) => void;
  onTokenRefresh?: (core: any, user: any) => void | Promise<void>;
  sessionGraceMs?: number;
}): Promise<{ wss: any; port: number; cores: any[]; close: () => Promise<void> }> {
  const cores: any[] = [];
  const wss = await createAuthenticatedWSS({
    auth0Domain: args.domain,
    auth0Audience: args.audience,
    port: 0, // OS-assigned ephemeral port
    onEvent: args.onEvent,
    onTokenRefresh: args.onTokenRefresh,
    sessionGraceMs: args.sessionGraceMs,
    createCores: (user) => {
      // Minimal Core that satisfies the wcBindable contract the
      // RemoteShellProxy introspects. Holds the user so the refresh hook
      // can mutate it and the test can assert.
      class TestCore extends EventTarget {
        static wcBindable = {
          protocol: "wc-bindable" as const,
          version: 1 as const,
          properties: [
            { name: "user", event: "test:user-changed" },
          ],
          inputs: [],
          commands: [],
        };
        public _user = user;
        get user() { return this._user; }
      }
      const core = new TestCore();
      cores.push(core);
      return core;
    },
  });
  // `WebSocketServer({ port: 0 })` resolves before `listening`; wait for it
  // so `address()` returns the assigned port.
  await new Promise<void>((resolve, reject) => {
    if (wss.address) {
      const addr = wss.address();
      if (addr && typeof addr === "object") return resolve();
    }
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    wss,
    port,
    cores,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
  };
}

/**
 * Connect a client and resolve as soon as the outcome is known:
 *   - `open` fires    → resolve with `{ opened: true, ws }` (caller closes)
 *   - `unexpected-response` (verifyClient cb(false, status)) → resolve with `{ opened:false, httpStatus }`
 *   - `close` (without a preceding open) → resolve with `{ opened:false, closeCode, closeReason }`
 *
 * Resolving on `open` (instead of waiting for `close`) is essential — the
 * happy-path test needs the socket to STAY open while it sends commands.
 */
async function clientConnect(
  port: number,
  token: string,
): Promise<{ ws: any; opened: boolean; closeCode?: number; closeReason?: string; httpStatus?: number }> {
  const { WebSocket } = await import("ws");
  return new Promise((resolve) => {
    const subprotocol = `${PROTOCOL_PREFIX}${token}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, [subprotocol]);
    let settled = false;
    const settle = (value: any): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.on("open", () => settle({ ws, opened: true }));
    ws.on("unexpected-response", (_req: any, res: any) => {
      settle({ ws, opened: false, httpStatus: res.statusCode });
    });
    ws.on("close", (code: number, reason: Buffer) => {
      settle({ ws, opened: false, closeCode: code, closeReason: reason.toString() });
    });
    ws.on("error", () => { /* close or unexpected-response will settle */ });
  });
}

// --- The E2E suite ------------------------------------------------------

describe("e2e: real JWT + JWKS + Sec-WebSocket-Protocol + refresh", () => {
  let mat: KeyMaterial;
  // Use a unique domain per test run so the verifyAuth0Token module-level
  // cache (keyed by jwksUri) does not leak resolvers across files / re-runs.
  const domain = `e2e-${Date.now()}.test.invalid`;
  const issuer = `https://${domain}/`;
  const audience = "https://api.e2e.example.com";

  beforeAll(async () => {
    mat = await newKeyMaterial("kid-primary");
    installKeySet([mat]);
  });

  afterAll(() => {
    activeJwksResolver = null;
    // Drop the module-level JWKS resolver cache so later test files
    // mocking `createRemoteJWKSet` with a fresh `activeJwksResolver`
    // do not accidentally reuse this suite's stubbed thunk.
    _clearJwksCache();
  });

  it("happy path: real RSA-signed JWT in Sec-WebSocket-Protocol opens the connection", async () => {
    // Real verifyClient → real jwtVerify → real handleConnection.
    const events: any[] = [];
    const server = await startWss({ domain, audience, onEvent: (e) => events.push(e) });
    try {
      const token = await signToken(mat, { permissions: ["read"] }, {
        issuer, audience, expiresIn: "1h",
      });
      const result = await clientConnect(server.port, token);
      expect(result.opened).toBe(true);
      // Pre-handshake verifyClient ran; auth:success / connection:open fired.
      const types = events.map(e => e.type);
      expect(types).toContain("auth:success");
      expect(types).toContain("connection:open");
      // The user from the JWT made it all the way to createCores.
      expect(server.cores.at(-1)?._user?.sub).toBe("auth0|user-123");
      result.ws.close();
    } finally {
      await server.close();
    }
  });

  it("rejects connection pre-handshake when token signature is invalid", async () => {
    // Sign the token with a DIFFERENT key that is NOT in the JWKS — real
    // RSA signature verification must reject this before the upgrade.
    const events: any[] = [];
    const server = await startWss({ domain, audience, onEvent: (e) => events.push(e) });
    try {
      const wrongMat = await newKeyMaterial("kid-stolen");
      const badToken = await signToken(wrongMat, {}, {
        issuer, audience, expiresIn: "1h",
      });
      const result = await clientConnect(server.port, badToken);
      // verifyClient → cb(false, 401) → no `open` event ever fires.
      expect(result.opened).toBe(false);
      expect(result.httpStatus).toBe(401);
      // The auth:failure event captures the verification error.
      expect(events.some(e => e.type === "auth:failure")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects connection pre-handshake when token is expired", async () => {
    const events: any[] = [];
    const server = await startWss({ domain, audience, onEvent: (e) => events.push(e) });
    try {
      const expired = await signToken(mat, {}, {
        issuer, audience,
        // Issued + expired in the past. jose computes exp from "0s" relative
        // to setIssuedAt(); set exp explicitly via Math.floor.
        expiresIn: Math.floor(Date.now() / 1000) - 60,
      });
      const result = await clientConnect(server.port, expired);
      expect(result.opened).toBe(false);
      expect(result.httpStatus).toBe(401);
      expect(events.some(e => e.type === "auth:failure")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects connection pre-handshake when Sec-WebSocket-Protocol prefix is missing", async () => {
    // The point of this test is that token transport is gated on the
    // subprotocol — a request offering a bare JWT (no `auth0-gate.bearer.`
    // prefix) cannot connect. The exact rejection path is determined by the
    // order of `ws`'s checks: `verifyClient` runs before `handleProtocols`,
    // so the missing prefix surfaces inside the token extractor (which
    // throws → cb(false, 401)) rather than as a 400 from the subprotocol
    // negotiation. Either is fine; what matters is that `open` never fires.
    const events: any[] = [];
    const server = await startWss({ domain, audience, onEvent: (e) => events.push(e) });
    try {
      const { WebSocket } = await import("ws");
      const goodToken = await signToken(mat, {}, { issuer, audience, expiresIn: "1h" });
      const result = await new Promise<{ opened: boolean; httpStatus?: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, [`bearer.${goodToken}`]);
        let settled = false;
        const settle = (v: any): void => { if (!settled) { settled = true; resolve(v); } };
        ws.on("open", () => settle({ opened: true }));
        ws.on("unexpected-response", (_req: any, res: any) => settle({ opened: false, httpStatus: res.statusCode }));
        ws.on("close", () => settle({ opened: false }));
        ws.on("error", () => { /* settled by unexpected-response or close */ });
      });
      expect(result.opened).toBe(false);
      // 4xx from either verifyClient (401) or handleProtocols (400) — both
      // prove the connection was refused before the upgrade.
      expect(result.httpStatus).toBeGreaterThanOrEqual(400);
      expect(result.httpStatus).toBeLessThan(500);
      // `auth:failure` event surfaces the underlying reason ("No
      // auth0-gate.bearer.* entry in Sec-WebSocket-Protocol.").
      const failure = events.find(e => e.type === "auth:failure");
      expect(failure).toBeDefined();
      expect(String(failure.error?.message)).toMatch(/Sec-WebSocket-Protocol/);
    } finally {
      await server.close();
    }
  });

  it("refresh boundary: in-band auth:refresh re-verifies a real JWT and fires auth:refresh", async () => {
    const events: any[] = [];
    const refreshedUsers: any[] = [];
    const server = await startWss({
      domain, audience,
      onEvent: (e) => events.push(e),
      onTokenRefresh: (_core, user) => { refreshedUsers.push(user); },
    });
    try {
      // Initial token good for 1 minute.
      const t1 = await signToken(mat, { permissions: ["read"] }, {
        issuer, audience, expiresIn: "60s", sub: "auth0|user-123",
      });
      const conn = await new Promise<{ ws: any }>((resolve) => {
        const wsImport = import("ws").then(({ WebSocket }) => {
          const sock = new WebSocket(`ws://127.0.0.1:${server.port}`, [`${PROTOCOL_PREFIX}${t1}`]);
          sock.on("open", () => resolve({ ws: sock }));
        });
        return wsImport;
      });

      // A fresh real JWT with elevated permissions (the realistic refresh
      // motivation: claims drift between issuance windows).
      const t2 = await signToken(mat, { permissions: ["read", "write"] }, {
        issuer, audience, expiresIn: "120s", sub: "auth0|user-123",
      });

      // Drive the in-band auth:refresh command across the real socket. The
      // RemoteCoreProxy wire format is `{type:"cmd", name, id, args}`; the
      // server's intercepting transport handles auth:refresh before it
      // reaches RemoteShellProxy.
      const cmdId = "refresh-1";
      const refreshAck = new Promise<any>((resolve) => {
        conn.ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === cmdId) resolve(msg);
        });
      });
      conn.ws.send(JSON.stringify({ type: "cmd", name: "auth:refresh", id: cmdId, args: [t2] }));
      const ack = await refreshAck;
      expect(ack.type).toBe("return");
      // The refresh hook saw the new claims (real JWT verification provided them).
      expect(refreshedUsers).toHaveLength(1);
      expect(refreshedUsers[0].sub).toBe("auth0|user-123");
      expect(refreshedUsers[0].permissions).toEqual(["read", "write"]);
      // The auth:refresh event observed the new user.
      const refreshEvents = events.filter(e => e.type === "auth:refresh");
      expect(refreshEvents).toHaveLength(1);
      expect(refreshEvents[0].user.permissions).toEqual(["read", "write"]);

      conn.ws.close();
    } finally {
      await server.close();
    }
  });

  it("refresh boundary: rejects refresh whose 'sub' does not match the original session", async () => {
    // The server pins the session to the initial `sub` and closes 4403 if a
    // refresh tries to swap identities — protects against a compromised
    // refresh path being used to escalate to a different account.
    const events: any[] = [];
    const server = await startWss({ domain, audience, onEvent: (e) => events.push(e) });
    try {
      const t1 = await signToken(mat, {}, { issuer, audience, expiresIn: "60s", sub: "auth0|alice" });
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, [`${PROTOCOL_PREFIX}${t1}`]);
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));

      const t2 = await signToken(mat, {}, { issuer, audience, expiresIn: "60s", sub: "auth0|mallory" });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
      });
      ws.send(JSON.stringify({ type: "cmd", name: "auth:refresh", id: "x", args: [t2] }));
      const close = await closed;
      // 4403 is the application-level close code the server uses for sub-mismatch.
      expect(close.code).toBe(4403);
      expect(events.some(e => e.type === "auth:refresh-failure")).toBe(true);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Redirect-callback boundary
// ---------------------------------------------------------------------------

describe("e2e: AuthCore redirect callback", () => {
  // The redirect callback path is intrinsically client-side and depends on
  // `globalThis.location` + `globalThis.history`. We cannot exercise a real
  // Auth0 redirect without a real IdP, so the SDK is stubbed; the rest is
  // the real AuthCore.initialize flow. Verifies (a) handleRedirectCallback
  // is invoked when the URL has `code` + `state`, (b) those query params
  // are scrubbed via history.replaceState, (c) auth state is then synced
  // from the (stubbed) Auth0 client.
  let originalHref: string;
  let replaceStateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalHref = globalThis.location.href;
    // happy-dom provides a writable `location.href`. Set search params
    // that look like an Auth0 redirect callback.
    globalThis.history.replaceState({}, "", "/cb?code=AUTHZCODE&state=STATEVAL&keep=1");
    replaceStateSpy = vi.fn(globalThis.history.replaceState.bind(globalThis.history));
    globalThis.history.replaceState = replaceStateSpy as any;
  });

  afterEach(() => {
    // Restore. happy-dom keeps the location object stable; we only
    // reset the URL via `history.replaceState`. An earlier version
    // did `globalThis.location = originalLocation`, but `location`
    // is a read-only property under happy-dom (and all real runtimes)
    // so that assignment was a silent no-op — we rely entirely on
    // `replaceState` to scrub leftover query params.
    globalThis.history.replaceState({}, "", originalHref);
  });

  it("invokes handleRedirectCallback and scrubs code+state from the URL", async () => {
    const handleRedirectCallback = vi.fn(async () => undefined);
    const isAuthenticated = vi.fn(async () => true);
    const getUser = vi.fn(async () => ({ sub: "auth0|cb-user", email: "u@e.com" }));
    const getTokenSilently = vi.fn(async () => "token-from-silent");

    vi.doMock("@auth0/auth0-spa-js", () => ({
      createAuth0Client: vi.fn(async () => ({
        handleRedirectCallback,
        isAuthenticated,
        getUser,
        getTokenSilently,
      })),
    }));

    // Re-import after doMock so the AuthCore module sees the stubbed SDK.
    const { AuthCore: FreshAuthCore } = await import("../src/core/AuthCore");
    const core = new FreshAuthCore();
    await core.initialize({
      domain: "tenant.auth0.com",
      clientId: "client-id",
      audience: "https://api.example.com",
    });

    // 1) The redirect callback was invoked because the URL had code + state.
    expect(handleRedirectCallback).toHaveBeenCalledTimes(1);

    // 2) `code` and `state` were stripped via history.replaceState. The
    // kept query parameter survives — the scrub is targeted, not blanket.
    expect(replaceStateSpy).toHaveBeenCalled();
    const lastCall = replaceStateSpy.mock.calls.at(-1);
    const newUrl = String(lastCall?.[2]);
    expect(newUrl).not.toContain("code=AUTHZCODE");
    expect(newUrl).not.toContain("state=STATEVAL");
    expect(newUrl).toContain("keep=1");

    // 3) Auth state was synced from the stubbed client AFTER the redirect
    // callback completed.
    expect(core.authenticated).toBe(true);
    expect(core.user?.sub).toBe("auth0|cb-user");
    expect(core.token).toBe("token-from-silent");

    vi.doUnmock("@auth0/auth0-spa-js");
  });
});
