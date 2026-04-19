import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebAuthn } from "../src/components/WebAuthn";
import { encode } from "../src/codec/base64url";

// Register once globally. Each test uses a fresh element instance; the
// element class itself is shared.
if (!customElements.get("hawc-webauthn")) {
  customElements.define("hawc-webauthn", WebAuthn);
}

// happy-dom exposes `navigator.credentials` as a read-only getter, so a
// direct `navigator.credentials = ...` throws. Installing a writable
// data property here flips it to an ordinary slot that tests can stub
// via `stubCredentials(mock)`.
function stubCredentials(mock: any): void {
  Object.defineProperty(navigator, "credentials", {
    value: mock,
    writable: true,
    configurable: true,
  });
}

/** Minimal fake PublicKeyCredential for registration responses. */
function fakeAttestationCredential(): any {
  return {
    id: "cred-1",
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: new Uint8Array([9, 9]).buffer,
      attestationObject: new Uint8Array([8, 8]).buffer,
      getTransports: () => ["internal"],
    },
  };
}

function fakeAssertionCredential(): any {
  return {
    id: "cred-1",
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: new Uint8Array([9, 9]).buffer,
      authenticatorData: new Uint8Array([7, 7]).buffer,
      signature: new Uint8Array([6, 6]).buffer,
      userHandle: new Uint8Array([5, 5]).buffer,
    },
  };
}

