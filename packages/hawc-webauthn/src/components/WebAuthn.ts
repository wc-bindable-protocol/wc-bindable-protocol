import { encode, decode } from "../codec/base64url.js";
import {
  IWcBindable, WebAuthnMode, WebAuthnStatus, WebAuthnUser,
  PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON, AuthenticationResponseJSON,
} from "../types.js";

/**
 * Browser shell for WebAuthn / Passkeys.
 *
 * Anchors the data plane (`navigator.credentials.create()` / `.get()`) to
 * the browser — the authenticator protocol is gated on a user gesture and
 * speaks directly to Touch ID / Windows Hello / a roaming security key, so
 * neither a server-side Core nor a remote proxy could stand in. The Shell
 * orchestrates:
 *
 *   1. POST `challenge-url` to obtain a server-issued challenge + option blob
 *   2. Call `navigator.credentials.create() | .get()` with decoded buffers
 *   3. POST `verify-url` with the serialized credential for Core verification
 *
 * Status flows `idle → challenging → creating|asserting → verifying →
 * completed`. Errors land the Shell in `error` with `error` populated; the
 * next `start()` resets back to `idle`.
 *
 * This is Case C (thick Shell, control/data split) — identical architecture
 * to hawc-s3, with credential material taking the place of blob bytes.
 */
