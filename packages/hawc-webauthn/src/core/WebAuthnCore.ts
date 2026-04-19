import { raiseError } from "../raiseError.js";
import { encode, randomChallenge } from "../codec/base64url.js";
import {
  IWcBindable, WebAuthnCoreOptions, WebAuthnStatus, WebAuthnUser,
  WebAuthnMode, PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
  AuthenticationResponseJSON, CredentialRecord, UserVerificationRequirement,
  AttestationConveyancePreference, IChallengeStore, ICredentialStore,
  IWebAuthnVerifier,
} from "../types.js";

/** Default challenge byte length. RFC recommends >=16; 32 is the spec floor. */
const DEFAULT_CHALLENGE_BYTES = 32;
/** Default option-blob timeout hint. 60 s matches common authenticator UX. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Default challenge TTL. Long enough for the user to engage the authenticator,
 *  short enough that stolen challenges do not accumulate. */
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000;

/** COSE algorithm identifiers we advertise during registration.
 *  -7  = ES256 (ECDSA w/ SHA-256) — every platform authenticator supports this.
 *  -257 = RS256 (RSA PKCS#1 v1.5 w/ SHA-256) — legacy U2F tokens, Windows Hello. */
const DEFAULT_PUB_KEY_PARAMS: Array<{ type: "public-key"; alg: number }> = [
  { type: "public-key", alg: -7 },
  { type: "public-key", alg: -257 },
];

/**
 * Headless WebAuthn core.
 *
 * Lives server-side. Holds the relying-party identity, a challenge store
 * (per-session nonce), a credential store (public keys + sign counters),
 * and a pluggable verifier that does the CBOR/COSE + signature check.
 *
 * Credential material never crosses this Core directly — the browser
 * invokes `navigator.credentials.create()` / `.get()` and the Shell
 * forwards the resulting JSON to `verifyRegistration` / `verifyAuthentication`.
 * This is the WebAuthn counterpart to S3Core's "bytes never cross here":
 * the authenticator signature is anchored to the browser, and the Core
 * only decides whether to trust what the Shell produced.
 */
