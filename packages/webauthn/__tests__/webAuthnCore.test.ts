import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebAuthnCore } from "../src/core/WebAuthnCore";
import { InMemoryChallengeStore } from "../src/stores/InMemoryChallengeStore";
import { InMemoryCredentialStore } from "../src/stores/InMemoryCredentialStore";
import { decode } from "../src/codec/base64url";
import {
  IWebAuthnVerifier, RegistrationResponseJSON, AuthenticationResponseJSON,
  VerifiedRegistration, VerifiedAuthentication, CredentialRecord,
} from "../src/types";

class FakeVerifier implements IWebAuthnVerifier {
  regCalls: any[] = [];
  authCalls: any[] = [];
  regError: Error | null = null;
  authError: Error | null = null;
  nextReg: VerifiedRegistration = {
    credentialId: "cred-1",
    publicKey: "pubkey-b64",
    counter: 0,
  };
  nextAuth: VerifiedAuthentication = {
    credentialId: "cred-1",
    newCounter: 1,
  };

  async verifyRegistration(params: any): Promise<VerifiedRegistration> {
    this.regCalls.push(params);
    if (this.regError) throw this.regError;
    return this.nextReg;
  }

  async verifyAuthentication(params: any): Promise<VerifiedAuthentication> {
    this.authCalls.push(params);
    if (this.authError) throw this.authError;
    return this.nextAuth;
  }
}

function mkRegistrationResponse(): RegistrationResponseJSON {
  return {
    id: "cred-1", rawId: "cred-1", type: "public-key",
    response: {
      clientDataJSON: "client-data-b64",
      attestationObject: "attestation-b64",
    },
  };
}

function mkAuthResponse(id: string): AuthenticationResponseJSON {
  return {
    id, rawId: id, type: "public-key",
    response: {
      clientDataJSON: "client-data-b64",
      authenticatorData: "auth-data-b64",
      signature: "sig-b64",
    },
  };
}