export class WebAuthn extends HTMLElement {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "status", event: "hawc-webauthn:status-changed" },
      { name: "credentialId", event: "hawc-webauthn:credential-id-changed" },
      { name: "user", event: "hawc-webauthn:user-changed" },
      { name: "error", event: "hawc-webauthn:error" },
      { name: "trigger", event: "hawc-webauthn:trigger-changed" },
    ],
    inputs: [
      // Case C (server-authoritative): rp-id, user-verification, and
      // attestation are NOT declared here. The option blob returned by
      // the challenge endpoint is the authoritative source for all three
      // — a Shell-side override would let a compromised page downgrade
      // userVerification or force attestation to "none", so we
      // deliberately do not expose those as Shell inputs. Applications
      // that need different values should configure them on the Core
      // (`userVerification`, `attestation` in `WebAuthnCoreOptions`)
      // where they live under server control.
      { name: "mode", attribute: "mode" },
      { name: "challengeUrl", attribute: "challenge-url" },
      { name: "verifyUrl", attribute: "verify-url" },
      { name: "userId", attribute: "user-id" },
      { name: "userName", attribute: "user-name" },
      { name: "userDisplayName", attribute: "user-display-name" },
      { name: "timeout", attribute: "timeout" },
    ],
    commands: [
      { name: "start", async: true },
      { name: "abort" },
    ],
  };

  static get observedAttributes(): string[] {
    // Mirrors `wcBindable.inputs` — see note there about why rp-id /
    // user-verification / attestation are intentionally absent.
    return [
      "mode",
      "challenge-url", "verify-url",
      "user-id", "user-name", "user-display-name",
      "timeout",
    ];
  }

  private _status: WebAuthnStatus = "idle";
  private _credentialId: string = "";
  private _user: WebAuthnUser | null = null;
  // Typed as `Error | null` rather than `any`. The Shell receives errors
  // from three sources — `navigator.credentials.*` (DOMException), fetch
  // (TypeError / AbortError), and Core verify-failure messages — all of
  // which are `Error` subclasses. The field being `any` was a carry-over
  // that let unrelated values leak into the reactive surface.
  private _error: Error | null = null;
  private _trigger: boolean = false;

  private _abortController: AbortController | null = null;
  private _currentStart: Promise<void> | null = null;
  // Monotonic generation used to serialize 3+ overlapping start() calls.
  // The 2-start case is handled purely by "abort + await previous," but a
  // third call that arrives while the second is still awaiting the first
  // would race on `_currentStart` — both 2 and 3 would see the same
  // in-flight promise p1, both would await it, and after p1 settles they
  // would resume in microtask order and clobber each other's
  // `_currentStart` / AbortController assignments. Each start() claims a
  // fresh generation and only proceeds once all earlier generations have
  // unwound, so the actual ceremonies run strictly one-at-a-time.
  private _startGeneration: number = 0;
  private _startChain: Promise<void> = Promise.resolve();

  // --- Attribute / input mapping ---

  get mode(): WebAuthnMode {
    const v = this.getAttribute("mode");
    return v === "authenticate" ? "authenticate" : "register";
  }
  set mode(value: WebAuthnMode) { this.setAttribute("mode", value); }

  get challengeUrl(): string { return this.getAttribute("challenge-url") || ""; }
  set challengeUrl(value: string) { this.setAttribute("challenge-url", value); }

  get verifyUrl(): string { return this.getAttribute("verify-url") || ""; }
  set verifyUrl(value: string) { this.setAttribute("verify-url", value); }

  get userId(): string { return this.getAttribute("user-id") || ""; }
  set userId(value: string) { this.setAttribute("user-id", value); }

  get userName(): string { return this.getAttribute("user-name") || ""; }
  set userName(value: string) { this.setAttribute("user-name", value); }

  get userDisplayName(): string { return this.getAttribute("user-display-name") || ""; }
  set userDisplayName(value: string) { this.setAttribute("user-display-name", value); }

  get timeout(): number {
    const v = this.getAttribute("timeout");
    const n = v != null ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 60_000;
  }
  set timeout(value: number) { this.setAttribute("timeout", String(value)); }

  // --- Output state ---

  get status(): WebAuthnStatus { return this._status; }
  get credentialId(): string { return this._credentialId; }
  get user(): WebAuthnUser | null { return this._user ? { ...this._user } : null; }
  get error(): Error | null { return this._error; }

  get trigger(): boolean { return this._trigger; }
  set trigger(value: boolean) {
    // Same declarative-trigger contract as <hawc-s3>: flipping trigger true
    // kicks off a ceremony and flips it back false on completion.
    //
    // Semantics — edge-triggered, not level-triggered:
    //   false→true  : start() a ceremony. Trigger is flipped back to
    //                 false automatically on completion (success or
    //                 failure); the app does NOT need to reset it.
    //   true→false  : explicit abort(). This allows a framework bound to
    //                 `trigger` to cancel an in-flight ceremony by writing
    //                 `el.trigger = false`. Without this, the only cancel
    //                 paths were the imperative `abort()` and disconnect.
    //   false→false : no-op.
    //   true→true   : no-op. Setting the same value twice never double-
    //                 fires a ceremony or emits a redundant event.
    //
    // The "true→true no-op" is important for declarative frameworks that
    // reflect state back to attributes on every render — a re-render with
    // the same `trigger=true` must not restart a still-running ceremony.
    const v = !!value;
    if (v === this._trigger) return;
    if (v) {
      this._setTrigger(true);
      this.start().catch(() => {}).finally(() => this._setTrigger(false));
    } else {
      // true→false: cancel any in-flight ceremony. _setTrigger also
      // fires the change event so observers see the cancel.
      this.abort();
      this._setTrigger(false);
    }
  }

  // --- Setters / dispatch ---

  private _setStatus(status: WebAuthnStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:status-changed", {
      detail: status, bubbles: true,
    }));
  }

  private _setCredentialId(id: string): void {
    // Dedupe identical writes (mirrors the Core's own `_setCredentialId`
    // guard). Consecutive `start()` calls otherwise fire "" → "" events
    // at the reset step that binders see as spurious transitions.
    if (this._credentialId === id) return;
    this._credentialId = id;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:credential-id-changed", {
      detail: id, bubbles: true,
    }));
  }

  private _setUser(user: WebAuthnUser | null): void {
    // Reference-compare dedupe — same policy as the Core. A caller that
    // deliberately hands in a fresh-but-equal user object still gets
    // the event; only identity-equal writes (notably the null → null
    // reset path on consecutive start() calls) are suppressed.
    if (this._user === user) return;
    this._user = user;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:user-changed", {
      detail: user ? { ...user } : null, bubbles: true,
    }));
  }

  private _setError(err: Error | null): void {
    // Dedupe identical writes — same pattern as credentialId / user.
    // Prior to this guard, a second start() that succeeded on its first
    // phase would still emit an error=null event at the reset step
    // simply because the previous state was also null.
    if (this._error === err) return;
    this._error = err;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:error", {
      detail: err, bubbles: true,
    }));
  }

  private _setTrigger(v: boolean): void {
    this._trigger = v;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:trigger-changed", {
      detail: v, bubbles: true,
    }));
  }

  // --- Commands ---

  /**
   * Run the full WebAuthn ceremony. Re-entry is serialized: a second
   * `start()` while the previous is mid-flight aborts the first and waits
   * for it to unwind before starting fresh. The pending navigator.credentials
   * call is cancelled via its AbortSignal so the browser's UI dismisses.
   */
  async start(): Promise<void> {
    // Serialize overlapping start() calls through a single chain. Each
    // call appends its own "run ceremony" segment to `_startChain`; the
    // chain ensures segments execute strictly in submission order
    // regardless of how many simultaneous callers await. Two-start
    // works under the old "await _currentStart" shape, but a THIRD
    // overlapping call races the second: both resume in microtask
    // order after the first settles and clobber each other's
    // `_currentStart` / AbortController assignments. A generation
    // counter + FIFO chain gives strict serialization.
    //
    // Synchronous side effects (bumping the generation and aborting
    // the currently-live ceremony) happen IMMEDIATELY — not inside the
    // chained segment — so every new start() cancels the in-flight
    // work right away. If we deferred the abort to the chain segment,
    // each segment would sit waiting for the previous one to finish
    // before aborting it: deadlock whenever the previous ceremony is
    // blocked on a never-resolving fetch.
    const gen = ++this._startGeneration;
    if (this._currentStart) this.abort();

    const run = async (): Promise<void> => {
      // Drain the previous ceremony if it is still live. It was
      // already aborted synchronously above; we just need to wait for
      // it to unwind so reactive state is in a known shape.
      if (this._currentStart) {
        await this._currentStart.catch(() => {});
        this._currentStart = null;
      }
      // A newer start() may have advanced the generation past us
      // during the above await. If so, our work is obsolete — the
      // newer segment is the one that should run the ceremony, and
      // it will also be aborting this one via its own synchronous
      // abort path. Resolve silently rather than double-run.
      if (gen !== this._startGeneration) return;

      // Reset visible state for the new attempt. A prior `completed`
      // would otherwise leak into the current ceremony's early phases.
      // `user` is cleared too: when the next ceremony's verify
      // response omits a user (e.g. an authenticate where the server
      // has no resolveUser hook), not clearing here would surface the
      // *previous* ceremony's user as the current one.
      this._setError(null);
      this._setCredentialId("");
      this._setUser(null);

      const promise = this._runCeremony();
      const clear = (): void => {
        if (this._currentStart === promise) this._currentStart = null;
      };
      promise.then(clear, clear);
      this._currentStart = promise;
      return promise;
    };

    // Append this call's segment to the chain. The next start() will
    // see our link as "the previous one" and wait for it. `.catch`
    // absorbs rejections so the chain is not poisoned — each caller
    // still sees its own rejection via `myTurn`.
    const myTurn = this._startChain.then(run, run);
    this._startChain = myTurn.catch(() => {});
    return myTurn;
  }

  abort(): void {
    if (this._abortController) {
      try { this._abortController.abort(); } catch { /* already aborted */ }
      this._abortController = null;
    }
  }

  // --- Ceremony internals ---

  private async _runCeremony(): Promise<void> {
    if (!this.challengeUrl) {
      const err = new Error("[@wc-bindable/hawc-webauthn] challenge-url attribute is required.");
      this._failStatus(err);
      throw err;
    }
    if (!this.verifyUrl) {
      const err = new Error("[@wc-bindable/hawc-webauthn] verify-url attribute is required.");
      this._failStatus(err);
      throw err;
    }
    if (typeof navigator === "undefined" || !navigator.credentials) {
      const err = new Error("[@wc-bindable/hawc-webauthn] navigator.credentials is not available in this environment.");
      this._failStatus(err);
      throw err;
    }

    const mode = this.mode;
    const ac = new AbortController();
    this._abortController = ac;

    try {
      this._setStatus("challenging");
      let optionsJSON: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
      try {
        optionsJSON = await this._fetchChallenge(mode, ac.signal);
      } catch (e: unknown) {
        // Symmetric normalization: both the reactive `error` surface and
        // the promise reject must hand back the SAME Error instance. The
        // prior shape normalized for `_failStatus` but rethrew the raw
        // `e` — so a consumer that threw a non-Error saw a DIFFERENT
        // value on `el.error` vs. the promise rejection reason. Observers
        // bound to `error` could not correlate with the `.catch` reason.
        const err = _asError(e);
        this._failStatus(err);
        throw err;
      }

      let credential: PublicKeyCredential;
      try {
        this._setStatus(mode === "register" ? "creating" : "asserting");
        credential = mode === "register"
          ? await this._createCredential(optionsJSON as PublicKeyCredentialCreationOptionsJSON, ac.signal)
          : await this._getCredential(optionsJSON as PublicKeyCredentialRequestOptionsJSON, ac.signal);
      } catch (e: unknown) {
        // DOMException "AbortError" / "NotAllowedError" / timeout all land here.
        // NotAllowedError is WebAuthn's catch-all for "user dismissed / UV failed"
        // — do not leak it as a crash, but surface it so the consumer can prompt retry.
        const err = _asError(e);
        this._failStatus(err);
        throw err;
      }

      this._setStatus("verifying");
      let verifyResult: { credentialId: string; user?: WebAuthnUser };
      try {
        verifyResult = await this._postVerify(mode, credential, ac.signal);
      } catch (e: unknown) {
        const err = _asError(e);
        this._failStatus(err);
        throw err;
      }

      this._setCredentialId(verifyResult.credentialId);
      // Set unconditionally — `user` is cleared at start(), so an undefined
      // verify-response user must remain null here rather than carry over a
      // stale value from a prior set in this ceremony's lifetime.
      this._setUser(verifyResult.user ?? null);
      this._setStatus("completed");
    } finally {
      // Clear the AbortController slot on success AND failure alike —
      // without this, a completed ceremony's AC lingers until the next
      // start() explicitly clears it, so a post-completion abort() call
      // would "abort" an already-settled signal with no effect but also
      // no signal that the abort was a no-op. The identity guard
      // (`=== ac`) is load-bearing: a later start() that ran while
      // we were unwinding may have already installed its own fresh AC
      // into the slot (the synchronous abort path in start()), and
      // clobbering that with null would disarm the newer ceremony's
      // cancel channel.
      if (this._abortController === ac) this._abortController = null;
    }
  }

  private async _fetchChallenge(
    mode: WebAuthnMode,
    signal: AbortSignal,
  ): Promise<PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON> {
    const body: Record<string, unknown> = { mode };
    if (mode === "register") {
      const id = this.userId, name = this.userName, displayName = this.userDisplayName;
      if (!id || !name || !displayName) {
        // Registration cannot proceed without a user identity. The Core enforces
        // the same invariant, but failing here means we avoid a round-trip and
        // produce a Shell-local error the framework can localize.
        throw new Error("[@wc-bindable/hawc-webauthn] user-id, user-name, and user-display-name attributes are required for mode=register.");
      }
      body.user = { id, name, displayName };
    } else if (this.userId) {
      // Optional for authenticate: present for targeted login, omitted for
      // usernameless ("discoverable credential") flow.
      body.userId = this.userId;
    }
    const res = await fetch(this.challengeUrl, {
      method: "POST",
      credentials: "include", // session cookie must accompany the challenge req
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[@wc-bindable/hawc-webauthn] challenge request failed (${res.status}): ${text || res.statusText}`);
    }
    return await _parseJsonOrThrow(res, "challenge");
  }

  private async _createCredential(
    optionsJSON: PublicKeyCredentialCreationOptionsJSON,
    signal: AbortSignal,
  ): Promise<PublicKeyCredential> {
    const publicKey: PublicKeyCredentialCreationOptions = {
      rp: optionsJSON.rp,
      user: {
        id: decode(optionsJSON.user.id),
        name: optionsJSON.user.name,
        displayName: optionsJSON.user.displayName,
      },
      challenge: decode(optionsJSON.challenge),
      pubKeyCredParams: optionsJSON.pubKeyCredParams,
      timeout: optionsJSON.timeout ?? this.timeout,
      excludeCredentials: (optionsJSON.excludeCredentials ?? []).map((c) => _descriptor(c)),
      authenticatorSelection: optionsJSON.authenticatorSelection,
      attestation: optionsJSON.attestation,
    };
    const cred = await navigator.credentials.create({ publicKey, signal });
    if (!cred) throw new Error("[@wc-bindable/hawc-webauthn] navigator.credentials.create() returned null.");
    return cred as PublicKeyCredential;
  }

  private async _getCredential(
    optionsJSON: PublicKeyCredentialRequestOptionsJSON,
    signal: AbortSignal,
  ): Promise<PublicKeyCredential> {
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: decode(optionsJSON.challenge),
      timeout: optionsJSON.timeout ?? this.timeout,
      rpId: optionsJSON.rpId,
      allowCredentials: (optionsJSON.allowCredentials ?? []).map((c) => _descriptor(c)),
      userVerification: optionsJSON.userVerification,
    };
    const cred = await navigator.credentials.get({ publicKey, signal });
    if (!cred) throw new Error("[@wc-bindable/hawc-webauthn] navigator.credentials.get() returned null.");
    return cred as PublicKeyCredential;
  }

  private async _postVerify(
    mode: WebAuthnMode,
    credential: PublicKeyCredential,
    signal: AbortSignal,
  ): Promise<{ credentialId: string; user?: WebAuthnUser }> {
    const serialized = mode === "register"
      ? _serializeRegistration(credential)
      : _serializeAuthentication(credential);
    const res = await fetch(this.verifyUrl, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, credential: serialized }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[@wc-bindable/hawc-webauthn] verify request failed (${res.status}): ${text || res.statusText}`);
    }
    return await _parseJsonOrThrow(res, "verify");
  }

  private _failStatus(err: Error): void {
    this._setError(err);
    this._setStatus("error");
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    // Hide the element by default — it has no visible UI, only reactive
    // state + commands. Guard against overwriting an application-supplied
    // inline style: an app that sets `display: contents` (to let slotted
    // content render) or `display: block` (for debugging) should not have
    // that overwritten on every connect. The prior unconditional
    // `this.style.display = "none"` also clobbered the author's style on
    // each move across the tree (Shadow DOM portals, React StrictMode
    // double-mount, etc).
    if (!this.style.display) {
      this.style.display = "none";
    }
  }

  disconnectedCallback(): void {
    this.abort();
  }
}

