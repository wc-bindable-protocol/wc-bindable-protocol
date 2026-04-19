import { decode, encode } from "../codec/base64url.js";
import {
  IWebAuthnVerifier, RegistrationResponseJSON, AuthenticationResponseJSON,
  VerifiedRegistration, VerifiedAuthentication, CredentialRecord,
} from "../types.js";

/**
 * Reference verifier adapter backed by `@simplewebauthn/server`.
 *
 * `@simplewebauthn/server` is an **optional peer dependency** — identical
 * pattern to hawc-auth0's `@auth0/auth0-spa-js`. Applications that bring
 * their own verifier skip installing it entirely; applications that want
 * a working default install it alongside this package.
 *
 * We dynamic-import the library inside the methods so the bundler does not
 * eagerly resolve it. A deployment that has not installed the peer dep
 * will get a clear "module not found" error the first time it verifies,
 * rather than at import time.
 */
export class SimpleWebAuthnVerifier implements IWebAuthnVerifier {
  async verifyRegistration(params: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
    requireUserVerification: boolean;
  }): Promise<VerifiedRegistration> {
    const mod = await _loadServer();
    const result = await mod.verifyRegistrationResponse({
      response: params.response as any,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: params.expectedOrigin,
      expectedRPID: params.expectedRPID,
      requireUserVerification: params.requireUserVerification,
    });
    if (!result.verified || !result.registrationInfo) {
      throw new Error("[@wc-bindable/hawc-webauthn] registration verification failed.");
    }
    // @simplewebauthn/server v11 nests the credential fields under
    // `registrationInfo.credential`. Earlier versions exposed them directly;
    // fall back to the legacy shape so minor-version drift does not crash.
    const info = result.registrationInfo as any;
    const cred = info.credential ?? info;
    const rawId: Uint8Array = cred.id ?? cred.credentialID;
    const publicKey: Uint8Array = cred.publicKey ?? cred.credentialPublicKey;
    const counter: number = cred.counter ?? 0;
    return {
      credentialId: typeof rawId === "string" ? rawId : encode(rawId),
      publicKey: encode(publicKey),
      counter,
      transports: params.response.response.transports,
    };
  }

  async verifyAuthentication(params: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
    credential: CredentialRecord;
    requireUserVerification: boolean;
  }): Promise<VerifiedAuthentication> {
    const mod = await _loadServer();
    const result = await mod.verifyAuthenticationResponse({
      response: params.response as any,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: params.expectedOrigin,
      expectedRPID: params.expectedRPID,
      requireUserVerification: params.requireUserVerification,
      // v11 signature: `credential: { id, publicKey, counter, transports }`.
      // v10 and below: `authenticator: { credentialID, credentialPublicKey, counter, transports }`.
      // Supplying both keys is harmless — the library reads the one it knows —
      // and keeps this adapter working across the minor-version boundary
      // without a hard `peerDependencies` pin.
      credential: {
        id: params.credential.credentialId,
        publicKey: decode(params.credential.publicKey),
        counter: params.credential.counter,
        transports: params.credential.transports as any,
      },
      authenticator: {
        credentialID: decode(params.credential.credentialId),
        credentialPublicKey: decode(params.credential.publicKey),
        counter: params.credential.counter,
        transports: params.credential.transports as any,
      },
    } as any);
    if (!result.verified) {
      throw new Error("[@wc-bindable/hawc-webauthn] authentication verification failed.");
    }
    return {
      credentialId: params.credential.credentialId,
      newCounter: result.authenticationInfo?.newCounter ?? params.credential.counter,
    };
  }
}

/** The package name we expect to be present when this adapter is used.
 *  Centralized so the classifier and any future diagnostics stay in
 *  lockstep with the actual peer-dep import. */
const PEER_PACKAGE = "@simplewebauthn/server";

/**
 * @internal — exported for unit tests only.
 *
 * Classifies a dynamic-import failure into either "the peer dep itself
 * is missing" (the install-hint case) or "the load failed for some
 * other reason" (cause-preserving wrap). The previous implementation
 * collapsed both — and worse, treated *any* "Cannot find module/package"
 * message as the peer-dep case. That over-matched: when
 * `@simplewebauthn/server` is installed but ITS own dependency is
 * missing (e.g. `cbor-x` not bundled), Node's error still says
 * "Cannot find module 'cbor-x'", and the prior classifier mis-pointed
 * the user at re-installing `@simplewebauthn/server`.
 *
 * Fix: parse the missing-module name out of the message and require it
 * to equal `PEER_PACKAGE`. Anything else falls through to the
 * cause-preserving branch with the original error attached.
 */
export function _classifyImportError(e: any): Error {
  const msg = typeof e?.message === "string" ? e.message : "";
  // Examples from real engines:
  //   Node 18 ESM: "Cannot find package '@simplewebauthn/server' imported from /app/x.js"
  //   Node 18 CJS: "Cannot find module '@simplewebauthn/server' from '/app'"
  //   Vite/esbuild: "Failed to resolve module specifier '@simplewebauthn/server'"
  //   Webpack:     "Module not found: Error: Can't resolve '@simplewebauthn/server' in '/app'"
  // The common shape is a quoted package specifier following one of the
  // diagnostic phrases. Capture it and require an exact match against
  // PEER_PACKAGE — anything else is a transitive failure.
  const missingPkg = _extractMissingPackage(msg);
  if (missingPkg === PEER_PACKAGE) {
    return new Error(
      `[@wc-bindable/hawc-webauthn] ${PEER_PACKAGE} is not installed. ` +
      "Install it as a peer dependency or provide a custom IWebAuthnVerifier."
    );
  }
  // `cause` is assigned post-construction because the two-arg
  // `new Error(msg, { cause })` form requires lib.es2022 (we target
  // ES2020 for browser breadth), but the field itself is honored at
  // runtime by every modern engine.
  const detail = missingPkg && missingPkg !== PEER_PACKAGE
    // When we *can* identify a transitive failure, point operators at
    // the real culprit rather than letting them chase the wrong package.
    ? `${PEER_PACKAGE} loaded a dependency that is missing (${missingPkg}): ${msg}`
    : msg || String(e);
  const wrapped = new Error(
    `[@wc-bindable/hawc-webauthn] failed to load ${PEER_PACKAGE}: ${detail}`,
  );
  (wrapped as any).cause = e;
  return wrapped;
}

/**
 * Extract the missing-module specifier from a runtime/bundler error
 * message. Returns `null` when no specifier can be parsed — that
 * includes both "this is not a missing-module error at all" and
 * "the message format is unrecognised", which we conservatively treat
 * the same way (don't claim missing-peer-dep without proof).
 */
function _extractMissingPackage(msg: string): string | null {
  // Single source of truth for "this looks like a missing-module
  // diagnostic". Each pattern captures the package specifier in group 1.
  const patterns = [
    /Cannot find (?:module|package) ['"]([^'"]+)['"]/i,
    /Failed to resolve (?:module specifier|import) ['"]([^'"]+)['"]/i,
    /Can(?:'|no)?t resolve ['"]([^'"]+)['"]/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) return m[1];
  }
  return null;
}

async function _loadServer(): Promise<any> {
  try {
    // @ts-ignore — optional peer dep; may not be installed
    return await import("@simplewebauthn/server");
  } catch (e: any) {
    throw _classifyImportError(e);
  }
}
