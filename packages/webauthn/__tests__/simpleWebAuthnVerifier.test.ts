import { describe, it, expect, vi } from "vitest";
import { _classifyImportError, SimpleWebAuthnVerifier } from "../src/server/SimpleWebAuthnVerifier";

describe("_classifyImportError (regression)", () => {
  // Why test this in isolation: the dynamic-import call site itself is
  // hard to exercise both ways (missing vs present) without monkey-
  // patching the runtime's import. Extracting the classifier as a pure
  // function lets us pin the discrimination contract directly with
  // synthesized errors. The earlier collapsed-into-one-message behavior
  // is the regression we are guarding against.

  it("ERR_MODULE_NOT_FOUND for the peer dep itself maps to the install hint", () => {
    const err: any = new Error("Cannot find package '@simplewebauthn/server' imported from /app/x.js");
    err.code = "ERR_MODULE_NOT_FOUND";
    expect(_classifyImportError(err).message).toMatch(/is not installed/);
  });

  it("legacy MODULE_NOT_FOUND for the peer dep itself maps to the install hint", () => {
    const err: any = new Error("Cannot find module '@simplewebauthn/server' from '/app'");
    err.code = "MODULE_NOT_FOUND";
    expect(_classifyImportError(err).message).toMatch(/is not installed/);
  });

  it("plain 'Cannot find package' for the peer dep maps to the install hint", () => {
    const err = new Error("Cannot find package '@simplewebauthn/server'");
    expect(_classifyImportError(err).message).toMatch(/is not installed/);
  });

  it("Vite/esbuild 'Failed to resolve module specifier' maps to the install hint", () => {
    const err = new Error("Failed to resolve module specifier '@simplewebauthn/server'");
    expect(_classifyImportError(err).message).toMatch(/is not installed/);
  });

  it("Webpack 'Can't resolve' maps to the install hint", () => {
    const err = new Error("Module not found: Error: Can't resolve '@simplewebauthn/server' in '/app'");
    expect(_classifyImportError(err).message).toMatch(/is not installed/);
  });

  it("transitive-missing dependency is NOT misreported as the peer dep being absent (regression)", () => {
    // Exact case the previous classifier got wrong: the peer dep IS
    // installed, but a module it imports internally is missing. The old
    // regex would match the "Cannot find module" prefix and tell users
    // to install @simplewebauthn/server — chasing the wrong package.
    const err: any = new Error("Cannot find module 'cbor-x' from '/app/node_modules/@simplewebauthn/server/dist/foo.js'");
    err.code = "ERR_MODULE_NOT_FOUND";
    const wrapped = _classifyImportError(err);
    expect(wrapped.message).not.toMatch(/is not installed/);
    expect(wrapped.message).toMatch(/failed to load/);
    // The diagnostic should name the actual missing dependency so the
    // operator can install it directly instead of chasing red herrings.
    expect(wrapped.message).toMatch(/cbor-x/);
    expect((wrapped as any).cause).toBe(err);
  });

  it("transitive-missing via Webpack 'Can't resolve' is also preserved (regression)", () => {
    const err = new Error("Module not found: Error: Can't resolve 'tslib' in '/app/node_modules/@simplewebauthn/server'");
    const wrapped = _classifyImportError(err);
    expect(wrapped.message).not.toMatch(/is not installed/);
    expect(wrapped.message).toMatch(/tslib/);
  });

  it("a runtime error from inside the library is NOT mis-reported as missing", () => {
    const inner = new Error("boom — internal failure");
    const wrapped = _classifyImportError(inner);
    expect(wrapped.message).toMatch(/failed to load/);
    expect(wrapped.message).not.toMatch(/is not installed/);
    expect((wrapped as any).cause).toBe(inner);
  });

  it("an opaque non-Error value is wrapped without lying about installation", () => {
    const wrapped = _classifyImportError("opaque");
    expect(wrapped.message).toMatch(/failed to load/);
    expect(wrapped.message).not.toMatch(/is not installed/);
    expect((wrapped as any).cause).toBe("opaque");
  });

  it("an unrelated SyntaxError (e.g. broken ESM export) is preserved as cause", () => {
    const inner = new SyntaxError("Unexpected token in module");
    const wrapped = _classifyImportError(inner);
    expect(wrapped.message).toMatch(/failed to load/);
    expect((wrapped as any).cause).toBe(inner);
  });
});

