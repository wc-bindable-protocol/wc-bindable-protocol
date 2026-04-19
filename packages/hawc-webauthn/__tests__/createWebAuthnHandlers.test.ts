import { describe, it, expect, beforeEach } from "vitest";
import { WebAuthnCore } from "../src/core/WebAuthnCore";
import { InMemoryChallengeStore } from "../src/stores/InMemoryChallengeStore";
import { InMemoryCredentialStore } from "../src/stores/InMemoryCredentialStore";
import { createWebAuthnHandlers } from "../src/server/createWebAuthnHandlers";
import { HttpError } from "../src/server/HttpError";
import { decode } from "../src/codec/base64url";
import {
  IWebAuthnVerifier, VerifiedRegistration, VerifiedAuthentication,
} from "../src/types";

function decodedUserId(encoded: string): string {
  return new TextDecoder().decode(decode(encoded));
}

class FakeVerifier implements IWebAuthnVerifier {
  nextReg: VerifiedRegistration = { credentialId: "cred-1", publicKey: "pk", counter: 0 };
  nextAuth: VerifiedAuthentication = { credentialId: "cred-1", newCounter: 1 };
  async verifyRegistration() { return this.nextReg; }
  async verifyAuthentication() { return this.nextAuth; }
}

function mkCore() {
  return new WebAuthnCore({
    rpId: "example.com",
    rpName: "Example",
    origin: "https://example.com",
    challengeStore: new InMemoryChallengeStore(),
    credentialStore: new InMemoryCredentialStore(),
    verifier: new FakeVerifier(),
  });
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("createWebAuthnHandlers", () => {
  let core: WebAuthnCore;

  beforeEach(() => {
    core = mkCore();
  });

  describe("challenge handler", () => {
    it("returns 405 for non-POST", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await challenge(new Request("https://x/challenge", { method: "GET" }));
      expect(res.status).toBe(405);
    });

    it("returns 401 when the session cannot be resolved", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => null });
      const res = await challenge(postJson("https://x/challenge", { mode: "register" }));
      expect(res.status).toBe(401);
    });

    it("falls back to 'unauthorized' when resolveSessionId throws without a message", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => { throw {}; } });
      const res = await challenge(postJson("https://x/challenge", { mode: "authenticate" }));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    });

    it("returns 400 for invalid JSON", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await challenge(new Request("https://x/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }));
      expect(res.status).toBe(400);
    });

    it("returns a registration option blob for mode=register", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await challenge(postJson("https://x/challenge", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rp).toEqual({ id: "example.com", name: "Example" });
      // Wire format: user.id is base64url-encoded UTF-8 (matches the
      // PublicKeyCredentialCreationOptionsJSON spec). Round-trip back to
      // confirm the application id reaches the Shell intact.
      expect(decodedUserId(body.user.id)).toBe("u-1");
    });

    it("rejects mode=register without required user fields", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await challenge(postJson("https://x/challenge", {
        mode: "register",
        user: { id: "u-1", name: "" },
      }));
      expect(res.status).toBe(400);
    });

    it("applies normalizeRegistrationUser when configured", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: (_req, proposed) => ({
          ...proposed, id: "server-pinned-id",
        }),
      });
      const res = await challenge(postJson("https://x/challenge", {
        mode: "register",
        user: { id: "spoofed", name: "a@x", displayName: "Alice" },
      }));
      const body = await res.json();
      expect(decodedUserId(body.user.id)).toBe("server-pinned-id");
    });

    it("returns an authentication option blob for mode=authenticate", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await challenge(postJson("https://x/challenge", { mode: "authenticate" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rpId).toBe("example.com");
      expect(body.allowCredentials).toEqual([]);
    });

    it("returns 400 for an unknown mode", async () => {
      const { challenge } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await challenge(postJson("https://x/challenge", { mode: "invalid" }));
      expect(res.status).toBe(400);
    });
  });

  describe("verify handler", () => {
    it("returns 400 for missing credential in body", async () => {
      const { verify } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await verify(postJson("https://x/verify", { mode: "register" }));
      expect(res.status).toBe(400);
    });

    it("round-trips a registration end-to-end", async () => {
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: (userId) => ({ id: userId, name: "a@x", displayName: "Alice" }),
      });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.credentialId).toBe("cred-1");
      expect(body.user).toEqual({ id: "u-1", name: "a@x", displayName: "Alice" });
    });

    it("round-trips an authentication end-to-end", async () => {
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: (userId) => ({ id: userId, name: "a@x", displayName: "Alice" }),
      });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      await handlers.challenge(postJson("https://x/c", { mode: "authenticate" }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "authenticate",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
        },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.credentialId).toBe("cred-1");
      expect(body.user).toEqual({ id: "u-1", name: "a@x", displayName: "Alice" });
    });

    it("turns verify failures into 400s, not 500s", async () => {
      const handlers = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      // No challenge seeded — verify will reject with "no active challenge".
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: { id: "c", rawId: "c", type: "public-key", response: { clientDataJSON: "", attestationObject: "" } },
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no active challenge/);
    });

    it("returns 405 for non-POST verify", async () => {
      const { verify } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await verify(new Request("https://x/verify", { method: "GET" }));
      expect(res.status).toBe(405);
    });

    it("returns 400 for invalid JSON body", async () => {
      const { verify } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await verify(new Request("https://x/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }));
      expect(res.status).toBe(400);
    });

    it("returns 400 for unknown mode", async () => {
      const { verify } = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      const res = await verify(postJson("https://x/verify", {
        mode: "weird",
        credential: { id: "c" },
      }));
      expect(res.status).toBe(400);
    });
  });

  describe("session resolution", () => {
    it("supports async resolveSessionId", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: async () => "async-session",
      });
      const res = await challenge(postJson("https://x/c", { mode: "authenticate" }));
      expect(res.status).toBe(200);
    });

    it("honors HttpError(401) thrown from resolveSessionId", async () => {
      const { challenge, verify } = createWebAuthnHandlers(core, {
        resolveSessionId: () => { throw new HttpError(401, "no cookie"); },
      });
      const r1 = await challenge(postJson("https://x/c", { mode: "authenticate" }));
      expect(r1.status).toBe(401);
      expect((await r1.json()).error).toBe("no cookie");
      const r2 = await verify(postJson("https://x/v", { mode: "authenticate", credential: { id: "x" } }));
      expect(r2.status).toBe(401);
    });

    it("defaults to 401 when resolveSessionId throws a plain Error", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => { throw new Error("session decode failed"); },
      });
      const res = await challenge(postJson("https://x/c", { mode: "authenticate" }));
      expect(res.status).toBe(401);
    });
  });

  describe("hook error → HTTP status (regression)", () => {
    // Regression: every exception inside normalizeRegistrationUser /
    // resolveUser used to collapse into the catch's default status,
    // producing a 500 for the README's `requireSignedInUser(req)`
    // pattern. Auth errors should be 401/403, not "server error".

    it("normalizeRegistrationUser → HttpError(401) maps to 401, not 500", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: () => {
          throw new HttpError(401, "not signed in");
        },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("not signed in");
    });

    it("normalizeRegistrationUser → HttpError(403) maps to 403", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: () => {
          throw new HttpError(403, "forbidden");
        },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(403);
    });

    it("normalizeRegistrationUser without a message falls back to 'challenge failed'", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: () => {
          throw { status: 418 };
        },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(418);
      expect((await res.json()).error).toBe("challenge failed");
    });

    it("plain Error with .status is honored without importing HttpError", async () => {
      const customErr: any = new Error("upstream auth down");
      customErr.status = 503;
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: () => { throw customErr; },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(503);
    });

    it("genuine internal error without .status still defaults to 500", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: () => { throw new Error("kaboom"); },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(500);
    });

    it("invalid status numbers on Error are ignored (fallback applies)", async () => {
      // `.status` must be an integer in [100, 600). A garbage value like
      // 99 or "401" should be ignored — otherwise an attacker-influenced
      // error could downgrade a 500 to a 200, etc.
      const garbageErr: any = new Error("x");
      garbageErr.status = 99;
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        normalizeRegistrationUser: () => { throw garbageErr; },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      expect(res.status).toBe(500);
    });

    it("resolveUser → HttpError(403) on verify is forwarded", async () => {
      // First seed a registration so verify has something to find.
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: () => { throw new HttpError(403, "user disabled"); },
      });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      expect(res.status).toBe(403);
    });

    it("resolveUser plain Error defaults to 500, NOT 400 (regression)", async () => {
      // Regression: the prior shape shared one try/catch between verify
      // (default 400) and resolveUser (application territory, default
      // 500). A DB outage inside resolveUser became a 400 and silently
      // hid the 5xx event from infra alerts. This test pins the split:
      // verify-side errors stay 400, resolveUser-side errors become 500
      // unless the caller supplied a `.status` override.
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: () => { throw new Error("DB connection lost"); },
      });
      // Successful verify, then resolveUser blows up.
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/DB connection lost/);
    });

    it("verify failure on a happy resolveUser still returns 400 (regression — split is symmetric)", async () => {
      // The mirror case: verify fails (no challenge seeded), and
      // resolveUser is configured but never reached. Default must
      // remain 400 — the new split must not bleed the 500 default
      // from the resolveUser path back into the verify path.
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: (id) => ({ id, name: "n", displayName: "D" }),
      });
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "authenticate",
        credential: {
          id: "missing-cred", rawId: "missing-cred", type: "public-key",
          response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
        },
      }));
      expect(res.status).toBe(400);
    });

    it("resolveUser returning null becomes user: null in the response", async () => {
      // Edge case the new code now spells out via `?? null` — async
      // resolveUser implementations often return `undefined` when not
      // found, which used to coerce into the response body literally
      // as `undefined` (dropped by JSON.stringify). Always serialize as
      // null so consumers see a stable shape.
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: () => undefined as any,
      });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      const body = await res.json();
      expect(body).toEqual({ credentialId: "cred-1", user: null });
    });

    it("invalid status from resolveUser is ignored (defaults to 500)", async () => {
      const garbage: any = new Error("x");
      garbage.status = "401";  // string, not number → invalid
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: () => { throw garbage; },
      });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      expect(res.status).toBe(500);
    });

    it("returns 401 for verify when the session cannot be resolved", async () => {
      const { verify } = createWebAuthnHandlers(core, { resolveSessionId: () => null });
      const res = await verify(postJson("https://x/v", {
        mode: "authenticate",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
        },
      }));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("session required");
    });

    it("falls back to 'unauthorized' for verify when resolveSessionId throws without a message", async () => {
      const { verify } = createWebAuthnHandlers(core, { resolveSessionId: () => { throw {}; } });
      const res = await verify(postJson("https://x/v", {
        mode: "authenticate",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
        },
      }));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    });

    it("returns null user on successful authenticate verify when resolveUser is omitted", async () => {
      const handlers = createWebAuthnHandlers(core, { resolveSessionId: () => "s1" });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      await handlers.challenge(postJson("https://x/c", { mode: "authenticate" }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "authenticate",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
        },
      }));
      expect(res.status).toBe(200);
      expect((await res.json()).user).toBeNull();
    });

    it("falls back to 'user lookup failed' when resolveUser throws an opaque value", async () => {
      // Updated: opaque throws from resolveUser now correctly land in the
      // 500/"user lookup failed" path (previously they were collapsed
      // into the verify path's 400/"verify failed" — the very bug the
      // try-block split fixes).
      const handlers = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        resolveUser: () => { throw {}; },
      });
      await handlers.challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("user lookup failed");
    });

    it("falls back to 'verify failed' when verify itself throws an opaque value", async () => {
      // Symmetric companion to the above: on the verify-side the default
      // remains 400/"verify failed". The split must not bleed the
      // resolveUser default backwards. Inject a Core whose verify throws
      // an opaque value with no message — that exercises both the
      // 400 default and the message-fallback branch.
      const opaqueCore = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore: new InMemoryChallengeStore(),
        credentialStore: new InMemoryCredentialStore(),
        verifier: {
          async verifyRegistration() { throw {}; },
          async verifyAuthentication() { throw {}; },
        },
      });
      // Seed a challenge so the verify path makes it past the slot lookup.
      await opaqueCore.createRegistrationChallenge("s1", { id: "u-1", name: "n", displayName: "D" });
      const handlers = createWebAuthnHandlers(opaqueCore, { resolveSessionId: () => "s1" });
      const res = await handlers.verify(postJson("https://x/v", {
        mode: "register",
        credential: {
          id: "cred-1", rawId: "cred-1", type: "public-key",
          response: { clientDataJSON: "c", attestationObject: "a" },
        },
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("verify failed");
    });
  });

  describe("resolveAuthenticationUserId (regression — enumeration)", () => {
    // Regression: the prior handler passed body.userId straight into the
    // Core's authenticate-challenge path, surfacing the user's credential
    // ids and transports in `allowCredentials`. An unauthenticated caller
    // could enumerate arbitrary userIds and learn (a) whether the user
    // had a passkey, (b) the credential ids, (c) the transport (e.g.
    // "internal" → platform authenticator). The current handler ignores
    // body.userId by default and only honors a userId returned by the
    // resolveAuthenticationUserId hook.

    async function seedCredsFor(userId: string, store: InMemoryCredentialStore): Promise<void> {
      await store.put({
        credentialId: `cred-${userId}`, userId, publicKey: "pk",
        counter: 0, transports: ["internal"], createdAt: Date.now(),
      });
    }

    it("ignores client-supplied userId by default — allowCredentials is empty", async () => {
      // Seed a victim whose credentials would be exposed if the handler
      // trusted the client's userId.
      const credentialStore = new InMemoryCredentialStore();
      await seedCredsFor("victim", credentialStore);
      const c = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore: new InMemoryChallengeStore(),
        credentialStore,
        verifier: new FakeVerifier(),
      });
      const { challenge } = createWebAuthnHandlers(c, { resolveSessionId: () => "anon" });
      const res = await challenge(postJson("https://x/c", {
        mode: "authenticate",
        userId: "victim",
      }));
      const body = await res.json();
      // Empty list — the attacker learned nothing about "victim".
      expect(body.allowCredentials).toEqual([]);
    });

    it("honors a userId returned by resolveAuthenticationUserId", async () => {
      const credentialStore = new InMemoryCredentialStore();
      await seedCredsFor("alice", credentialStore);
      const c = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore: new InMemoryChallengeStore(),
        credentialStore,
        verifier: new FakeVerifier(),
      });
      const { challenge } = createWebAuthnHandlers(c, {
        resolveSessionId: () => "s1",
        resolveAuthenticationUserId: () => "alice",  // signed-in session
      });
      const res = await challenge(postJson("https://x/c", { mode: "authenticate" }));
      const body = await res.json();
      expect(body.allowCredentials.map((c: any) => c.id)).toEqual(["cred-alice"]);
    });

    it("hook receives the (untrusted) requested userId from the body", async () => {
      const c = mkCore();
      let receivedRequested: string | undefined;
      const { challenge } = createWebAuthnHandlers(c, {
        resolveSessionId: () => "s1",
        resolveAuthenticationUserId: (_req, requestedUserId) => {
          receivedRequested = requestedUserId;
          return null;  // refuse — keep it usernameless
        },
      });
      await challenge(postJson("https://x/c", { mode: "authenticate", userId: "spoofed" }));
      expect(receivedRequested).toBe("spoofed");
    });

    it("hook returning null forces usernameless even when client sent a userId", async () => {
      const credentialStore = new InMemoryCredentialStore();
      await seedCredsFor("victim", credentialStore);
      const c = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore: new InMemoryChallengeStore(),
        credentialStore,
        verifier: new FakeVerifier(),
      });
      const { challenge } = createWebAuthnHandlers(c, {
        resolveSessionId: () => "s1",
        resolveAuthenticationUserId: () => null,
      });
      const res = await challenge(postJson("https://x/c", { mode: "authenticate", userId: "victim" }));
      const body = await res.json();
      expect(body.allowCredentials).toEqual([]);
    });

    it("hook can throw HttpError to fail fast on mismatch", async () => {
      const c = mkCore();
      const { challenge } = createWebAuthnHandlers(c, {
        resolveSessionId: () => "s1",
        resolveAuthenticationUserId: (_req, requestedUserId) => {
          if (requestedUserId !== "alice") throw new HttpError(403, "step-up requires the same user");
          return "alice";
        },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "authenticate", userId: "spoofed",
      }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/step-up/);
    });

    it("supports an async hook", async () => {
      const credentialStore = new InMemoryCredentialStore();
      await seedCredsFor("alice", credentialStore);
      const c = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore: new InMemoryChallengeStore(),
        credentialStore,
        verifier: new FakeVerifier(),
      });
      const { challenge } = createWebAuthnHandlers(c, {
        resolveSessionId: () => "s1",
        resolveAuthenticationUserId: async () => "alice",
      });
      const res = await challenge(postJson("https://x/c", { mode: "authenticate" }));
      const body = await res.json();
      expect(body.allowCredentials.map((c: any) => c.id)).toEqual(["cred-alice"]);
    });
  });

  describe("listExistingCredentials (regression)", () => {
    // Regression: the prior handler did not pass excludeCredentials at
    // all, so the README server setup could not actually leverage the
    // browser's "you've already registered this device" UX. The hook
    // below threads the existing credentialIds through to the option
    // blob, and the Core also enforces a server-side duplicate guard
    // at verify time.

    it("plumbs returned credentialIds into the option blob's excludeCredentials", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        listExistingCredentials: (_req, userId) => {
          expect(userId).toBe("u-1");
          return ["existing-cred-a", "existing-cred-b"];
        },
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const body = await res.json();
      expect(body.excludeCredentials.map((c: any) => c.id).sort())
        .toEqual(["existing-cred-a", "existing-cred-b"]);
    });

    it("supports an async hook", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
        listExistingCredentials: async () => ["from-db-1"],
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const body = await res.json();
      expect(body.excludeCredentials).toEqual([{ id: "from-db-1", type: "public-key" }]);
    });

    it("handler omits excludeCredentials when no hook is configured", async () => {
      const { challenge } = createWebAuthnHandlers(core, {
        resolveSessionId: () => "s1",
      });
      const res = await challenge(postJson("https://x/c", {
        mode: "register",
        user: { id: "u-1", name: "a@x", displayName: "Alice" },
      }));
      const body = await res.json();
      expect(body.excludeCredentials).toEqual([]);
    });
  });
});