function _serializeRegistration(cred: PublicKeyCredential): RegistrationResponseJSON {
  const response = cred.response as AuthenticatorAttestationResponse;
  const transports = typeof (response as any).getTransports === "function"
    ? ((response as any).getTransports() as string[])
    : undefined;
  return {
    id: cred.id,
    rawId: encode(cred.rawId),
    type: "public-key",
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      attestationObject: encode(response.attestationObject),
      ...(transports ? { transports } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults() as Record<string, unknown>,
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment as "platform" | "cross-platform" }
      : {}),
  };
}

/**
 * Parse a `Response` body as JSON, but first confirm the server
 * declared it as JSON. A proxy serving an HTML error page, a CDN cache
 * hit on `text/plain`, or a mis-configured middleware that strips the
 * body can all produce `res.ok === true` with a non-JSON payload. The
 * prior `return await res.json()` would then throw a cryptic SyntaxError
 * ("Unexpected token < in JSON at position 0") that gave no hint about
 * WHICH endpoint served the bad content-type. Wrap both concerns into
 * a single diagnostic.
 */
async function _parseJsonOrThrow(res: Response, phase: "challenge" | "verify"): Promise<any> {
  // Check Content-Type when the Response-like object actually exposes
  // `headers` (real Response instances always do, and the real handlers
  // set it). Test mocks that pass only `{ ok, json }` skip this branch
  // and rely on `res.json()` alone — that matches the old behavior and
  // keeps the Shell testable without forcing every consumer to mock a
  // full Headers object.
  const headers = (res as Response).headers;
  if (headers && typeof headers.get === "function") {
    const ct = headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("application/json")) {
      const body = typeof res.text === "function"
        ? await res.text().catch(() => "")
        : "";
      const snippet = body ? `: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}` : "";
      throw new Error(
        `[@wc-bindable/hawc-webauthn] ${phase} response was not application/json ` +
        `(content-type: ${ct || "<missing>"}) — check the server is returning JSON${snippet}`
      );
    }
  }
  try {
    return await res.json();
  } catch (e) {
    // Content-Type claimed JSON but the body failed to parse — surface
    // a more actionable message than the engine's default.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[@wc-bindable/hawc-webauthn] ${phase} response could not be parsed as JSON: ${msg}`
    );
  }
}

