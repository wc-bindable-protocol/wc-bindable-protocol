/**
 * Integration tests: real Core + real handlers + real Shell wired together
 * in a single happy-dom process.
 *
 * Distinct from unit tests in that nothing inside the wc-bindable seam is
 * mocked — `globalThis.fetch` bridges the Shell to live `createWebAuthnHandlers`
 * `(Request → Response)`, which call into a live `WebAuthnCore`. The only
 * mocks are:
 *
 *   1. `IWebAuthnVerifier` — a deterministic stub that records what it
 *      receives and returns synthetic VerifiedRegistration / VerifiedAuthentication
 *      values. Real WebAuthn signature verification is exercised in the
 *      e2e suite (Playwright + Chromium virtual authenticator); here we
 *      verify the orchestration glue works end-to-end without crypto.
 *   2. `navigator.credentials` — a minimal authenticator stub that produces
 *      structurally-valid PublicKeyCredential objects from the option blob
 *      the server hands it. Real authenticator interaction also lives in
 *      the e2e suite.
 *
 * What this catches that unit tests cannot:
 *   - Wire mismatches between Core option blob ↔ Shell decode ↔ verify body
 *     (e.g. the user.id base64url regression that started the bug parade)
 *   - Cross-endpoint state coherence: a challenge issued by one POST must
 *     be the one consumed by the verify POST against the same sessionId.
 *   - Hook fire ordering: resolveSessionId → normalizeRegistrationUser →
 *     listExistingCredentials → Core → resolveUser, in that exact sequence,
 *     with the right inputs at each step.
 *   - Per-phase HTTP status defaults landing correctly when failures bubble
 *     through real fetch responses (and not just the local catch).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebAuthn } from "../src/components/WebAuthn";
import { WebAuthnCore } from "../src/core/WebAuthnCore";
import { InMemoryChallengeStore } from "../src/stores/InMemoryChallengeStore";
import { InMemoryCredentialStore } from "../src/stores/InMemoryCredentialStore";
import { createWebAuthnHandlers, type WebAuthnHandlers } from "../src/server/createWebAuthnHandlers";
import { HttpError } from "../src/server/HttpError";
import { encode, decode } from "../src/codec/base64url";
import {
  IWebAuthnVerifier, VerifiedRegistration, VerifiedAuthentication, WebAuthnUser,
} from "../src/types";

/** byte-array equality — for matching binary credentialIds inside the stub. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

if (!customElements.get("hawc-webauthn-int")) {
  customElements.define("hawc-webauthn-int", class extends WebAuthn {});
}

function stubCredentials(mock: any): void {
  Object.defineProperty(navigator, "credentials", {
    value: mock, writable: true, configurable: true,
  });
}

/**
 * Stub authenticator. Fabricates structurally-valid PublicKeyCredential
 * objects from the option blob the server issued.
 *
 * credentialId model: a credential's binary id is a fresh random byte
 * sequence; its string form is `base64url(bytes)`. This matches the WebAuthn
 * wire model and — crucially for the Shell↔Core round-trip — round-trips
 * cleanly through the Shell's `decode(c.id)` / `encode(rawId)` calls. A
 * naïve "credentialId is a human-readable ASCII string" stub breaks at
 * `_get` because the Shell base64url-decodes `allowCredentials[*].id`
 * before handing it to navigator.credentials.get, and the decode is not
 * the identity for arbitrary ASCII.
 */
class StubAuthenticator {
  /** binary credentialId bytes → registered userId. */
  private registry: Array<{ rawId: Uint8Array; userId: string }> = [];
  /** counter for deterministic test-only credentialId generation. */
  private nextSerial = 0;

  install(): void {
    stubCredentials({
      create: (args: CredentialCreationOptions) => Promise.resolve(this._create(args)),
      get: (args: CredentialRequestOptions) => Promise.resolve(this._get(args)),
    });
  }

  /** Force the next created credential to have this exact id (binary).
   *  Lets the duplicate-credential test pin two `_create` calls to the
   *  same id without depending on the serial counter. */
  forceNextRawId(rawId: Uint8Array): void {
    this._forced = rawId;
  }
  private _forced: Uint8Array | null = null;