describe("WebAuthnCore", () => {
  let challengeStore: InMemoryChallengeStore;
  let credentialStore: InMemoryCredentialStore;
  let verifier: FakeVerifier;
  let core: WebAuthnCore;

  beforeEach(() => {
    challengeStore = new InMemoryChallengeStore();
    credentialStore = new InMemoryCredentialStore();
    verifier = new FakeVerifier();
    core = new WebAuthnCore({
      rpId: "example.com",
      rpName: "Example",
      origin: "https://example.com",
      challengeStore, credentialStore, verifier,
    });
  });

  describe("construction", () => {
    it("declares the wcBindable protocol", () => {
      expect(WebAuthnCore.wcBindable.protocol).toBe("wc-bindable");
      expect(WebAuthnCore.wcBindable.version).toBe(1);
      const props = WebAuthnCore.wcBindable.properties.map(p => p.name);
      expect(props).toEqual(["status", "credentialId", "user", "error"]);
      const cmds = (WebAuthnCore.wcBindable.commands ?? []).map(c => c.name);
      expect(cmds).toContain("createRegistrationChallenge");
      expect(cmds).toContain("verifyAuthentication");
    });

    it("is an EventTarget, not an HTMLElement", () => {
      expect(core).toBeInstanceOf(EventTarget);
      expect(core).not.toBeInstanceOf(HTMLElement);
    });

    it("throws when required options are missing", () => {
      expect(() => new WebAuthnCore(undefined as any)).toThrow(/options is required/);
      const base = { rpId: "x", rpName: "x", origin: "x", challengeStore, credentialStore, verifier };
      expect(() => new WebAuthnCore({ ...base, rpId: "" } as any)).toThrow(/rpId/);
      expect(() => new WebAuthnCore({ ...base, rpName: "" } as any)).toThrow(/rpName/);
      expect(() => new WebAuthnCore({ ...base, origin: "" } as any)).toThrow(/origin/);
      expect(() => new WebAuthnCore({ ...base, challengeStore: null } as any)).toThrow(/challengeStore/);
      expect(() => new WebAuthnCore({ ...base, credentialStore: null } as any)).toThrow(/credentialStore/);
      expect(() => new WebAuthnCore({ ...base, verifier: null } as any)).toThrow(/verifier/);
    });

    it("rejects origin shapes that pass a truthy check but break verification (regression)", () => {
      // Regression (Cycle 2 #2): a bare truthy check on options.origin
      // accepted `[]`, `[""]`, `["https://x", ""]`, and arrays of non-string
      // values. Each of these shapes passes schema but makes every
      // verify() fail at the verifier's origin-match step with a
      // cryptic "no origin matched" error — well after a real user has
      // already kicked off a ceremony. Reject at construction so the
      // misconfiguration surfaces immediately to the operator.
      const base = { rpId: "x", rpName: "x", origin: "x", challengeStore, credentialStore, verifier };
      expect(() => new WebAuthnCore({ ...base, origin: [] } as any)).toThrow(/non-empty/);
      expect(() => new WebAuthnCore({ ...base, origin: [""] } as any)).toThrow(/non-empty/);
      expect(() => new WebAuthnCore({ ...base, origin: ["https://x", ""] } as any)).toThrow(/non-empty/);
      expect(() => new WebAuthnCore({ ...base, origin: [123 as any] } as any)).toThrow(/non-empty/);
    });

    it("starts in idle with empty observable state", () => {
      expect(core.status).toBe("idle");
      expect(core.credentialId).toBe("");
      expect(core.user).toBeNull();
      expect(core.error).toBeNull();
    });

    it("returns a defensive copy of user once set", async () => {
      await core.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      const user = core.user!;
      user.name = "mutated";
      expect(core.user).toEqual({ id: "u", name: "n", displayName: "d" });
    });
  });

  describe("createRegistrationChallenge", () => {
    it("returns a well-formed options blob and stores the challenge", async () => {
      const user = { id: "user-42", name: "alice@example.com", displayName: "Alice" };
      const options = await core.createRegistrationChallenge("session-1", user);

      expect(options.rp).toEqual({ id: "example.com", name: "Example" });
      // user.id is base64url-encoded (BufferSource serialization). Decoding
      // back must yield the original UTF-8 string.
      expect(options.user.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(new TextDecoder().decode(decode(options.user.id))).toBe("user-42");
      expect(options.user.name).toBe("alice@example.com");
      expect(options.user.displayName).toBe("Alice");
      expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(options.pubKeyCredParams.some(p => p.alg === -7)).toBe(true);
      expect(options.authenticatorSelection?.userVerification).toBe("preferred");

      // Challenge persisted with the same sessionId and register mode.
      const slot = await challengeStore.take("session-1");
      expect(slot).not.toBeNull();
      expect(slot!.challenge).toBe(options.challenge);
      expect(slot!.mode).toBe("register");
      expect(slot!.userId).toBe("user-42");
    });

    it("transitions status to challenging and sets user", async () => {
      const events: any[] = [];
      core.addEventListener("passkey-auth:status-changed", (e: any) => events.push(["status", e.detail]));
      core.addEventListener("passkey-auth:user-changed", (e: any) => events.push(["user", e.detail]));

      await core.createRegistrationChallenge("s1", { id: "u", name: "u@x", displayName: "U" });

      expect(events[0]).toEqual(["status", "challenging"]);
      expect(events.find(e => e[0] === "user")?.[1]).toEqual({ id: "u", name: "u@x", displayName: "U" });
      expect(core.status).toBe("challenging");
    });

    it("does not redispatch status when it is already challenging", async () => {
      const statuses: string[] = [];
      core.addEventListener("passkey-auth:status-changed", (e: any) => statuses.push(e.detail));
      await core.createRegistrationChallenge("s1", { id: "u", name: "u@x", displayName: "U" });
      await core.createRegistrationChallenge("s2", { id: "u", name: "u@x", displayName: "U" });
      expect(statuses.filter((s) => s === "challenging")).toHaveLength(1);
    });

    it("throws when sessionId or user fields are missing", async () => {
      await expect(core.createRegistrationChallenge("", { id: "u", name: "n", displayName: "d" })).rejects.toThrow(/sessionId/);
      await expect(core.createRegistrationChallenge("s", { id: "", name: "n", displayName: "d" } as any)).rejects.toThrow(/user\.id/);
      await expect(core.createRegistrationChallenge("s", { id: "u", name: "", displayName: "d" } as any)).rejects.toThrow(/user\.id/);
    });

    it("encodes user.id as base64url even when the source contains non-alphabet characters", async () => {
      // Regression: the prior implementation passed user.id as a raw string,
      // and the Shell decoded it as base64url. An email address contains
      // '@' and '.' which are not in the base64url alphabet — decoding
      // would either throw or silently produce unrelated bytes that the
      // authenticator would persist as the credential's user handle.
      const options = await core.createRegistrationChallenge("s1", {
        id: "alice@example.com",
        name: "alice@example.com",
        displayName: "Alice",
      });
      // round-trip: decoding the encoded form must yield the original UTF-8.
      expect(new TextDecoder().decode(decode(options.user.id))).toBe("alice@example.com");
    });

    it("passes existing credential IDs into excludeCredentials", async () => {
      const options = await core.createRegistrationChallenge(
        "s1",
        { id: "u", name: "n", displayName: "d" },
        ["existing-cred-1", "existing-cred-2"],
      );
      expect(options.excludeCredentials).toEqual([
        { id: "existing-cred-1", type: "public-key" },
        { id: "existing-cred-2", type: "public-key" },
      ]);
    });

    it("surfaces challenge-store write failures during registration challenge creation", async () => {
      const failingCore = new WebAuthnCore({
        rpId: "example.com",
        rpName: "Example",
        origin: "https://example.com",
        challengeStore: {
          put: async () => { throw new Error("challenge-store down"); },
          take: async () => null,
        },
        credentialStore,
        verifier,
      });
      await expect(failingCore.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" }))
        .rejects.toThrow(/challenge-store down/);
      expect(failingCore.status).toBe("error");
    });
  });

  describe("verifyRegistration", () => {
    async function seedRegChallenge() {
      return await core.createRegistrationChallenge("s1", {
        id: "user-42", name: "alice@x", displayName: "Alice",
      });
    }

    it("persists the credential and transitions to completed", async () => {
      await seedRegChallenge();
      const record = await core.verifyRegistration("s1", mkRegistrationResponse());

      expect(record.credentialId).toBe("cred-1");
      expect(record.userId).toBe("user-42");
      expect(record.counter).toBe(0);

      const stored = await credentialStore.getById("cred-1");
      expect(stored?.userId).toBe("user-42");
      expect(core.status).toBe("completed");
      expect(core.credentialId).toBe("cred-1");
    });

    it("rejects when no challenge exists for the session", async () => {
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow(/no active challenge/);
      expect(core.status).toBe("error");
      expect(core.error).toBeInstanceOf(Error);
    });

    it("consumes the challenge so retries with the same slot fail", async () => {
      await seedRegChallenge();
      await core.verifyRegistration("s1", mkRegistrationResponse());
      // Second verify should have no slot left (consume-once).
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow(/no active challenge/);
    });

    it("rejects when the challenge was issued for a different mode", async () => {
      await core.createAuthenticationChallenge("s1");
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow(/mode mismatch/);
    });

    it("rejects when the challenge has expired", async () => {
      const core2 = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore, credentialStore, verifier,
        challengeTtlMs: 50,
      });
      await core2.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await new Promise(r => setTimeout(r, 80));
      await expect(core2.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow(/expired/);
    });

    it("surfaces verifier errors and lands in error state", async () => {
      await seedRegChallenge();
      verifier.regError = new Error("bad attestation");
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow("bad attestation");
      expect(core.status).toBe("error");
      expect(core.error?.message).toMatch(/bad attestation/);
    });

    it("attaches a JSON serializer to surfaced errors", async () => {
      await seedRegChallenge();
      verifier.regError = new Error("bad attestation");
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow("bad attestation");
      expect(core.error?.toJSON?.()).toMatchObject({ name: "Error", message: "bad attestation" });
    });

    it("serializes surfaced errors even when the stack is absent", async () => {
      await seedRegChallenge();
      const err = new Error("bad attestation");
      (err as any).stack = "";
      verifier.regError = err;
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow("bad attestation");
      expect(core.error?.toJSON?.()).toEqual({ name: "Error", message: "bad attestation" });
    });

    it("preserves the clientVisible marker on the wrapped core.error (regression)", async () => {
      // `_failVerify` paths attach `clientVisible: true` so the handler's
      // catch can decide to relay the message verbatim. The thrown err
      // is the original (unwrapped) Error today — but `core.error` holds
      // the _SerializableError envelope, and any consumer that inspects
      // that envelope (e.g. RemoteCoreProxy relaying over the wire) must
      // see the same signal. Fire a guaranteed `_failVerify` path and
      // assert the marker survived the wrap.
      await expect(
        core.verifyRegistration("s1", mkRegistrationResponse()),
      ).rejects.toThrow(/no active challenge/);
      expect(core.status).toBe("error");
      expect(core.error).toBeTruthy();
      expect((core.error as any).clientVisible).toBe(true);
    });

    it("passes expected challenge/origin/rpId to the verifier", async () => {
      const options = await seedRegChallenge();
      await core.verifyRegistration("s1", mkRegistrationResponse());
      expect(verifier.regCalls).toHaveLength(1);
      const call = verifier.regCalls[0];
      expect(call.expectedChallenge).toBe(options.challenge);
      expect(call.expectedOrigin).toBe("https://example.com");
      expect(call.expectedRPID).toBe("example.com");
    });

    it("rejects re-registration of a credentialId already owned by the same user (regression)", async () => {
      // Defense in depth against the Shell sending an attested credential
      // we already persisted. Without this guard the InMemory store would
      // silently overwrite, masking duplicate-enrollment issues and
      // inflating audit trails.
      await credentialStore.put({
        credentialId: "cred-1", userId: "user-42", publicKey: "pk",
        counter: 0, createdAt: Date.now(),
      });
      await seedRegChallenge();
      await expect(core.verifyRegistration("s1", mkRegistrationResponse()))
        .rejects.toThrow(/already registered for this user/);
      expect(core.status).toBe("error");
    });

    it("rejects re-registration of a credentialId already owned by ANOTHER user (regression)", async () => {
      // Worse case: silent overwrite would re-home the credential under a
      // new userId, effectively transferring authentication ownership
      // without the original user's involvement. Reject hard.
      await credentialStore.put({
        credentialId: "cred-1", userId: "other-user", publicKey: "pk",
        counter: 0, createdAt: Date.now(),
      });
      await seedRegChallenge();  // session is for user-42
      await expect(core.verifyRegistration("s1", mkRegistrationResponse()))
        .rejects.toThrow(/already registered to a different user/);
      // Verify the existing record was NOT overwritten.
      const stored = await credentialStore.getById("cred-1");
      expect(stored?.userId).toBe("other-user");
    });

    it("forwards transports from the browser response into the persisted record", async () => {
      await seedRegChallenge();
      const response: RegistrationResponseJSON = {
        ...mkRegistrationResponse(),
        response: {
          clientDataJSON: "c", attestationObject: "a",
          transports: ["internal", "hybrid"],
        },
      };
      const record = await core.verifyRegistration("s1", response);
      expect(record.transports).toEqual(["internal", "hybrid"]);
    });

    it("surfaces credential-store write failures during registration verify", async () => {
      const failingStore = {
        put: async () => { throw new Error("credential-store down"); },
        getById: async () => null,
        listByUser: async () => [],
        updateCounter: async () => undefined,
      };
      const failingCore = new WebAuthnCore({
        rpId: "example.com",
        rpName: "Example",
        origin: "https://example.com",
        challengeStore,
        credentialStore: failingStore,
        verifier,
      });
      await failingCore.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await expect(failingCore.verifyRegistration("s1", mkRegistrationResponse()))
        .rejects.toThrow(/credential-store down/);
      expect(failingCore.status).toBe("error");
    });

    it("throws when verifyRegistration is missing required arguments", async () => {
      await expect(core.verifyRegistration("", mkRegistrationResponse())).rejects.toThrow(/sessionId/);
      await expect(core.verifyRegistration("s1", null as any)).rejects.toThrow(/response is required/);
    });

    it("rejects registration slots missing userId", async () => {
      await challengeStore.put("s1", {
        challenge: "c",
        mode: "register",
        createdAt: Date.now(),
      } as any);
      await expect(core.verifyRegistration("s1", mkRegistrationResponse())).rejects.toThrow(/missing userId/);
    });
  });

  describe("createAuthenticationChallenge", () => {
    it("returns a blob without allowCredentials when no userId supplied", async () => {
      const options = await core.createAuthenticationChallenge("s1");
      expect(options.rpId).toBe("example.com");
      expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(options.allowCredentials).toEqual([]);
    });

    it("populates allowCredentials from the user's registered credentials", async () => {
      await credentialStore.put({
        credentialId: "cred-1", userId: "u1", publicKey: "pk",
        counter: 3, transports: ["internal"], createdAt: Date.now(),
      });
      await credentialStore.put({
        credentialId: "cred-2", userId: "u1", publicKey: "pk2",
        counter: 0, createdAt: Date.now(),
      });
      await credentialStore.put({
        credentialId: "cred-3", userId: "u2", publicKey: "pk3",
        counter: 0, createdAt: Date.now(),
      });

      const options = await core.createAuthenticationChallenge("s1", "u1");
      const ids = options.allowCredentials!.map(c => c.id).sort();
      expect(ids).toEqual(["cred-1", "cred-2"]);
      expect(options.allowCredentials!.find(c => c.id === "cred-1")?.transports).toEqual(["internal"]);
    });

    it("binds userId into the challenge slot when targeted", async () => {
      await core.createAuthenticationChallenge("s1", "u1");
      const slot = await challengeStore.take("s1");
      expect(slot?.userId).toBe("u1");
      expect(slot?.mode).toBe("authenticate");
    });

    it("clears the user surface so a prior registration's user does not leak into authenticate (regression)", async () => {
      // Regression: the Core only set `user` during register and never
      // touched it on authenticate, so a consumer binding the Core's
      // wcBindable directly would see the previous registration's user
      // through the entire authenticate flow. Pin the corrected
      // lifecycle: register sets, authenticate clears to null, and
      // verifyAuthentication leaves null (Core doesn't know name /
      // displayName — that's the handler's resolveUser job).
      await core.createRegistrationChallenge("s1", { id: "alice", name: "alice@x", displayName: "Alice" });
      expect(core.user).toEqual({ id: "alice", name: "alice@x", displayName: "Alice" });

      const userEvents: any[] = [];
      core.addEventListener("passkey-auth:user-changed", (e: any) => userEvents.push(e.detail));

      await core.createAuthenticationChallenge("s2");

      expect(core.user).toBeNull();
      expect(userEvents).toContainEqual(null);
    });

    it("user stays null after verifyAuthentication completes", async () => {
      await credentialStore.put({
        credentialId: "cred-1", userId: "alice", publicKey: "pk",
        counter: 0, createdAt: Date.now(),
      });
      // Simulate a residual user from a prior register.
      await core.createRegistrationChallenge("s0", { id: "alice", name: "n", displayName: "A" });
      // New ceremony — should clear and stay clear.
      await core.createAuthenticationChallenge("s1");
      verifier.nextAuth = { credentialId: "cred-1", newCounter: 1 };
      const record = await core.verifyAuthentication("s1", mkAuthResponse("cred-1"));
      expect(record.userId).toBe("alice");
      // Core publishes credentialId, but `user` stays null — Core honestly
      // does not know name/displayName, and faking a partial value would
      // mislead bindings.
      expect(core.user).toBeNull();
      expect(core.credentialId).toBe("cred-1");
    });

    it("surfaces credential-store lookup failures during authentication challenge creation", async () => {
      const failingCore = new WebAuthnCore({
        rpId: "example.com",
        rpName: "Example",
        origin: "https://example.com",
        challengeStore,
        credentialStore: {
          put: async () => undefined,
          getById: async () => null,
          listByUser: async () => { throw new Error("lookup failed"); },
          updateCounter: async () => undefined,
        },
        verifier,
      });
      await expect(failingCore.createAuthenticationChallenge("s1", "u1")).rejects.toThrow(/lookup failed/);
      expect(failingCore.status).toBe("error");
    });

    it("throws when createAuthenticationChallenge is missing sessionId", async () => {
      await expect(core.createAuthenticationChallenge("")).rejects.toThrow(/sessionId/);
    });
  });

  describe("verifyAuthentication", () => {
    async function seedCredentialAndChallenge(targetUserId?: string) {
      await credentialStore.put({
        credentialId: "cred-1", userId: "user-42", publicKey: "pk",
        counter: 5, createdAt: Date.now(),
      });
      await core.createAuthenticationChallenge("s1", targetUserId);
    }

    it("bumps counter and transitions to completed on success", async () => {
      await seedCredentialAndChallenge();
      verifier.nextAuth = { credentialId: "cred-1", newCounter: 6 };

      const record = await core.verifyAuthentication("s1", mkAuthResponse("cred-1"));

      expect(record.credentialId).toBe("cred-1");
      expect(record.counter).toBe(6);
      const stored = await credentialStore.getById("cred-1");
      expect(stored?.counter).toBe(6);
      expect(core.status).toBe("completed");
    });

    it("rejects unknown credentials", async () => {
      await seedCredentialAndChallenge();
      // Uses the same "not recognized for this session" wording as the
      // userId-mismatch branch — see WebAuthnCore.verifyAuthentication
      // for the enumeration-defense rationale.
      await expect(core.verifyAuthentication("s1", mkAuthResponse("unknown"))).rejects.toThrow(/not recognized/);
    });

    it("throws when verifyAuthentication is missing required arguments", async () => {
      await expect(core.verifyAuthentication("", mkAuthResponse("cred-1"))).rejects.toThrow(/sessionId/);
      await expect(core.verifyAuthentication("s1", null as any)).rejects.toThrow(/response is required/);
    });

    it("rejects when no authentication challenge exists", async () => {
      await expect(core.verifyAuthentication("s1", mkAuthResponse("cred-1"))).rejects.toThrow(/no active challenge/);
    });

    it("rejects when the credential does not belong to the targeted user", async () => {
      await credentialStore.put({
        credentialId: "cred-1", userId: "other-user", publicKey: "pk",
        counter: 0, createdAt: Date.now(),
      });
      await core.createAuthenticationChallenge("s1", "user-42");
      // Generic "not recognized" message — distinct strings for
      // "unknown credential" vs "wrong user" would let a caller
      // enumerate which credentials belong to a user. See WebAuthnCore
      // verifyAuthentication comment.
      await expect(core.verifyAuthentication("s1", mkAuthResponse("cred-1"))).rejects.toThrow(/not recognized/);
    });

    it("rejects a stale sign counter (cloned authenticator heuristic)", async () => {
      await seedCredentialAndChallenge();
      // Counter went backwards — classic cloned-authenticator signal.
      verifier.nextAuth = { credentialId: "cred-1", newCounter: 4 };
      await expect(core.verifyAuthentication("s1", mkAuthResponse("cred-1"))).rejects.toThrow(/sign counter/);
      expect(core.status).toBe("error");
    });

    it("accepts counter=0 → newCounter=0 (some authenticators never advance)", async () => {
      await credentialStore.put({
        credentialId: "cred-1", userId: "user-42", publicKey: "pk",
        counter: 0, createdAt: Date.now(),
      });
      await core.createAuthenticationChallenge("s1");
      verifier.nextAuth = { credentialId: "cred-1", newCounter: 0 };
      const record = await core.verifyAuthentication("s1", mkAuthResponse("cred-1"));
      expect(record.counter).toBe(0);
      expect(core.status).toBe("completed");
    });

    it("rejects when the challenge was issued for registration", async () => {
      await core.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await expect(core.verifyAuthentication("s1", mkAuthResponse("cred-1"))).rejects.toThrow(/mode mismatch/);
    });

    it("rejects expired authentication challenges", async () => {
      const core2 = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore, credentialStore, verifier,
        challengeTtlMs: 50,
      });
      await credentialStore.put({
        credentialId: "cred-1", userId: "user-42", publicKey: "pk",
        counter: 5, createdAt: Date.now(),
      });
      await core2.createAuthenticationChallenge("s1");
      await new Promise(r => setTimeout(r, 80));
      await expect(core2.verifyAuthentication("s1", mkAuthResponse("cred-1"))).rejects.toThrow(/expired/);
    });

    it("surfaces verifier errors and lands in error state", async () => {
      await seedCredentialAndChallenge();
      verifier.authError = new Error("bad signature");
      await expect(core.verifyAuthentication("s1", mkAuthResponse("cred-1"))).rejects.toThrow("bad signature");
      expect(core.status).toBe("error");
    });

    it("surfaces counter-store update failures", async () => {
      const failingCore = new WebAuthnCore({
        rpId: "example.com",
        rpName: "Example",
        origin: "https://example.com",
        challengeStore,
        credentialStore: {
          put: async (record) => { await credentialStore.put(record); },
          getById: async (credentialId) => credentialStore.getById(credentialId),
          listByUser: async (userId) => credentialStore.listByUser(userId),
          updateCounter: async () => { throw new Error("update failed"); },
        },
        verifier,
      });
      verifier.nextAuth = { credentialId: "cred-1", newCounter: 6 };
      await credentialStore.put({
        credentialId: "cred-1", userId: "user-42", publicKey: "pk",
        counter: 5, createdAt: Date.now(),
      });
      await failingCore.createAuthenticationChallenge("s1");
      await expect(failingCore.verifyAuthentication("s1", mkAuthResponse("cred-1")))
        .rejects.toThrow(/update failed/);
      expect(failingCore.status).toBe("error");
    });
  });

  describe("reset", () => {
    it("returns to idle with cleared surface", async () => {
      await core.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await core.verifyRegistration("s1", mkRegistrationResponse());
      expect(core.status).toBe("completed");
      expect(core.credentialId).toBe("cred-1");

      core.reset();
      expect(core.status).toBe("idle");
      expect(core.credentialId).toBe("");
      expect(core.user).toBeNull();
      expect(core.error).toBeNull();
    });

    it("does not redispatch credential-id-changed / user-changed on no-op writes (regression)", async () => {
      // Regression (Cycle 2 #6): `_setCredentialId` / `_setUser` now
      // dedupe identical writes. Without the guard, calling `reset()` on
      // a Core that is already idle fired `credential-id-changed` with
      // detail "" and `user-changed` with detail null, causing bound
      // components to churn on spurious transitions. Pin both the
      // idle-only path and the double-reset path here.
      const credIdEvents: any[] = [];
      const userEvents: any[] = [];
      core.addEventListener("passkey-auth:credential-id-changed", (e: any) => credIdEvents.push(e.detail));
      core.addEventListener("passkey-auth:user-changed", (e: any) => userEvents.push(e.detail));

      // Fresh Core starts at "" / null. Reset from this state should emit
      // zero dedup-guarded events.
      core.reset();
      core.reset();

      expect(credIdEvents).toHaveLength(0);
      expect(userEvents).toHaveLength(0);
    });

    it("reset after a completed register dispatches exactly once, and a second reset is a no-op (regression)", async () => {
      // Complementary to the idle-only case above: a reset after real
      // state exists should fire exactly one credential-id-changed ("")
      // and one user-changed (null). A second reset — still "" / null —
      // should fire zero.
      await core.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await core.verifyRegistration("s1", mkRegistrationResponse());

      const credIdEvents: any[] = [];
      const userEvents: any[] = [];
      core.addEventListener("passkey-auth:credential-id-changed", (e: any) => credIdEvents.push(e.detail));
      core.addEventListener("passkey-auth:user-changed", (e: any) => userEvents.push(e.detail));

      core.reset();
      expect(credIdEvents).toEqual([""]);
      expect(userEvents).toEqual([null]);

      core.reset();
      // Second reset is fully dedup'd — no additional dispatches.
      expect(credIdEvents).toEqual([""]);
      expect(userEvents).toEqual([null]);
    });
  });

  describe("target injection", () => {
    it("dispatches events on the external target when provided", async () => {
      const target = new EventTarget();
      const externalCore = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore: new InMemoryChallengeStore(),
        credentialStore: new InMemoryCredentialStore(),
        verifier,
      }, target);

      const events: string[] = [];
      target.addEventListener("passkey-auth:status-changed", (e: any) => events.push(e.detail));
      await externalCore.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      expect(events).toContain("challenging");
    });
  });

  describe("userVerification flag propagation", () => {
    it("passes requireUserVerification=true to the verifier when configured required", async () => {
      const strictCore = new WebAuthnCore({
        rpId: "example.com", rpName: "Example", origin: "https://example.com",
        challengeStore, credentialStore, verifier,
        userVerification: "required",
      });
      await strictCore.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await strictCore.verifyRegistration("s1", mkRegistrationResponse());
      expect(verifier.regCalls[0].requireUserVerification).toBe(true);
    });
  });

  describe("Cycle 9: input guards & reactive reset", () => {
    // Round 2 #7 — WebAuthn §5.4.3 caps user.id at 64 bytes after
    // UTF-8 encoding. The previous implementation silently accepted
    // oversized ids and deferred the failure to the browser's
    // navigator.credentials.create() which surfaced it as a cryptic
    // TypeError — and worse, only after the challenge slot was
    // already consumed.
    it("rejects registration when user.id exceeds 64 UTF-8 bytes", async () => {
      // 65 ASCII bytes (each 1 byte in UTF-8).
      const oversized = "a".repeat(65);
      await expect(
        core.createRegistrationChallenge("s1", { id: oversized, name: "n", displayName: "d" })
      ).rejects.toThrow(/user\.id must be at most 64 bytes/);
    });

    it("rejects user.id that exceeds 64 bytes after multi-byte UTF-8 encoding", async () => {
      // 22 * "あ" (3 bytes each) = 66 bytes — fails even though the
      // JS-string length is only 22.
      const multiByte = "あ".repeat(22);
      await expect(
        core.createRegistrationChallenge("s1", { id: multiByte, name: "n", displayName: "d" })
      ).rejects.toThrow(/64 bytes/);
    });

    it("accepts user.id at the 64-byte boundary", async () => {
      const exactly64 = "a".repeat(64);
      const opts = await core.createRegistrationChallenge("s1", {
        id: exactly64, name: "n", displayName: "d",
      });
      expect(opts.user.id).toBeDefined();
    });

    // Round 2 #11 — existingCredentialIds entries must be base64url.
    // A non-base64url string would either decode to unrelated bytes on
    // the browser side or trip the authenticator's exclude-list check.
    it("rejects non-base64url entries in existingCredentialIds", async () => {
      await expect(
        core.createRegistrationChallenge(
          "s1",
          { id: "u", name: "n", displayName: "d" },
          ["valid-id", "has/slash"],  // "/" is not in the base64url alphabet
        )
      ).rejects.toThrow(/base64url/);
    });

    // Round 2 #6 — new challenge must clear residual credentialId from
    // a prior completed ceremony. The reactive surface otherwise lies
    // ("still on cred-old while registering cred-new").
    it("clears credentialId when a fresh registration challenge is issued", async () => {
      // First complete a full registration to populate credentialId.
      await core.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await core.verifyRegistration("s1", mkRegistrationResponse());
      expect(core.credentialId).toBe("cred-1");
      // A fresh challenge must reset credentialId to "" — AND fire the
      // change event so binders see the transition.
      const events: string[] = [];
      core.addEventListener("passkey-auth:credential-id-changed", (e: any) => events.push(e.detail));
      await core.createRegistrationChallenge("s2", { id: "u2", name: "n2", displayName: "d2" });
      expect(core.credentialId).toBe("");
      expect(events).toContain("");
    });

    it("clears credentialId when a fresh authentication challenge is issued", async () => {
      await core.createRegistrationChallenge("s1", { id: "u", name: "n", displayName: "d" });
      await core.verifyRegistration("s1", mkRegistrationResponse());
      expect(core.credentialId).toBe("cred-1");
      await core.createAuthenticationChallenge("s2");
      expect(core.credentialId).toBe("");
    });
  });
});