/**
 * Normalize an arbitrary caught value into an Error.
 *
 * Rethrown DOM primitives and most runtime failures are already Error
 * subclasses, but user code that uses `throw "oops"` or similar still
 * reaches our catch blocks. Coercing to Error keeps the reactive
 * `error` surface strongly typed (`Error | null`) without forcing the
 * ceremony's rethrow to change shape — we `throw e` (the original
 * value) from the catch block so the caller sees what they expect,
 * while `_error` observers see a well-typed Error wrapper.
 */
/**
 * WebAuthn's `AuthenticatorTransport` is a closed union of literal
 * strings. The server-issued option blob types its transports field as
 * `string[]` (because JSON), and the prior code handed that straight
 * to `navigator.credentials.*` through a blunt `as AuthenticatorTransport[]`
 * cast. The browser *usually* ignores unrecognized transport strings,
 * but some engines throw on strict validation, and a compromised or
 * drift-buggy server could ship values that trigger a crash instead of
 * a clean retry. Filter to the documented literal union — values outside
 * the set are silently dropped rather than passed through unchecked.
 */
const _TRANSPORTS: ReadonlySet<AuthenticatorTransport> = new Set<AuthenticatorTransport>([
  "usb", "nfc", "ble", "internal", "hybrid",
]);

function _filterTransports(raw: unknown): AuthenticatorTransport[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AuthenticatorTransport[] = [];
  for (const t of raw) {
    if (typeof t === "string" && _TRANSPORTS.has(t as AuthenticatorTransport)) {
      out.push(t as AuthenticatorTransport);
    }
  }
  return out.length ? out : undefined;
}