/** Create a ready-to-run `<hawc-webauthn>` attached to document.body. */
function mkElement(attrs: Record<string, string>): WebAuthn {
  const el = document.createElement("hawc-webauthn") as WebAuthn;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe("<hawc-webauthn> shell", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    // Provide a permissive default credentials mock so tests that do not
    // care about the authenticator response still pass the precondition
    // check in `_runCeremony`.
    stubCredentials({ create: vi.fn(), get: vi.fn() });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    // Reset to a neutral mock rather than trying to restore the original
    // getter — happy-dom's initial getter cannot be re-installed.
    stubCredentials({});
    document.body.innerHTML = "";
  });

  describe("wcBindable declaration", () => {
    it("exposes status/credentialId/user/error/trigger + start/abort commands", () => {
      const decl = WebAuthn.wcBindable;
      expect(decl.protocol).toBe("wc-bindable");
      expect(decl.version).toBe(1);
      expect(decl.properties.map(p => p.name))
        .toEqual(["status", "credentialId", "user", "error", "trigger"]);
      expect(decl.commands!.map(c => c.name)).toEqual(["start", "abort"]);
    });
  });

  describe("attribute mapping", () => {
    it("defaults mode to register and userVerification to preferred", () => {
      const el = mkElement({});
      expect(el.mode).toBe("register");
      expect(el.userVerification).toBe("preferred");
      expect(el.attestation).toBe("none");
      expect(el.timeout).toBe(60_000);
    });

    it("reads valid mode values", () => {
      const el = mkElement({ mode: "authenticate" });
      expect(el.mode).toBe("authenticate");
    });

    it("treats invalid user-verification as preferred", () => {
      const el = mkElement({ "user-verification": "garbage" });
      expect(el.userVerification).toBe("preferred");
    });

    it("parses positive finite timeout", () => {
      const el = mkElement({ timeout: "12000" });
      expect(el.timeout).toBe(12_000);
    });

    it("falls back to default timeout for zero, negative, or NaN", () => {
      expect(mkElement({ timeout: "0" }).timeout).toBe(60_000);
      expect(mkElement({ timeout: "-5" }).timeout).toBe(60_000);
      expect(mkElement({ timeout: "abc" }).timeout).toBe(60_000);
    });

    it("returns defaults for missing or invalid rpId and attestation", () => {
      expect(mkElement({}).rpId).toBe("");
      expect(mkElement({ "user-verification": "required" }).userVerification).toBe("required");
      expect(mkElement({ attestation: "weird" as any }).attestation).toBe("none");
      expect(mkElement({ attestation: "direct" }).attestation).toBe("direct");
    });

    it("property setters reflect to attributes", () => {
      const el = mkElement({});
      el.mode = "authenticate";
      el.rpId = "example.com";
      el.userVerification = "required";
      el.attestation = "direct";
      el.challengeUrl = "/challenge";
      el.verifyUrl = "/verify";
      el.userId = "u-1";
      el.userName = "alice@example.com";
      el.userDisplayName = "Alice";
      el.timeout = 1234;
      expect(el.getAttribute("mode")).toBe("authenticate");
      expect(el.getAttribute("rp-id")).toBe("example.com");
      expect(el.getAttribute("user-verification")).toBe("required");
      expect(el.getAttribute("attestation")).toBe("direct");
      expect(el.getAttribute("challenge-url")).toBe("/challenge");
      expect(el.getAttribute("verify-url")).toBe("/verify");
      expect(el.getAttribute("user-id")).toBe("u-1");
      expect(el.getAttribute("user-name")).toBe("alice@example.com");
      expect(el.getAttribute("user-display-name")).toBe("Alice");
      expect(el.getAttribute("timeout")).toBe("1234");
    });
  });

  describe("start() — registration flow", () => {
    it("runs challenge → create() → verify and lands on completed", async () => {
      const el = mkElement({
        mode: "register",
        "challenge-url": "/challenge",
        "verify-url": "/verify",
        "user-id": "u-1", "user-name": "a@x", "user-display-name": "Alice",
      });

      const challengeOptions = {
        rp: { id: "example.com", name: "Example" },
        user: { id: encode(new TextEncoder().encode("u-1")), name: "a@x", displayName: "Alice" },
        challenge: encode(new Uint8Array([1, 2, 3])),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true, json: async () => challengeOptions,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ credentialId: "cred-1", user: { id: "u-1", name: "a@x", displayName: "Alice" } }),
        });
      globalThis.fetch = fetchMock as any;

      const createMock = vi.fn().mockResolvedValue(fakeAttestationCredential());
      stubCredentials({ create: createMock, get: vi.fn() });

      const statuses: string[] = [];
      el.addEventListener("hawc-webauthn:status-changed", (e: any) => statuses.push(e.detail));

      await el.start();

      expect(statuses).toEqual(["challenging", "creating", "verifying", "completed"]);
      expect(el.status).toBe("completed");
      expect(el.credentialId).toBe("cred-1");
      expect(el.user).toEqual({ id: "u-1", name: "a@x", displayName: "Alice" });

      // Sanity-check the challenge-url body.
      const challengeCall = fetchMock.mock.calls[0];
      expect(challengeCall[0]).toBe("/challenge");
      const chBody = JSON.parse(challengeCall[1].body);
      expect(chBody.mode).toBe("register");
      expect(chBody.user).toEqual({ id: "u-1", name: "a@x", displayName: "Alice" });

      // The navigator.credentials.create() call received decoded buffers.
      expect(createMock).toHaveBeenCalledOnce();
      const createArgs = createMock.mock.calls[0][0];
      expect(createArgs.publicKey.challenge).toBeInstanceOf(Uint8Array);
      expect(createArgs.publicKey.user.id).toBeInstanceOf(Uint8Array);

      // The verify body carries base64url-encoded buffers.
      const verifyCall = fetchMock.mock.calls[1];
      expect(verifyCall[0]).toBe("/verify");
      const verifyBody = JSON.parse(verifyCall[1].body);
      expect(verifyBody.mode).toBe("register");
      expect(verifyBody.credential.id).toBe("cred-1");
      expect(verifyBody.credential.response.attestationObject).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(verifyBody.credential.response.transports).toEqual(["internal"]);
    });

    it("fails fast when user-* attributes are missing in register mode", async () => {
      const el = mkElement({
        mode: "register",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn() as any;

      await expect(el.start()).rejects.toThrow(/user-id/);
      expect(el.status).toBe("error");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("passes excludeCredentials through to navigator.credentials.create", async () => {
      const el = mkElement({
        mode: "register",
        "challenge-url": "/challenge",
        "verify-url": "/verify",
        "user-id": "u-1", "user-name": "a@x", "user-display-name": "Alice",
      });
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rp: { id: "example.com", name: "Example" },
            user: { id: encode(new TextEncoder().encode("u-1")), name: "a@x", displayName: "Alice" },
            challenge: encode(new Uint8Array([1, 2, 3])),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            excludeCredentials: [{ id: encode(new Uint8Array([4, 5])), type: "public-key", transports: ["usb"] }],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) }) as any;
      const createMock = vi.fn().mockResolvedValue(fakeAttestationCredential());
      stubCredentials({ create: createMock, get: vi.fn() });
      await el.start();
      const arg = createMock.mock.calls[0][0];
      expect(Array.from(arg.publicKey.excludeCredentials[0].id)).toEqual([4, 5]);
      expect(arg.publicKey.excludeCredentials[0].transports).toEqual(["usb"]);
    });

    it("throws when navigator.credentials.create returns null", async () => {
      const el = mkElement({
        mode: "register",
        "challenge-url": "/challenge",
        "verify-url": "/verify",
        "user-id": "u-1", "user-name": "a@x", "user-display-name": "Alice",
      });
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          rp: { id: "example.com", name: "Example" },
          user: { id: encode(new TextEncoder().encode("u-1")), name: "a@x", displayName: "Alice" },
          challenge: encode(new Uint8Array([1, 2, 3])),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        }),
      }) as any;
      stubCredentials({ create: vi.fn().mockResolvedValue(null), get: vi.fn() });
      await expect(el.start()).rejects.toThrow(/create\(\) returned null/);
    });
  });

  describe("start() — authentication flow", () => {
    it("runs challenge → get() → verify and emits correct status progression", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/challenge", "verify-url": "/verify",
      });

      const challengeOptions = {
        challenge: encode(new Uint8Array([9, 9])),
        timeout: 60_000,
        rpId: "example.com",
        allowCredentials: [],
        userVerification: "preferred",
      };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => challengeOptions })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) });
      globalThis.fetch = fetchMock as any;

      const getMock = vi.fn().mockResolvedValue(fakeAssertionCredential());
      stubCredentials({ create: vi.fn(), get: getMock });

      const statuses: string[] = [];
      el.addEventListener("hawc-webauthn:status-changed", (e: any) => statuses.push(e.detail));

      await el.start();

      expect(statuses).toEqual(["challenging", "asserting", "verifying", "completed"]);
      expect(el.credentialId).toBe("cred-1");
      expect(getMock).toHaveBeenCalledOnce();

      const verifyBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(verifyBody.credential.response.signature).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(verifyBody.credential.response.userHandle).toBeDefined();
    });

    it("includes userId in the challenge body when targeted", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
        "user-id": "u-42",
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) });
      globalThis.fetch = fetchMock as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      await el.start();

      const chBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(chBody.userId).toBe("u-42");
    });

    it("passes allowCredentials through to navigator.credentials.get", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            challenge: encode(new Uint8Array([1])),
            rpId: "x",
            allowCredentials: [{ id: encode(new Uint8Array([9, 8])), type: "public-key", transports: ["internal"] }],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) }) as any;
      const getMock = vi.fn().mockResolvedValue(fakeAssertionCredential());
      stubCredentials({ get: getMock, create: vi.fn() });
      await el.start();
      const arg = getMock.mock.calls[0][0];
      expect(Array.from(arg.publicKey.allowCredentials[0].id)).toEqual([9, 8]);
      expect(arg.publicKey.allowCredentials[0].transports).toEqual(["internal"]);
    });

    it("throws when navigator.credentials.get returns null", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x" }),
      }) as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(null), create: vi.fn() });
      await expect(el.start()).rejects.toThrow(/get\(\) returned null/);
    });

    it("falls back to statusText when verify returns an empty body", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => { throw new Error("no body"); },
        }) as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()), create: vi.fn() });
      await expect(el.start()).rejects.toThrow(/Bad Request/);
    });
  });

  describe("error handling", () => {
    it("surfaces a non-OK challenge response and lands in error", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false, status: 401, statusText: "Unauthorized",
        text: async () => "",
      }) as any;

      await expect(el.start()).rejects.toThrow(/challenge request failed \(401\)/);
      expect(el.status).toBe("error");
    });

    it("falls back to challenge statusText when the challenge error body is unreadable", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => { throw new Error("no body"); },
      }) as any;

      await expect(el.start()).rejects.toThrow(/Unauthorized/);
      expect(el.status).toBe("error");
    });

    it("surfaces a non-OK verify response", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValueOnce({
          ok: false, status: 400, statusText: "bad",
          text: async () => "verify rejected",
        }) as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      await expect(el.start()).rejects.toThrow(/verify request failed \(400\)/);
      expect(el.status).toBe("error");
    });

    it("surfaces NotAllowedError from navigator.credentials and reaches error", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
      }) as any;
      stubCredentials({
        get: vi.fn().mockRejectedValue(new DOMException("user dismissed", "NotAllowedError")),
      });

      await expect(el.start()).rejects.toThrow(/user dismissed/);
      expect(el.status).toBe("error");
      expect(el.error).toBeInstanceOf(DOMException);
    });

    it("fails when challenge-url is missing", async () => {
      const el = mkElement({ mode: "authenticate", "verify-url": "/v" });
      await expect(el.start()).rejects.toThrow(/challenge-url/);
      expect(el.status).toBe("error");
    });

    it("fails when verify-url is missing", async () => {
      const el = mkElement({ mode: "authenticate", "challenge-url": "/c" });
      await expect(el.start()).rejects.toThrow(/verify-url/);
      expect(el.status).toBe("error");
    });

    it("fails when navigator.credentials is not available", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      stubCredentials(undefined);
      await expect(el.start()).rejects.toThrow(/navigator\.credentials/);
      expect(el.status).toBe("error");
    });
  });

  describe("trigger property", () => {
    it("runs start() when set to true and resets to false on completion", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) });
      globalThis.fetch = fetchMock as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-webauthn:trigger-changed", (e: any) => triggerEvents.push(e.detail));

      el.trigger = true;
      // Flush microtasks until the ceremony finishes.
      await new Promise(r => setTimeout(r, 10));

      expect(triggerEvents[0]).toBe(true);
      expect(triggerEvents.at(-1)).toBe(false);
      expect(el.trigger).toBe(false);
      expect(el.status).toBe("completed");
    });

    it("ignores redundant true→true writes", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValue({ ok: true, json: async () => ({ credentialId: "cred-1" }) }) as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-webauthn:trigger-changed", (e: any) => triggerEvents.push(e.detail));

      el.trigger = true;
      el.trigger = true; // no-op while already true
      await new Promise(r => setTimeout(r, 10));

      // One true, one false — the redundant write must not double-emit.
      expect(triggerEvents.filter(v => v === true)).toHaveLength(1);
    });

    it("swallows trigger-start failures and still resets trigger to false", async () => {
      const el = mkElement({ mode: "authenticate" });
      const triggerEvents: boolean[] = [];
      el.addEventListener("hawc-webauthn:trigger-changed", (e: any) => triggerEvents.push(e.detail));

      el.trigger = true;
      await new Promise(r => setTimeout(r, 10));

      expect(triggerEvents[0]).toBe(true);
      expect(triggerEvents.at(-1)).toBe(false);
      expect(el.trigger).toBe(false);
      expect(el.status).toBe("error");
    });
  });

  describe("abort()", () => {
    it("cancels an in-flight ceremony via AbortSignal", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      // Keep credentials available so the ceremony progresses far enough
      // to call fetch.
      stubCredentials({ get: vi.fn() });

      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn().mockImplementation((_url, init: any) => {
        capturedSignal = init.signal;
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }) as any;

      const p = el.start();
      // Give the fetch a microtask to start before aborting.
      await Promise.resolve();
      el.abort();
      await expect(p).rejects.toThrow();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it("disconnectedCallback triggers abort", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      stubCredentials({ get: vi.fn() });
      let signal: AbortSignal | undefined;
      globalThis.fetch = vi.fn().mockImplementation((_url, init: any) => {
        signal = init.signal;
        return new Promise(() => {}); // never resolves
      }) as any;
      el.start().catch(() => {});
      await Promise.resolve();
      el.remove();
      expect(signal?.aborted).toBe(true);
    });
  });

  describe("re-entry serialization", () => {
    it("aborts the prior start() when a new one begins", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      const firstSignal: { signal?: AbortSignal } = {};
      let callCount = 0;

      globalThis.fetch = vi.fn().mockImplementation((_url, init: any) => {
        callCount++;
        if (callCount === 1) {
          firstSignal.signal = init.signal;
          return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        // Second attempt: succeed.
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ credentialId: "cred-1" }) });
      }) as any;
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      const first = el.start();
      await Promise.resolve();
      const second = el.start(); // must abort `first`
      await expect(first).rejects.toThrow();
      expect(firstSignal.signal?.aborted).toBe(true);
      await expect(second).resolves.toBeUndefined();
      expect(el.status).toBe("completed");
    });
  });

  describe("defaults & lifecycle", () => {
    it("connectedCallback hides the element via display:none", () => {
      const el = mkElement({});
      expect(el.style.display).toBe("none");
    });

    it("does not redispatch status when already in error", async () => {
      const el = mkElement({ mode: "authenticate" });
      const statuses: string[] = [];
      el.addEventListener("hawc-webauthn:status-changed", (e: any) => statuses.push(e.detail));
      await expect(el.start()).rejects.toThrow(/challenge-url/);
      await expect(el.start()).rejects.toThrow(/challenge-url/);
      expect(statuses.filter((s) => s === "error")).toHaveLength(1);
    });
  });

  describe("serialization of optional fields", () => {
    it("omits optional attestation fields when the credential does not provide them", async () => {
      const el = mkElement({
        mode: "register",
        "challenge-url": "/challenge",
        "verify-url": "/verify",
        "user-id": "u-1", "user-name": "a@x", "user-display-name": "Alice",
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            rp: { id: "example.com", name: "Example" },
            user: { id: encode(new TextEncoder().encode("u-1")), name: "a@x", displayName: "Alice" },
            challenge: encode(new Uint8Array([1, 2, 3])),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) });
      globalThis.fetch = fetchMock as any;
      stubCredentials({
        create: vi.fn().mockResolvedValue({
          id: "cred-1",
          rawId: new Uint8Array([1, 2, 3]).buffer,
          type: "public-key",
          response: {
            clientDataJSON: new Uint8Array([4]).buffer,
            attestationObject: new Uint8Array([5]).buffer,
          },
          getClientExtensionResults: () => ({}),
        }),
        get: vi.fn(),
      });
      await el.start();
      const verifyBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(verifyBody.credential.response.transports).toBeUndefined();
      expect(verifyBody.credential.authenticatorAttachment).toBeUndefined();
    });

    it("omits optional assertion fields when the credential does not provide them", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c",
        "verify-url": "/v",
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ credentialId: "cred-1" }) });
      globalThis.fetch = fetchMock as any;
      stubCredentials({
        get: vi.fn().mockResolvedValue({
          id: "cred-1",
          rawId: new Uint8Array([1, 2, 3]).buffer,
          type: "public-key",
          response: {
            clientDataJSON: new Uint8Array([4]).buffer,
            authenticatorData: new Uint8Array([5]).buffer,
            signature: new Uint8Array([6]).buffer,
          },
          getClientExtensionResults: () => ({}),
        }),
        create: vi.fn(),
      });
      await el.start();
      const verifyBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(verifyBody.credential.response.userHandle).toBeUndefined();
      expect(verifyBody.credential.authenticatorAttachment).toBeUndefined();
    });
  });

  describe("user state lifecycle (regression)", () => {
    // Before the fix, Shell only cleared user/credentialId on completion
    // when the verify response carried them, and never cleared user at
    // start(). Two ceremonies in a row could expose a stale user from
    // ceremony A in ceremony B's reactive surface — confusing for any UI
    // bound to `user`. The two tests below pin the corrected lifecycle.

    function mockChallengeAndVerify(verifyBody: any): ReturnType<typeof vi.fn> {
      return vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ challenge: encode(new Uint8Array([1])), rpId: "x", allowCredentials: [] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => verifyBody });
    }

    it("clears user at start() so the prior ceremony's user does not leak", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      // Ceremony 1: server returns a user.
      globalThis.fetch = mockChallengeAndVerify({
        credentialId: "cred-1",
        user: { id: "u-1", name: "alice", displayName: "Alice" },
      }) as any;
      await el.start();
      expect(el.user).toEqual({ id: "u-1", name: "alice", displayName: "Alice" });

      // Ceremony 2 starts: BEFORE any verify response arrives, `user`
      // must already be cleared so observers do not see the prior user
      // attached to the new ceremony's challenging/asserting phases.
      const userEvents: any[] = [];
      el.addEventListener("hawc-webauthn:user-changed", (e: any) => userEvents.push(e.detail));

      let release: () => void;
      const blocked = new Promise<void>((r) => { release = r; });
      globalThis.fetch = vi.fn().mockImplementation(() => blocked.then(() => ({
        ok: true, json: async () => ({ challenge: encode(new Uint8Array([2])), rpId: "x", allowCredentials: [] }),
      }))) as any;

      const p = el.start();
      // Synchronous start() execution ran past _setUser(null) before the
      // first await — observer sees the clear.
      await Promise.resolve();
      expect(userEvents).toContainEqual(null);
      expect(el.user).toBeNull();
      release!();
      await p.catch(() => {});
    });

    it("sets user to null when the verify response omits a user", async () => {
      const el = mkElement({
        mode: "authenticate",
        "challenge-url": "/c", "verify-url": "/v",
      });
      stubCredentials({ get: vi.fn().mockResolvedValue(fakeAssertionCredential()) });

      // First ceremony with a user.
      globalThis.fetch = mockChallengeAndVerify({
        credentialId: "cred-1",
        user: { id: "u-1", name: "n", displayName: "U" },
      }) as any;
      await el.start();
      expect(el.user).not.toBeNull();

      // Second ceremony with NO user (resolveUser hook absent server-side).
      globalThis.fetch = mockChallengeAndVerify({ credentialId: "cred-1" }) as any;
      await el.start();
      // Without the fix this stayed at the previous user; now it must be null.
      expect(el.user).toBeNull();
      expect(el.credentialId).toBe("cred-1");
    });
  });
});