  private _newRawId(): Uint8Array {
    if (this._forced) {
      const r = this._forced; this._forced = null; return r;
    }
    // Deterministic 16-byte id: 4-byte LE serial + 12 zero pad. Stable
    // across test runs and unique across calls.
    const bytes = new Uint8Array(16);
    const v = this.nextSerial++;
    bytes[0] = v & 0xff;
    bytes[1] = (v >> 8) & 0xff;
    bytes[2] = (v >> 16) & 0xff;
    bytes[3] = (v >> 24) & 0xff;
    return bytes;
  }

  private _create(args: CredentialCreationOptions): any {
    const userIdBuf = new Uint8Array(args.publicKey!.user.id as ArrayBuffer);
    const userId = new TextDecoder().decode(userIdBuf);
    const rawId = this._newRawId();
    this.registry.push({ rawId, userId });
    return {
      id: encode(rawId),
      rawId: rawId.buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: new Uint8Array([0x01]).buffer,
        attestationObject: new Uint8Array([0x02]).buffer,
        getTransports: () => ["internal"],
      },
    };
  }

  private _get(args: CredentialRequestOptions): any {
    const allow = args.publicKey!.allowCredentials ?? [];
    let entry: { rawId: Uint8Array; userId: string } | undefined;
    if (allow.length > 0) {
      // Match the binary id Shell already decoded.
      const target = new Uint8Array(allow[0].id as ArrayBuffer);
      entry = this.registry.find(r => bytesEqual(r.rawId, target));
    } else {
      // Usernameless: first registered credential.
      entry = this.registry[0];
    }
    if (!entry) throw new DOMException("no credentials", "NotAllowedError");
    return {
      id: encode(entry.rawId),
      rawId: entry.rawId.buffer,
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: new Uint8Array([0x03]).buffer,
        authenticatorData: new Uint8Array([0x04]).buffer,
        signature: new Uint8Array([0x05]).buffer,
        userHandle: new TextEncoder().encode(entry.userId).buffer,
      },
    };
  }
}

/**
 * Deterministic verifier. Trusts whatever the authenticator stub produced
 * and bumps the per-credential counter by one on every assertion. This is
 * the analogue of hawc-s3's "no SigV4 verification — the presigned URL is
 * treated as opaque" — the cryptographic step is exercised in the e2e
 * suite, not here.
 */
class StubVerifier implements IWebAuthnVerifier {
  counters = new Map<string, number>();
  regCalls: any[] = [];
  authCalls: any[] = [];

  async verifyRegistration(p: any): Promise<VerifiedRegistration> {
    this.regCalls.push(p);
    const credentialId = p.response.id;
    this.counters.set(credentialId, 0);
    return {
      credentialId, publicKey: `pk-${credentialId}`, counter: 0,
    };
  }

  async verifyAuthentication(p: any): Promise<VerifiedAuthentication> {
    this.authCalls.push(p);
    const prev = this.counters.get(p.credential.credentialId) ?? 0;
    const newCounter = prev + 1;
    this.counters.set(p.credential.credentialId, newCounter);
    return { credentialId: p.credential.credentialId, newCounter };
  }
}

interface Harness {
  core: WebAuthnCore;
  challengeStore: InMemoryChallengeStore;
  credentialStore: InMemoryCredentialStore;
  verifier: StubVerifier;
  handlers: WebAuthnHandlers;
  /** every Request that reached either endpoint, in order. */
  requestLog: Array<{ url: string; sessionId?: string; mode?: string }>;
  /** records hook firings so cross-endpoint sequencing is observable. */
  hookLog: string[];
  authenticator: StubAuthenticator;
}

interface HarnessOptions {
  resolveSessionId?: (req: Request) => string | null | Promise<string | null>;
  resolveUser?: (userId: string) => WebAuthnUser | null | Promise<WebAuthnUser | null>;
  normalizeRegistrationUser?: (req: Request, proposed: WebAuthnUser) => WebAuthnUser | Promise<WebAuthnUser>;
  listExistingCredentials?: (req: Request, userId: string) => string[] | Promise<string[]>;
  resolveAuthenticationUserId?: (req: Request, requestedUserId: string | undefined) => string | null | Promise<string | null>;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const challengeStore = new InMemoryChallengeStore();
  const credentialStore = new InMemoryCredentialStore();
  const verifier = new StubVerifier();
  const core = new WebAuthnCore({
    rpId: "example.com", rpName: "Example", origin: "https://example.com",
    challengeStore, credentialStore, verifier,
  });
  const requestLog: Harness["requestLog"] = [];
  const hookLog: string[] = [];

