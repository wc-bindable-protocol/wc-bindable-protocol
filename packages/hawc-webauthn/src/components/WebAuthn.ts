import { encode, decode } from "../codec/base64url.js";
import {
  IWcBindable, WebAuthnMode, WebAuthnStatus, WebAuthnUser,
  PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON, AuthenticationResponseJSON,
  UserVerificationRequirement, AttestationConveyancePreference,
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
      { name: "mode", attribute: "mode" },
      { name: "rpId", attribute: "rp-id" },
      { name: "userVerification", attribute: "user-verification" },
      { name: "attestation", attribute: "attestation" },
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
    return [
      "mode", "rp-id", "user-verification", "attestation",
      "challenge-url", "verify-url",
      "user-id", "user-name", "user-display-name",
      "timeout",
    ];
  }

  private _status: WebAuthnStatus = "idle";
  private _credentialId: string = "";
  private _user: WebAuthnUser | null = null;
  private _error: any = null;
  private _trigger: boolean = false;

  private _abortController: AbortController | null = null;
  private _currentStart: Promise<void> | null = null;

  // --- Attribute / input mapping ---

  get mode(): WebAuthnMode {
    const v = this.getAttribute("mode");
    return v === "authenticate" ? "authenticate" : "register";
  }
  set mode(value: WebAuthnMode) { this.setAttribute("mode", value); }

  get rpId(): string { return this.getAttribute("rp-id") || ""; }
  set rpId(value: string) { this.setAttribute("rp-id", value); }

  get userVerification(): UserVerificationRequirement {
    const v = this.getAttribute("user-verification");
    return (v === "required" || v === "preferred" || v === "discouraged") ? v : "preferred";
  }
  set userVerification(value: UserVerificationRequirement) {
    this.setAttribute("user-verification", value);
  }

  get attestation(): AttestationConveyancePreference {
    const v = this.getAttribute("attestation");
    return (v === "none" || v === "indirect" || v === "direct" || v === "enterprise") ? v : "none";
  }
  set attestation(value: AttestationConveyancePreference) {
    this.setAttribute("attestation", value);
  }

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
  get error(): any { return this._error; }

  get trigger(): boolean { return this._trigger; }
  set trigger(value: boolean) {
    // Same declarative-trigger contract as <hawc-s3>: flipping trigger true
    // kicks off a ceremony and flips it back false on completion. Treat
    // false→false and true→true as no-ops so a framework setting the same
    // value twice does not double-fire.
    const v = !!value;
    if (v && !this._trigger) {
      this._setTrigger(true);
      this.start().catch(() => {}).finally(() => this._setTrigger(false));
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
    this._credentialId = id;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:credential-id-changed", {
      detail: id, bubbles: true,
    }));
  }

  private _setUser(user: WebAuthnUser | null): void {
    this._user = user;
    this.dispatchEvent(new CustomEvent("hawc-webauthn:user-changed", {
      detail: user ? { ...user } : null, bubbles: true,
    }));
  }

  private _setError(err: any): void {
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
    if (this._currentStart) {
      this.abort();
      await this._currentStart.catch(() => {});
    }
    // Reset visible state for the new attempt. A prior `completed` would
    // otherwise leak into the current ceremony's early phases. `user` is
    // cleared too: when the next ceremony's verify response omits a user
    // (e.g. an authenticate where the server has no resolveUser hook),
    // not clearing here would surface the *previous* ceremony's user as
    // the current one — a misleading reactive value for any UI bound to
    // `user`.
    this._setError(null);
    this._setCredentialId("");
    this._setUser(null);

    const promise = this._runCeremony();
    this._currentStart = promise;
    const clear = (): void => {
      this._currentStart = null;
    };
    promise.then(clear, clear);
    return promise;
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

    this._setStatus("challenging");
    let optionsJSON: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
    try {
      optionsJSON = await this._fetchChallenge(mode, ac.signal);
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }

    let credential: PublicKeyCredential;
    try {
      this._setStatus(mode === "register" ? "creating" : "asserting");
      credential = mode === "register"
        ? await this._createCredential(optionsJSON as PublicKeyCredentialCreationOptionsJSON, ac.signal)
        : await this._getCredential(optionsJSON as PublicKeyCredentialRequestOptionsJSON, ac.signal);
    } catch (e: any) {
      // DOMException "AbortError" / "NotAllowedError" / timeout all land here.
      // NotAllowedError is WebAuthn's catch-all for "user dismissed / UV failed"
      // — do not leak it as a crash, but surface it so the consumer can prompt retry.
      this._failStatus(e);
      throw e;
    }

    this._setStatus("verifying");
    let verifyResult: { credentialId: string; user?: WebAuthnUser };
    try {
      verifyResult = await this._postVerify(mode, credential, ac.signal);
    } catch (e: any) {
      this._failStatus(e);
      throw e;
    }

    this._setCredentialId(verifyResult.credentialId);
    // Set unconditionally — `user` is cleared at start(), so an undefined
    // verify-response user must remain null here rather than carry over a
    // stale value from a prior set in this ceremony's lifetime.
    this._setUser(verifyResult.user ?? null);
    this._setStatus("completed");
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
    return await res.json();
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
      excludeCredentials: (optionsJSON.excludeCredentials ?? []).map((c) => ({
        id: decode(c.id),
        type: c.type,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
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
      allowCredentials: (optionsJSON.allowCredentials ?? []).map((c) => ({
        id: decode(c.id),
        type: c.type,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
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
    return await res.json();
  }

  private _failStatus(err: any): void {
    this._setError(err);
    this._setStatus("error");
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
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
