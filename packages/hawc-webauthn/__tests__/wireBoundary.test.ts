import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebAuthn } from "../src/components/WebAuthn";
import { WebAuthnCore } from "../src/core/WebAuthnCore";
import { InMemoryChallengeStore } from "../src/stores/InMemoryChallengeStore";
import { InMemoryCredentialStore } from "../src/stores/InMemoryCredentialStore";
import { createWebAuthnHandlers } from "../src/server/createWebAuthnHandlers";
import {
  IWebAuthnVerifier, RegistrationResponseJSON,
  VerifiedRegistration, VerifiedAuthentication,
} from "../src/types";

if (!customElements.get("hawc-webauthn-wire")) {
  customElements.define("hawc-webauthn-wire", class extends WebAuthn {});
}

function stubCredentials(mock: any): void {
  Object.defineProperty(navigator, "credentials", {
    value: mock,
    writable: true,
    configurable: true,
  });
}

class CapturingVerifier implements IWebAuthnVerifier {
  capturedReg?: { response: RegistrationResponseJSON };
  async verifyRegistration(p: any): Promise<VerifiedRegistration> {
    this.capturedReg = { response: p.response };
    return { credentialId: "cred-1", publicKey: "pk", counter: 0 };
  }
  async verifyAuthentication(): Promise<VerifiedAuthentication> {
    return { credentialId: "cred-1", newCounter: 1 };
  }
}

/**
 * End-to-end Shell → handlers → Core ceremony driven through fetch.
 *
 * Regression target: the Core/Shell wire serialization for `user.id`. The
 * earlier implementation passed user.id as a raw string from Core to
 * Shell, while Shell decoded it as base64url. For ids outside the
 * base64url alphabet (e.g. an email) this either threw or silently
 * mangled the bytes the authenticator persisted as the credential's user
 * handle. The test below sets a Shell with such an id and proves the
 * full ceremony succeeds — earlier code would fail at the
 * `navigator.credentials.create()` call when the decoded user.id was
 * malformed.
 */
describe("wire boundary: Core ↔ handlers ↔ Shell", () => {
  let core: WebAuthnCore;
  let verifier: CapturingVerifier;

  beforeEach(() => {
    verifier = new CapturingVerifier();
    core = new WebAuthnCore({
      rpId: "example.com",
      rpName: "Example",
      origin: "https://example.com",
      challengeStore: new InMemoryChallengeStore(),
      credentialStore: new InMemoryCredentialStore(),
      verifier,
    });
  });

  it("survives a registration when user-id contains non-base64url characters", async () => {
    const handlers = createWebAuthnHandlers(core, {
      resolveSessionId: () => "session-1",
    });

    // Bridge fetch → handlers. Both endpoints are Request → Response.
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const target = String(url);
      const req = new Request(`https://example.com${target.startsWith("/") ? "" : "/"}${target}`, {
        method: init.method,
        headers: init.headers,
        body: init.body as BodyInit,
      });
      if (target.endsWith("/challenge")) return handlers.challenge(req);
      if (target.endsWith("/verify")) return handlers.verify(req);
      throw new Error(`unexpected fetch ${target}`);
    }) as any;

    // Capture the buffers handed to the authenticator. Must be exactly the
    // bytes of "alice@example.com" — the original bug truncated/mangled
    // them when user.id round-tripped through naïve base64url decode.
    let createdUserId: ArrayBuffer | undefined;
    stubCredentials({
      create: vi.fn().mockImplementation((args: CredentialCreationOptions) => {
        const buf = (args.publicKey!.user.id as Uint8Array);
        createdUserId = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        // Per WebAuthn spec, cred.id === base64url(cred.rawId) — the
        // two are two encodings of the same bytes. The prior fixture
        // had them independent (`id: "cred-1"` + `rawId: [1,2,3]`),
        // which the handler now correctly rejects as malformed. Build
        // rawId from "cred-1" so `id` (base64url of those ASCII bytes)
        // and `rawId` (the same bytes as a buffer) agree.
        const rawIdBytes = new TextEncoder().encode("cred-1");
        return Promise.resolve({
          // encode("cred-1" bytes) → base64url "Y3JlZC0x"
          id: "Y3JlZC0x",
          rawId: rawIdBytes.buffer.slice(rawIdBytes.byteOffset, rawIdBytes.byteOffset + rawIdBytes.byteLength),
          type: "public-key",
          authenticatorAttachment: "platform",
          getClientExtensionResults: () => ({}),
          response: {
            clientDataJSON: new Uint8Array([9]).buffer,
            attestationObject: new Uint8Array([8]).buffer,
            getTransports: () => ["internal"],
          },
        });
      }),
    });

    const el = document.createElement("hawc-webauthn-wire") as WebAuthn;
    el.setAttribute("mode", "register");
    el.setAttribute("challenge-url", "/challenge");
    el.setAttribute("verify-url", "/verify");
    el.setAttribute("user-id", "alice@example.com");
    el.setAttribute("user-name", "alice@example.com");
    el.setAttribute("user-display-name", "Alice");
    document.body.appendChild(el);

    await el.start();

    expect(el.status).toBe("completed");
    expect(createdUserId).toBeDefined();
    expect(new TextDecoder().decode(new Uint8Array(createdUserId!))).toBe("alice@example.com");

    el.remove();
  });
});