  // Wrap caller-supplied hooks so we can record fire order without losing
  // the actual hook semantics.
  const handlers = createWebAuthnHandlers(core, {
    resolveSessionId: async (req) => {
      hookLog.push("resolveSessionId");
      return opts.resolveSessionId
        ? opts.resolveSessionId(req)
        : req.headers.get("x-session-id");
    },
    resolveUser: opts.resolveUser
      ? async (id) => { hookLog.push(`resolveUser(${id})`); return opts.resolveUser!(id); }
      : undefined,
    normalizeRegistrationUser: opts.normalizeRegistrationUser
      ? async (req, p) => { hookLog.push("normalizeRegistrationUser"); return opts.normalizeRegistrationUser!(req, p); }
      : undefined,
    listExistingCredentials: opts.listExistingCredentials
      ? async (req, id) => { hookLog.push(`listExistingCredentials(${id})`); return opts.listExistingCredentials!(req, id); }
      : undefined,
    resolveAuthenticationUserId: opts.resolveAuthenticationUserId
      ? async (req, id) => { hookLog.push(`resolveAuthenticationUserId(${id})`); return opts.resolveAuthenticationUserId!(req, id); }
      : undefined,
  });

  // Bridge globalThis.fetch to the handlers. The Shell calls
  // /challenge and /verify; route by suffix.
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : (input as URL).toString());
    const headers = new Headers(init?.headers);
    const sessionId = headers.get("x-session-id") ?? undefined;
    const bodyClone = init?.body ? JSON.parse(String(init.body)) : undefined;
    requestLog.push({ url, sessionId, mode: bodyClone?.mode });
    const req = new Request(`https://example.com${url.startsWith("/") ? url : `/${url}`}`, {
      method: init?.method ?? "POST",
      headers,
      body: init?.body as BodyInit,
    });
    if (url.endsWith("/challenge")) return handlers.challenge(req);
    if (url.endsWith("/verify"))    return handlers.verify(req);
    throw new Error(`unexpected fetch ${url}`);
  };
  globalThis.fetch = fetchImpl as any;

  const authenticator = new StubAuthenticator();
  authenticator.install();

  return { core, challengeStore, credentialStore, verifier, handlers, requestLog, hookLog, authenticator };
}