export class WebAuthnCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "status", event: "hawc-webauthn:status-changed" },
      { name: "credentialId", event: "hawc-webauthn:credential-id-changed" },
      { name: "user", event: "hawc-webauthn:user-changed" },
      { name: "error", event: "hawc-webauthn:error" },
    ],
    commands: [
      { name: "createRegistrationChallenge", async: true },
      { name: "verifyRegistration", async: true },
      { name: "createAuthenticationChallenge", async: true },
      { name: "verifyAuthentication", async: true },
      { name: "reset" },
    ],
  };

  private _target: EventTarget;
  private _rpId: string;
  private _rpName: string;
  private _origin: string | string[];
  private _challengeStore: IChallengeStore;
  private _credentialStore: ICredentialStore;
  private _verifier: IWebAuthnVerifier;
  private _userVerification: UserVerificationRequirement;
  private _attestation: AttestationConveyancePreference;
  private _timeout: number;
  private _challengeBytes: number;
  private _challengeTtlMs: number;

  private _status: WebAuthnStatus = "idle";
  private _credentialId: string = "";
  private _user: WebAuthnUser | null = null;
  private _error: Error | null = null;

  constructor(options: WebAuthnCoreOptions, target?: EventTarget) {
    super();
    if (!options) raiseError("options is required.");
    if (!options.rpId) raiseError("options.rpId is required.");
    if (!options.rpName) raiseError("options.rpName is required.");
    if (!options.origin) raiseError("options.origin is required.");
    if (!options.challengeStore) raiseError("options.challengeStore is required.");
    if (!options.credentialStore) raiseError("options.credentialStore is required.");
    if (!options.verifier) raiseError("options.verifier is required.");
    this._target = target ?? this;
    this._rpId = options.rpId;
    this._rpName = options.rpName;
    this._origin = options.origin;
    this._challengeStore = options.challengeStore;
    this._credentialStore = options.credentialStore;
    this._verifier = options.verifier;
    this._userVerification = options.userVerification ?? "preferred";
    this._attestation = options.attestation ?? "none";
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this._challengeBytes = options.challengeBytes ?? DEFAULT_CHALLENGE_BYTES;
    this._challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  }

  // --- Output state ---

  get status(): WebAuthnStatus { return this._status; }
  get credentialId(): string { return this._credentialId; }
  get user(): WebAuthnUser | null {
    return this._user ? { ...this._user } : null;
  }
  get error(): Error | null { return this._error; }

  // --- Setters / dispatch ---

  private _setStatus(status: WebAuthnStatus): void {
    if (this._status === status) return;
    this._status = status;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:status-changed", {
      detail: status, bubbles: true,
    }));
  }

  private _setCredentialId(id: string): void {
    this._credentialId = id;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:credential-id-changed", {
      detail: id, bubbles: true,
    }));
  }

  private _setUser(user: WebAuthnUser | null): void {
    this._user = user;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:user-changed", {
      detail: user ? { ...user } : null, bubbles: true,
    }));
  }

  private _setError(err: Error | null): void {
    // Same JSON-serializable envelope S3Core uses — downstream binders
    // (including RemoteCoreProxy) can serialize the error onto the wire
    // without losing the message.
    if (err && typeof (err as any).toJSON !== "function") {
      (err as any).toJSON = () => ({
        name: err.name, message: err.message,
        ...(err.stack ? { stack: err.stack } : {}),
      });
    }
    this._error = err;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:error", {
      detail: err, bubbles: true,
    }));
  }

  /**
   * Reset Shell-visible state to idle. Used between ceremonies so a success
   * from the previous attempt does not bleed into the current one's status.
   * Does NOT clear the challenge store — that is sessionId-scoped and
   * managed by put/take directly.
   */
  reset(): void {
    this._setError(null);
    this._setCredentialId("");
    this._setUser(null);
    this._setStatus("idle");
  }

  // --- Commands ---

  /**
   * Issue a challenge + option blob for `navigator.credentials.create()`.
   *
   * Writes the per-session challenge slot BEFORE returning the blob so a
   * racing verify() from a duplicated session cannot land between issue and
   * store. `sessionId` is any stable per-browser-session identifier the
   * server supplies (cookie-derived is the common choice) — the Core does
   * not care about its shape, only that verify() presents the same id.
   */
  async createRegistrationChallenge(
    sessionId: string,
    user: WebAuthnUser,
    existingCredentialIds: string[] = [],
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (!sessionId) raiseError("sessionId is required.");
    if (!user?.id || !user.name || !user.displayName) {
      raiseError("user.id, user.name, and user.displayName are required.");
    }
    this._setError(null);
    this._setStatus("challenging");
    try {
      const challenge = randomChallenge(this._challengeBytes);
      await this._challengeStore.put(sessionId, {
        challenge,
        mode: "register",
        userId: user.id,
        createdAt: Date.now(),
      });
      this._setUser(user);
      return {
        rp: { id: this._rpId, name: this._rpName },
        // user.id is a BufferSource at the WebAuthn API level; the
        // PublicKeyCredentialCreationOptionsJSON serialization encodes it
        // as base64url. The Shell decodes it back into an ArrayBuffer
        // before passing it to navigator.credentials.create(). Sending
        // the raw string here would either fail decoding (e.g. an email
        // address contains characters outside the base64url alphabet) or
        // — worse — silently round-trip into unrelated bytes the
        // authenticator then persists as the credential's user handle.
        user: {
          id: encode(new TextEncoder().encode(user.id)),
          name: user.name,
          displayName: user.displayName,
        },
        challenge,
        pubKeyCredParams: DEFAULT_PUB_KEY_PARAMS,
        timeout: this._timeout,
        excludeCredentials: existingCredentialIds.map((id) => ({
          id, type: "public-key",
        })),
        authenticatorSelection: {
          userVerification: this._userVerification,
          residentKey: "preferred",
        },
        attestation: this._attestation,
      };
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }
  }

  /**
   * Verify an `attestation` returned by `navigator.credentials.create()` and
   * persist the new credential on success.
   *
   * The per-session challenge is consumed (take) BEFORE verification — so a
   * failed verification cannot be retried with the same challenge. Any retry
   * must go through a fresh `createRegistrationChallenge`.
   */
  async verifyRegistration(
    sessionId: string,
    response: RegistrationResponseJSON,
  ): Promise<CredentialRecord> {
    if (!sessionId) raiseError("sessionId is required.");
    if (!response) raiseError("response is required.");
    this._setError(null);
    this._setStatus("verifying");

    const slot = await this._challengeStore.take(sessionId);
    if (!slot) {
      return this._failVerify("no active challenge for this session.");
    }
    if (slot.mode !== "register") {
      return this._failVerify(`challenge mode mismatch: expected "register", got "${slot.mode}".`);
    }
    if (!slot.userId) {
      return this._failVerify("challenge is missing userId — registration challenges must bind a user.");
    }
    if (Date.now() - slot.createdAt > this._challengeTtlMs) {
      return this._failVerify("challenge expired.");
    }

    let verified;
    try {
      verified = await this._verifier.verifyRegistration({
        response,
        expectedChallenge: slot.challenge,
        expectedOrigin: this._origin,
        expectedRPID: this._rpId,
        requireUserVerification: this._userVerification === "required",
      });
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }

    // Defense in depth against duplicate-credential persistence. The
    // handler's `excludeCredentials` list is a client-side hint — a
    // misbehaving / malicious browser can still hand us a credentialId
    // we already know about. Rejecting here prevents:
    //   (a) silent overwrite of one user's credential by a second user
    //       (the InMemory store keys by credentialId; a re-register
    //       under a different userId would re-home the record),
    //   (b) duplicate registrations under the same user that masquerade
    //       as fresh enrollments and inflate audit logs.
    // We surface this as a Verify failure (not a Core invariant break)
    // so the handler turns it into 400 like every other verify rejection.
    const existing = await this._credentialStore.getById(verified.credentialId);
    if (existing) {
      return this._failVerify(
        existing.userId === slot.userId
          ? "credential is already registered for this user."
          : "credential is already registered to a different user.",
      );
    }
    const record: CredentialRecord = {
      credentialId: verified.credentialId,
      userId: slot.userId,
      publicKey: verified.publicKey,
      counter: verified.counter,
      // Verifier may return transports (when it inspects the attestation) or
      // not (when it only verifies the signature). Fall back to the raw
      // response's transports — those come straight from the authenticator
      // via `getTransports()` and are the authoritative source anyway.
      transports: verified.transports ?? response.response.transports,
      createdAt: Date.now(),
    };
    try {
      await this._credentialStore.put(record);
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }
    this._setCredentialId(verified.credentialId);
    this._setStatus("completed");
    return record;
  }

  /**
   * Issue a challenge for `navigator.credentials.get()`.
   *
   * When `userId` is supplied, the server-known credentials for that user
   * are listed into `allowCredentials` so the browser picks the right one.
   * When omitted, `allowCredentials` is empty and the browser presents
   * every platform/roaming passkey it has — the usernameless ("discoverable
   * credential") flow.
   */
  async createAuthenticationChallenge(
    sessionId: string,
    userId?: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!sessionId) raiseError("sessionId is required.");
    this._setError(null);
    // Clear the reactive `user` slot from any prior ceremony. The Core
    // exposes `user` through wcBindable, so a consumer binding the Core
    // directly would otherwise see the previous registration's user
    // hanging on through the entire authenticate flow — a misleading
    // reactive value, especially when the Shell-bound consumer no longer
    // sees that staleness because the Shell does its own clearing.
    // The Core does not (and cannot) repopulate `user` after
    // verifyAuthentication: it only knows the userId on the credential
    // record, not the name/displayName, so leaving it null is the
    // honest representation. Application-level identity surfacing is
    // the handler's `resolveUser` hook, not the Core.
    this._setUser(null);
    this._setStatus("challenging");
    try {
      const challenge = randomChallenge(this._challengeBytes);
      await this._challengeStore.put(sessionId, {
        challenge,
        mode: "authenticate",
        userId,
        createdAt: Date.now(),
      });
      let allowCredentials: Array<{ id: string; type: "public-key"; transports?: string[] }> = [];
      if (userId) {
        const records = await this._credentialStore.listByUser(userId);
        allowCredentials = records.map((r) => ({
          id: r.credentialId, type: "public-key",
          ...(r.transports ? { transports: r.transports } : {}),
        }));
      }
      return {
        challenge,
        timeout: this._timeout,
        rpId: this._rpId,
        allowCredentials,
        userVerification: this._userVerification,
      };
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }
  }

  /**
   * Verify an `assertion` returned by `navigator.credentials.get()` and
   * bump the credential's sign counter on success. Mirrors
   * `verifyRegistration`'s consume-before-verify semantics.
   */
  async verifyAuthentication(
    sessionId: string,
    response: AuthenticationResponseJSON,
  ): Promise<CredentialRecord> {
    if (!sessionId) raiseError("sessionId is required.");
    if (!response) raiseError("response is required.");
    this._setError(null);
    this._setStatus("verifying");

    const slot = await this._challengeStore.take(sessionId);
    if (!slot) {
      return this._failVerify("no active challenge for this session.");
    }
    if (slot.mode !== "authenticate") {
      return this._failVerify(`challenge mode mismatch: expected "authenticate", got "${slot.mode}".`);
    }
    if (Date.now() - slot.createdAt > this._challengeTtlMs) {
      return this._failVerify("challenge expired.");
    }

    const record = await this._credentialStore.getById(response.id);
    if (!record) {
      return this._failVerify("credential not registered.");
    }
    // If the challenge carried a userId (targeted authentication), the
    // assertion's credential must belong to that user. Without this guard,
    // a compromised session could take a challenge issued for user A and
    // satisfy it with user B's passkey — allowCredentials filtering is
    // a client-side hint, not a server enforcement.
    if (slot.userId && record.userId !== slot.userId) {
      return this._failVerify("credential does not belong to the targeted user.");
    }

    let verified;
    try {
      verified = await this._verifier.verifyAuthentication({
        response,
        expectedChallenge: slot.challenge,
        expectedOrigin: this._origin,
        expectedRPID: this._rpId,
        credential: record,
        requireUserVerification: this._userVerification === "required",
      });
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }
    // WebAuthn §6.1.1: a signCount that did not increase across assertions
    // signals a cloned authenticator. Treat it as a hard failure — a weaker
    // "warn and continue" policy hides the attack.
    if (verified.newCounter <= record.counter && record.counter !== 0) {
      return this._failVerify("authenticator sign counter did not advance — possible cloned credential.");
    }
    try {
      await this._credentialStore.updateCounter(record.credentialId, verified.newCounter);
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }
    this._setCredentialId(record.credentialId);
    this._setStatus("completed");
    return { ...record, counter: verified.newCounter };
  }

  private _failVerify(message: string): never {
    const err = new Error(`[@wc-bindable/hawc-webauthn] ${message}`);
    this._failStatus(err);
    throw err;
  }

  private _failStatus(err: Error): void {
    this._setError(err);
    this._setStatus("error");
  }
}
