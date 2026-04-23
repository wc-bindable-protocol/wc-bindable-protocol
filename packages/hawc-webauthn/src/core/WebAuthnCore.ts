import { raiseError } from "../raiseError.js";
import { encode, randomChallenge } from "../codec/base64url.js";
import {
  IWcBindable, WebAuthnCoreOptions, WebAuthnStatus, WebAuthnUser,
  PublicKeyCredentialCreationOptionsJSON,
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
 * base64url alphabet (no padding). Mirror of the handler's check, used to
 * guard `response.id` at the Core boundary. When the handler is in front
 * of the Core this is a belt-and-suspenders duplicate of
 * `_validateCredentialShape`; when the Core is invoked directly (e.g.
 * tests, in-process bindings, a custom server that bypasses the shipped
 * handler), it prevents a caller from using a raw lookup on an
 * attacker-controlled string to probe the credential store.
 */
const _BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

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
 *
 * ## Reactive state is single-session
 *
 * **The reactive fields `status`, `credentialId`, `user`, and `error` are
 * designed for single-consumer observation and are NOT safe to share
 * across concurrent sessions.** Because every challenge / verify call
 * writes to the same underlying slots (and dispatches a corresponding
 * CustomEvent on `_target`), two ceremonies interleaving on the same Core
 * instance will see each other's transitions bleed into their observer
 * — e.g. session A's `user` may briefly reflect session B's in-flight
 * registration before A's own verify completes.
 *
 * The shipped `createWebAuthnHandlers` adapter deliberately does NOT
 * read these reactive fields; it takes the value returned by the
 * command and ignores `core.user` / `core.credentialId` entirely. That
 * is the safe usage for a horizontally-scaled deployment: a single
 * Core instance serves every request, but no piece of code downstream
 * observes its reactive surface.
 *
 * When you DO want a reactive Core (e.g. binding the wcBindable
 * properties to a local UI, a remote-proxy debugging surface, an
 * in-process single-user tool) you must give each observer its own
 * Core instance OR funnel all ceremonies for that observer's session
 * through a serialized queue. The simplest production pattern is:
 * stateless handlers for shared deployments, per-user/per-tab Core
 * instances only for single-session tools.
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
    // Shape check the origin more tightly. A bare truthy check lets
    // `origin: []` through — which passes schema but causes every verify
    // to silently fail at the verifier's origin-match step ("no origin
    // matched"). Array of empty strings has the same problem. Reject
    // loudly at construction so the failure mode is a thrown Error the
    // operator sees immediately rather than an opaque verify rejection
    // after a real user tries to register.
    {
      const origins = Array.isArray(options.origin) ? options.origin : [options.origin];
      if (origins.length === 0 || origins.some((o) => typeof o !== "string" || o.length === 0)) {
        raiseError("options.origin must be a non-empty string or a non-empty array of strings.");
      }
    }
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
    // Dedupe identical writes so binders do not see spurious
    // credential-id-changed events during the "" → "" reset path or
    // when a re-verify hands back the same credentialId.
    if (this._credentialId === id) return;
    this._credentialId = id;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:credential-id-changed", {
      detail: id, bubbles: true,
    }));
  }

  private _setUser(user: WebAuthnUser | null): void {
    // Reference-compare dedupe — the Core stores the exact WebAuthnUser
    // object the caller passed in, so an identity match is a reliable
    // no-op signal. The null → null path matters: `reset()` calls
    // `_setUser(null)` at idle, and `createAuthenticationChallenge()`
    // calls it again to clear residue; the second call should not emit.
    // Structural comparison would be a behavior change — a caller that
    // deliberately hands in a fresh-but-equal user object still expects
    // the event to fire — so the dedupe is intentionally conservative.
    if (this._user === user) return;
    this._user = user;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:user-changed", {
      detail: user ? { ...user } : null, bubbles: true,
    }));
  }

  private _setError(err: Error | null): void {
    // Same JSON-serializable envelope S3Core uses — downstream binders
    // (including RemoteCoreProxy) can serialize the error onto the wire
    // without losing the message.
    //
    // Policy: do NOT mutate the incoming Error in place. The previous
    // shape attached a `toJSON` property directly onto `err`, which
    // polluted errors the consumer held elsewhere (e.g. the caller's
    // own `reject(err)` chain). Instead, wrap the error in a local
    // subclass that carries `toJSON` natively while proxying `name` /
    // `message` / `stack` from the original. External references to the
    // original Error remain unchanged.
    this._error = err ? _wrapSerializable(err) : null;
    this._target.dispatchEvent(new CustomEvent("hawc-webauthn:error", {
      detail: this._error, bubbles: true,
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
    // Guard user.id byte length. WebAuthn §5.4.3 caps `user.id` at 64
    // bytes AFTER UTF-8 encoding — authenticators MAY reject longer
    // values, and the browser's `navigator.credentials.create()` throws
    // a hard-to-diagnose TypeError when given an oversized BufferSource.
    // Checking here (before challenge-slot write) surfaces the failure
    // as a clean raiseError the handler turns into 400, instead of a
    // cryptic browser-side TypeError that burns the challenge slot.
    {
      const encoded = new TextEncoder().encode(user.id);
      if (encoded.byteLength > 64) {
        raiseError("user.id must be at most 64 bytes when UTF-8 encoded (WebAuthn §5.4.3).");
      }
    }
    // Validate caller-supplied credential ids BEFORE any state mutation
    // — otherwise a single garbage entry burns the error-reset +
    // status-change events and leaves the consumer in `challenging`
    // with a rejected promise. Each id feeds directly into the option
    // blob's `excludeCredentials[].id` that the browser decodes as
    // base64url; a non-base64url value would silently decode into
    // unrelated bytes (the browser tolerates padding-free base64 with
    // loose alphabets on some engines) and the authenticator's
    // exclude-list check would either miss the match or throw.
    for (const id of existingCredentialIds) {
      if (typeof id !== "string" || !_BASE64URL_RE.test(id)) {
        raiseError("existingCredentialIds entries must be non-empty base64url strings.");
      }
    }
    this._setError(null);
    // Clear residual credentialId from any prior completed ceremony.
    // The reactive `credentialId` slot otherwise shows the previous
    // registration's id through the challenging/verifying phases until
    // `verifyRegistration` overwrites it, which is a misleading
    // observer surface ("we're still on cred-old while a new
    // registration is in flight"). Dedupe in `_setCredentialId` makes
    // the "" → "" case a no-op so nothing fires when there is nothing
    // to clear.
    this._setCredentialId("");
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
    } catch (e: unknown) {
      // Normalize to Error so `_failStatus` / the error surface sees a
      // well-typed value even when a third-party store / verifier throws
      // a non-Error (string, plain object, etc.). Preserves identity
      // for real Errors.
      const err = e instanceof Error ? e : new Error(String(e));
      this._failStatus(err);
      throw err;
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
    // Guard at the Core boundary: `response.id` flows into the
    // credential-store duplicate check post-verify. When the shipped
    // handler is in front this is a redundant check (already performed
    // by `_validateCredentialShape`), but the Core is a public surface
    // — direct callers must not be able to feed garbage strings into
    // the store. Reject non-base64url up-front through the same
    // `_failVerify` path that surfaces other protocol-level errors.
    if (typeof response.id !== "string" || !_BASE64URL_RE.test(response.id)) {
      this._failVerify("credential.id must be a non-empty base64url string.");
    }
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
    } catch (e: unknown) {
      // Normalize to Error so `_failStatus` / the error surface sees a
      // well-typed value even when a third-party store / verifier throws
      // a non-Error (string, plain object, etc.). Preserves identity
      // for real Errors.
      const err = e instanceof Error ? e : new Error(String(e));
      this._failStatus(err);
      throw err;
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
    //
    // Ordering note: by the time we reach this check the challenge has
    // already been `take()`n (consume-once) AND the verifier has
    // cryptographically validated the attestation. Doing the duplicate
    // check earlier would require decoding credential.id from the raw
    // response without trusting the signature — and we deliberately do
    // NOT trust unverified client input enough to key a lookup on it.
    // The trade-off is that a duplicate registration burns the
    // challenge slot; the client must request a fresh challenge to
    // retry. That matches our "consume-once, retry with fresh challenge"
    // invariant throughout the verify path and is the safer default
    // (no partial short-circuits that could be probed for enumeration).
    //
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
    } catch (e: unknown) {
      // Normalize to Error so `_failStatus` / the error surface sees a
      // well-typed value even when a third-party store / verifier throws
      // a non-Error (string, plain object, etc.). Preserves identity
      // for real Errors.
      const err = e instanceof Error ? e : new Error(String(e));
      this._failStatus(err);
      throw err;
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
    // Same reasoning for credentialId — a prior ceremony's success
    // should not shadow the in-flight authenticate's state. Dedupe
    // in `_setCredentialId` turns "" → "" into a no-op.
    this._setCredentialId("");
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
    } catch (e: unknown) {
      // Normalize to Error so `_failStatus` / the error surface sees a
      // well-typed value even when a third-party store / verifier throws
      // a non-Error (string, plain object, etc.). Preserves identity
      // for real Errors.
      const err = e instanceof Error ? e : new Error(String(e));
      this._failStatus(err);
      throw err;
    }
  }

  /**
   * Verify an `assertion` returned by `navigator.credentials.get()` and
   * bump the credential's sign counter on success. Mirrors
   * `verifyRegistration`'s consume-before-verify semantics.
   *
   * ## Timing side-channel note
   *
   * This implementation does NOT equalize execution time across the
   * early-return rejection paths (bad base64url, missing challenge
   * slot, wrong mode, expired challenge, unknown credential, userId
   * mismatch) and the full-verifier path (which runs signature verify
   * + public-key loading). The delta between "credential not
   * recognized" returning in microseconds and a real verify running
   * for tens of milliseconds is observable over the network and can
   * support credential-id / user enumeration against a sufficiently
   * well-instrumented attacker.
   *
   * Dummy-verify mitigations (running a constant-time decoy signature
   * check on every rejection) carry real cost — an extra ECDSA verify
   * per bad request is a DoS amplifier, and a poorly-chosen dummy
   * credential leaks its own distinguishing timing — so they are
   * intentionally NOT applied here. Deployments that treat
   * credential-id secrecy as a security boundary (rather than the
   * privacy best-effort the WebAuthn spec itself treats it as) should
   * sit this Core behind a rate-limiter that rejects the Nth failed
   * verify per client IP before the timing leak becomes exploitable.
   *
   * The verbatim error strings returned from this method intentionally
   * collapse the distinct rejection reasons (unknown credential, wrong
   * user, mode mismatch) into the same "credential not recognized for
   * this session." wire message — that closes the message-content
   * side channel even though the timing channel remains.
   */
  async verifyAuthentication(
    sessionId: string,
    response: AuthenticationResponseJSON,
  ): Promise<CredentialRecord> {
    if (!sessionId) raiseError("sessionId is required.");
    if (!response) raiseError("response is required.");
    // Same boundary guard as `verifyRegistration`: `response.id` keys the
    // credential-store lookup a few lines down, and a direct Core caller
    // must not be able to probe with arbitrary strings. Redundant with
    // the handler's `_validateCredentialShape` when the shipped server
    // adapter is in the path; mandatory for direct Core usage.
    if (typeof response.id !== "string" || !_BASE64URL_RE.test(response.id)) {
      this._failVerify("credential.id must be a non-empty base64url string.");
    }
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
      // Same generic wording as the userId-mismatch branch below — the
      // two conditions must return the same external message so the
      // verify endpoint does not expose a probe oracle ("yes this
      // credentialId exists but belongs to somebody else" vs "this
      // credentialId is unknown"). The distinction is preserved in the
      // structured log via `core.error` for the operator.
      return this._failVerify("credential not recognized for this session.");
    }
    // If the challenge carried a userId (targeted authentication), the
    // assertion's credential must belong to that user. Without this guard,
    // a compromised session could take a challenge issued for user A and
    // satisfy it with user B's passkey — allowCredentials filtering is
    // a client-side hint, not a server enforcement.
    //
    // Error message: use the same generic "credential not recognized
    // for this session" wording regardless of WHY the mismatch occurred
    // (unknown credential, wrong user, mode mismatch). Distinct error
    // strings would let an attacker enumerate which credentialIds belong
    // to a targeted user by probing the verify endpoint — a softer
    // version of the credential-id-leak the `resolveAuthenticationUserId`
    // hook closes on the challenge side. The internal record.userId is
    // retained on `core.error` for operator debugging via structured
    // logs, but the user-facing wire message stays opaque.
    if (slot.userId && record.userId !== slot.userId) {
      return this._failVerify("credential not recognized for this session.");
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
    } catch (e: unknown) {
      // Normalize to Error so `_failStatus` / the error surface sees a
      // well-typed value even when a third-party store / verifier throws
      // a non-Error (string, plain object, etc.). Preserves identity
      // for real Errors.
      const err = e instanceof Error ? e : new Error(String(e));
      this._failStatus(err);
      throw err;
    }
    // WebAuthn §6.1.1: a signCount that did not increase across assertions
    // signals a cloned authenticator. Treat it as a hard failure — a weaker
    // "warn and continue" policy hides the attack.
    //
    // Exception: some authenticators (notably platform passkeys like
    // iCloud / Google Password Manager synced passkeys) never advance
    // the counter and report 0 forever. §6.1.1 explicitly allows
    // "signCount value of 0 indicates that the authenticator does not
    // implement a signature counter". So when the STORED counter is 0
    // we allow `newCounter === 0` (and any positive value, which is
    // also strictly-greater-than and passes naturally). Only when the
    // stored counter is positive does a non-advancing newCounter
    // become the cloned-credential signal.
    if (record.counter !== 0 && verified.newCounter <= record.counter) {
      return this._failVerify("authenticator sign counter did not advance — possible cloned credential.");
    }
    try {
      await this._credentialStore.updateCounter(record.credentialId, verified.newCounter);
    } catch (e: unknown) {
      // Normalize to Error so `_failStatus` / the error surface sees a
      // well-typed value even when a third-party store / verifier throws
      // a non-Error (string, plain object, etc.). Preserves identity
      // for real Errors.
      const err = e instanceof Error ? e : new Error(String(e));
      this._failStatus(err);
      throw err;
    }
    this._setCredentialId(record.credentialId);
    this._setStatus("completed");
    return { ...record, counter: verified.newCounter };
  }

  private _failVerify(message: string): never {
    const err = new Error(`[@wc-bindable/hawc-webauthn] ${message}`);
    // Mark this error as "safe to surface verbatim to the client". The
    // verify handler's catch examines this flag to decide whether to
    // relay `e.message` or collapse to a generic fallback — exactly the
    // same pattern `HttpError` uses on the challenge side. The marker is
    // an own-property `clientVisible: true`, checked structurally so
    // applications that throw their own "intended for the user" errors
    // can opt in without importing an internal symbol.
    (err as any).clientVisible = true;
    this._failStatus(err);
    throw err;
  }

  private _failStatus(err: Error): void {
    this._setError(err);
    this._setStatus("error");
  }
}