function mkShell(sessionId: string, attrs: Record<string, string> = {}): WebAuthn {
  const el = document.createElement("hawc-webauthn-int") as WebAuthn;
  el.setAttribute("challenge-url", "/challenge");
  el.setAttribute("verify-url", "/verify");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);

  // Inject sessionId via a fetch interceptor — the Shell does not know
  // about session headers itself (the real wire would carry a cookie).
  // Patching via a prefix on every outgoing fetch keeps the Shell unchanged.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) => {
    const headers = new Headers(init?.headers);
    headers.set("x-session-id", sessionId);
    return realFetch(input, { ...init, headers });
  }) as any;
  return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: real Core + handlers + Shell", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    stubCredentials({});
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("end-to-end ceremonies", () => {
    it("register → authenticate → re-authenticate, with sign counter advancing each step", async () => {
      const h = makeHarness({
        resolveUser: (id) => ({ id, name: `${id}@x`, displayName: id }),
        resolveAuthenticationUserId: () => "alice",
      });

      // --- registration ---
      const regShell = mkShell("session-alice", {
        mode: "register",
        "user-id": "alice",
        "user-name": "alice@example.com",
        "user-display-name": "Alice",
      });
      await regShell.start();

      expect(regShell.status).toBe("completed");
      expect(regShell.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);  // base64url
      expect(regShell.user).toEqual({ id: "alice", name: "alice@x", displayName: "alice" });

      // The persisted record carries the userId, transports, and a fresh counter.
      const stored = await h.credentialStore.getById(regShell.credentialId);
      expect(stored?.userId).toBe("alice");
      expect(stored?.transports).toEqual(["internal"]);
      expect(stored?.counter).toBe(0);
      regShell.remove();

      // --- first authentication ---
      const authShell1 = mkShell("session-alice", { mode: "authenticate" });
      await authShell1.start();
      expect(authShell1.status).toBe("completed");
      expect(authShell1.credentialId).toBe(regShell.credentialId);
      expect(authShell1.user).toEqual({ id: "alice", name: "alice@x", displayName: "alice" });
      expect((await h.credentialStore.getById(regShell.credentialId))!.counter).toBe(1);
      authShell1.remove();

      // --- second authentication: counter MUST advance, otherwise Core flags clone ---
      const authShell2 = mkShell("session-alice", { mode: "authenticate" });
      await authShell2.start();
      expect(authShell2.status).toBe("completed");
      expect((await h.credentialStore.getById(regShell.credentialId))!.counter).toBe(2);
      authShell2.remove();
    });

    it("hook firing order across the two endpoints matches the documented contract", async () => {
      const h = makeHarness({
        normalizeRegistrationUser: (_req, p) => p,
        listExistingCredentials: () => [],
        resolveUser: (id) => ({ id, name: id, displayName: id }),
      });
      const shell = mkShell("s1", {
        mode: "register",
        "user-id": "u1", "user-name": "u1", "user-display-name": "U1",
      });
      await shell.start();

      // /challenge:  resolveSessionId → normalizeRegistrationUser → listExistingCredentials
      // /verify:     resolveSessionId → resolveUser
      expect(h.hookLog).toEqual([
        "resolveSessionId",
        "normalizeRegistrationUser",
        "listExistingCredentials(u1)",
        "resolveSessionId",
        "resolveUser(u1)",
      ]);
    });
  });

  describe("session isolation across the wire", () => {
    it("a challenge issued for one session cannot be consumed by another", async () => {
      const h = makeHarness();
      // Session A starts a register ceremony.
      const shellA = mkShell("session-A", {
        mode: "register",
        "user-id": "a", "user-name": "a", "user-display-name": "A",
      });
      // Drive only the challenge phase by stubbing navigator.credentials to
      // never resolve; we'll inspect the challenge slot then forge a verify
      // POST claiming session B.
      const neverResolves = new Promise<never>(() => {});
      stubCredentials({ create: () => neverResolves, get: () => neverResolves });

      // Capture only the challenge response, then abort the Shell.
      shellA.start().catch(() => {});
      // Wait for the challenge fetch to land in the store.
      await new Promise(r => setTimeout(r, 10));
      shellA.abort();
      shellA.remove();

      // Forge a verify call from session B using the credential the
      // Stub authenticator would have produced. Since session B has no
      // slot, the Core rejects with "no active challenge".
      const verifyResp = await h.handlers.verify(new Request("https://example.com/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "session-B" },
        body: JSON.stringify({
          mode: "register",
          credential: {
            id: "forged", rawId: "forged", type: "public-key",
            response: { clientDataJSON: "x", attestationObject: "y" },
          },
        }),
      }));
      expect(verifyResp.status).toBe(400);
      expect((await verifyResp.json()).error).toMatch(/no active challenge/);
    });
  });

  describe("authenticate enumeration defense (default)", () => {
    it("body.userId is dropped → allowCredentials stays empty even if victim has credentials", async () => {
      const h = makeHarness();
      // Pre-seed a credential for the victim.
      await h.credentialStore.put({
        credentialId: "cred-victim", userId: "victim", publicKey: "pk",
        counter: 5, transports: ["internal"], createdAt: Date.now(),
      });

      // Anonymous attacker probes for "victim".
      const res = await h.handlers.challenge(new Request("https://example.com/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "anon" },
        body: JSON.stringify({ mode: "authenticate", userId: "victim" }),
      }));
      const body = await res.json();
      expect(body.allowCredentials).toEqual([]);
    });

    it("step-up via resolveAuthenticationUserId returns the victim's credentials only when authorized", async () => {
      const h = makeHarness({
        // Pretend the session is bound to "alice"; she's allowed to see
        // her own credentials but nobody else's.
        resolveAuthenticationUserId: (_req, requested) => {
          if (requested && requested !== "alice") {
            throw new HttpError(403, "step-up requires the same user");
          }
          return "alice";
        },
      });
      await h.credentialStore.put({
        credentialId: "cred-alice", userId: "alice", publicKey: "pk",
        counter: 0, transports: ["hybrid"], createdAt: Date.now(),
      });
      await h.credentialStore.put({
        credentialId: "cred-victim", userId: "victim", publicKey: "pk",
        counter: 0, createdAt: Date.now(),
      });

      // Alice's session asks for her own ids → returned.
      const ok = await h.handlers.challenge(new Request("https://example.com/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "alice-session" },
        body: JSON.stringify({ mode: "authenticate", userId: "alice" }),
      }));
      const okBody = await ok.json();
      expect(okBody.allowCredentials.map((c: any) => c.id)).toEqual(["cred-alice"]);

      // Alice's session tries to enumerate "victim" → 403.
      const denied = await h.handlers.challenge(new Request("https://example.com/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "alice-session" },
        body: JSON.stringify({ mode: "authenticate", userId: "victim" }),
      }));
      expect(denied.status).toBe(403);
    });
  });

  describe("per-phase HTTP status defaults across real fetch responses", () => {
    it("verify-side failure surfaces as 400 through fetch, not 500", async () => {
      const h = makeHarness({
        resolveUser: (id) => ({ id, name: id, displayName: id }),
      });
      // Register first so the credential exists, then run authenticate
      // with a forged challenge (no session slot) → Core rejects.
      const reg = mkShell("s1", {
        mode: "register",
        "user-id": "u", "user-name": "u", "user-display-name": "U",
      });
      await reg.start();
      reg.remove();

      // Forge a verify against a session with no challenge — the Core
      // throws "no active challenge". Must surface as 400 to the Shell.
      const res = await fetch("/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "no-challenge-yet" },
        body: JSON.stringify({
          mode: "authenticate",
          credential: {
            id: "x", rawId: "x", type: "public-key",
            response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
          },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("resolveUser DB-style failure surfaces as 500 through fetch (5xx alerting works)", async () => {
      const h = makeHarness({
        resolveUser: () => { throw new Error("DB outage"); },
      });
      const shell = mkShell("s1", {
        mode: "register",
        "user-id": "u", "user-name": "u", "user-display-name": "U",
      });

      let caught: any;
      try { await shell.start(); } catch (e) { caught = e; }
      // Shell surfaces the verify error — message includes the 500 status.
      // The response body is MASKED as "user lookup failed" under the
      // information-disclosure policy: raw internal exceptions never reach
      // the wire unless the app opts in by throwing HttpError. The 500
      // status itself still fires 5xx alerts, which is the contract this
      // test pins.
      expect(caught).toBeDefined();
      expect(String(caught.message)).toMatch(/500/);
      expect(String(caught.message)).toMatch(/user lookup failed/);
      // And conversely, the raw DB message must NOT leak on the wire.
      expect(String(caught.message)).not.toMatch(/DB outage/);
    });
  });

  describe("duplicate-credential defense (cross-layer)", () => {
    it("Shell registers once successfully, then a second register that returns the same credentialId is rejected", async () => {
      const h = makeHarness();
      // Pin both registrations to the same binary credentialId so the
      // Core's duplicate guard (`credentialStore.getById` hit) fires.
      const fixed = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE, 0xDE, 0xAD, 0xBE, 0xEF]);
      h.authenticator.forceNextRawId(fixed);

      const shell1 = mkShell("s1", {
        mode: "register",
        "user-id": "alice", "user-name": "alice", "user-display-name": "Alice",
      });
      await shell1.start();
      expect(shell1.status).toBe("completed");
      const firstId = shell1.credentialId;
      shell1.remove();

      h.authenticator.forceNextRawId(fixed);
      const shell2 = mkShell("s2", {
        mode: "register",
        "user-id": "alice", "user-name": "alice", "user-display-name": "Alice",
      });
      // Second attempt with the same credentialId — Core's duplicate guard
      // rejects, surfacing as 400 through the verify fetch.
      await expect(shell2.start()).rejects.toThrow(/already registered/);
      expect(shell2.status).toBe("error");
      // Existing record is intact (same userId, not overwritten).
      const stored = await h.credentialStore.getById(firstId);
      expect(stored?.userId).toBe("alice");
    });
  });
});