describe("SimpleWebAuthnVerifier", () => {
  it("delegates to the @simplewebauthn/server library when import succeeds", async () => {
    // We register the mock at module-resolve time via vi.doMock so the
    // verifier's dynamic import resolves to our fake. This exercises the
    // happy path without requiring the real peer dep to be installed.
    vi.resetModules();
    const verifyRegistrationResponse = vi.fn().mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
      },
    });
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse,
      verifyAuthenticationResponse: vi.fn(),
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    const result = await v.verifyRegistration({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", attestationObject: "a" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: true,
    });
    expect(result.credentialId).toBe("cred-1");
    expect(result.counter).toBe(0);
    expect(verifyRegistrationResponse).toHaveBeenCalledOnce();
    vi.doUnmock("@simplewebauthn/server");
  });

  it("supports the legacy registrationInfo field layout", async () => {
    vi.resetModules();
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse: vi.fn().mockResolvedValue({
        verified: true,
        registrationInfo: {
          credentialID: new Uint8Array([1, 2]),
          credentialPublicKey: new Uint8Array([3, 4]),
          counter: 9,
        },
      }),
      verifyAuthenticationResponse: vi.fn(),
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    const result = await v.verifyRegistration({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", attestationObject: "a", transports: ["internal"] },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: false,
    });
    expect(result.counter).toBe(9);
    expect(result.transports).toEqual(["internal"]);
    vi.doUnmock("@simplewebauthn/server");
  });

  it("defaults the registration counter to zero when omitted by the library", async () => {
    vi.resetModules();
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse: vi.fn().mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: new Uint8Array([1, 2]),
            publicKey: new Uint8Array([3, 4]),
          },
        },
      }),
      verifyAuthenticationResponse: vi.fn(),
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    const result = await v.verifyRegistration({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", attestationObject: "a" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: false,
    });
    expect(result.counter).toBe(0);
    vi.doUnmock("@simplewebauthn/server");
  });

  it("throws when registration verification is unsuccessful", async () => {
    vi.resetModules();
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse: vi.fn().mockResolvedValue({ verified: false }),
      verifyAuthenticationResponse: vi.fn(),
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    await expect(v.verifyRegistration({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", attestationObject: "a" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: true,
    })).rejects.toThrow(/registration verification failed/);
    vi.doUnmock("@simplewebauthn/server");
  });

  it("delegates authentication verification to the server library", async () => {
    vi.resetModules();
    const verifyAuthenticationResponse = vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 11 },
    });
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse: vi.fn(),
      verifyAuthenticationResponse,
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    const result = await v.verifyAuthentication({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      credential: {
        credentialId: "cred-1",
        userId: "u-1",
        publicKey: "AQID",
        counter: 10,
        transports: ["internal"],
        createdAt: 1,
      },
      requireUserVerification: true,
    });
    expect(result).toEqual({ credentialId: "cred-1", newCounter: 11 });
    expect(verifyAuthenticationResponse).toHaveBeenCalledOnce();
    vi.doUnmock("@simplewebauthn/server");
  });

  it("falls back to the existing counter when authenticationInfo.newCounter is absent", async () => {
    vi.resetModules();
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse: vi.fn(),
      verifyAuthenticationResponse: vi.fn().mockResolvedValue({ verified: true, authenticationInfo: {} }),
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    const result = await v.verifyAuthentication({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      credential: {
        credentialId: "cred-1",
        userId: "u-1",
        publicKey: "AQID",
        counter: 10,
        createdAt: 1,
      },
      requireUserVerification: false,
    });
    expect(result.newCounter).toBe(10);
    vi.doUnmock("@simplewebauthn/server");
  });

  it("throws when authentication verification is unsuccessful", async () => {
    vi.resetModules();
    vi.doMock("@simplewebauthn/server", () => ({
      verifyRegistrationResponse: vi.fn(),
      verifyAuthenticationResponse: vi.fn().mockResolvedValue({ verified: false }),
    }));
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    await expect(v.verifyAuthentication({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      credential: {
        credentialId: "cred-1",
        userId: "u-1",
        publicKey: "AQID",
        counter: 10,
        createdAt: 1,
      },
      requireUserVerification: false,
    })).rejects.toThrow(/authentication verification failed/);
    vi.doUnmock("@simplewebauthn/server");
  });

  it("rethrows classified import errors from the lazy loader", async () => {
    vi.doUnmock("@simplewebauthn/server");
    vi.resetModules();
    const { SimpleWebAuthnVerifier: Mod } = await import("../src/server/SimpleWebAuthnVerifier");
    const v = new Mod();
    await expect(v.verifyRegistration({
      response: {
        id: "cred-1", rawId: "cred-1", type: "public-key",
        response: { clientDataJSON: "c", attestationObject: "a" },
      },
      expectedChallenge: "c",
      expectedOrigin: "https://example.com",
      expectedRPID: "example.com",
      requireUserVerification: true,
    })).rejects.toThrow(/failed to load|is not installed/);
  });

  it("constructs without throwing — load happens lazily on first verify", () => {
    expect(() => new SimpleWebAuthnVerifier()).not.toThrow();
  });
});