/**
 * Build a `PublicKeyCredentialDescriptor` from a server-issued option
 * blob entry. The WebAuthn spec only defines `type: "public-key"` — a
 * server shipping any other value is either drift or compromised, and
 * we fail loudly instead of letting it reach the browser where the
 * error surface is opaque.
 */
function _descriptor(c: { id: string; type: string; transports?: string[] }): PublicKeyCredentialDescriptor {
  if (c.type !== "public-key") {
    throw new Error(
      `[@wc-bindable/hawc-webauthn] credential descriptor has unsupported type "${c.type}" — ` +
      "only \"public-key\" is defined by the WebAuthn spec."
    );
  }
  const transports = _filterTransports(c.transports);
  return {
    id: decode(c.id),
    type: "public-key",
    ...(transports ? { transports } : {}),
  };
}

function _asError(e: unknown): Error {
  if (e instanceof Error) return e;
  // `null` / `undefined` — code occasionally surfaces these when a
  // promise rejects without a reason (e.g. `Promise.reject()`) or a
  // framework abort path deliberately throws nullish. Checking FIRST
  // (before the string / JSON.stringify branches) matters: `String(null)`
  // yields the literal string `"null"`, and `JSON.stringify(undefined)`
  // yields `undefined` which `new Error(undefined)` turns into an empty
  // message. Both are misleading — the reactive `error` surface shows
  // a non-null Error the observer cannot distinguish from a real
  // "null"-named failure. An explicit "(nothing thrown)" diagnostic
  // makes the root cause legible.
  if (e == null) {
    return new Error("unknown error (nothing thrown)");
  }
  const msg = typeof e === "string"
    ? e
    : (() => {
      try { return JSON.stringify(e); } catch { return String(e); }
    })();
  return new Error(msg || "unknown error");
}

function _serializeAuthentication(cred: PublicKeyCredential): AuthenticationResponseJSON {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: encode(cred.rawId),
    type: "public-key",
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      ...(response.userHandle ? { userHandle: encode(response.userHandle) } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults() as Record<string, unknown>,
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment as "platform" | "cross-platform" }
      : {}),
  };
}