/**
 * Serializable Error envelope. Extends Error so `instanceof Error` still
 * holds for downstream consumers, and copies `name` / `message` / `stack`
 * from the source so binders see the original identity. The crucial
 * difference from the prior in-place mutation: the source Error is left
 * untouched — only this fresh wrapper carries the `toJSON` hook.
 */
class _SerializableError extends Error {
  constructor(source: Error) {
    super(source.message);
    this.name = source.name;
    // Mirror the source's stack exactly — including "" or undefined.
    // Overwriting (rather than conditionally assigning) is deliberate:
    // `super()` sets a default stack, and if the source intentionally
    // carried a falsy stack (test harnesses sometimes do this to pin
    // serialization) we must not paper over it with our own.
    this.stack = source.stack;
    // Preserve cause when present (Error Cause proposal).
    const cause = (source as any).cause;
    if (cause !== undefined) (this as any).cause = cause;
    // Preserve the `clientVisible` marker that `_failVerify` attaches.
    // The verify handler's catch inspects this flag on the thrown err to
    // decide whether to relay `e.message` verbatim or collapse to a
    // generic fallback. The thrown err is the original (unwrapped) Error
    // today, so the flag survives that path — but any consumer that
    // inspects `core.error` (e.g. a future RemoteCoreProxy relaying the
    // wrapped envelope) must see the same signal, otherwise marked
    // errors would silently downgrade to "generic failure" on the wire.
    // Defense-in-depth: mirror the marker onto the wrapper.
    if ((source as any).clientVisible === true) {
      (this as any).clientVisible = true;
    }
  }
  toJSON(): { name: string; message: string; stack?: string } {
    return {
      name: this.name, message: this.message,
      ...(this.stack ? { stack: this.stack } : {}),
    };
  }
}

function _wrapSerializable(err: Error): Error {
  // If the error ALREADY has a toJSON method we trust the producer — do
  // not wrap (preserves, e.g., DOMException identity for the Shell's
  // NotAllowedError path if we ever route it through here).
  if (typeof (err as any).toJSON === "function") return err;
  return new _SerializableError(err);
}
