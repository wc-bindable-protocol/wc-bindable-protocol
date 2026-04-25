import type { ClientTransport } from "@wc-bindable/remote";
import { config } from "../config.js";
import { IWcBindable, AuthMode, AuthError, AuthUser } from "../types.js";
import { AuthShell } from "../shell/AuthShell.js";
import { registerAutoTrigger, unregisterAutoTrigger } from "../autoTrigger.js";

export class Auth extends HTMLElement {
  static hasConnectedCallbackPromise = true;
  static wcBindable: IWcBindable = {
    ...AuthShell.wcBindable,
    properties: [
      ...AuthShell.wcBindable.properties,
      { name: "trigger", event: "auth0-gate:trigger-changed" },
    ],
  };
  static get observedAttributes(): string[] {
    return [
      "domain", "client-id", "redirect-uri", "audience", "scope",
      "remote-url", "mode", "cache-location", "use-refresh-tokens",
    ];
  }

  private _shell: AuthShell;
  private _trigger: boolean = false;
  private _connectedCallbackPromise: Promise<void> = Promise.resolve();
  private _initScheduled = false;
  // Track whether THIS instance called registerAutoTrigger(), so that
  // disconnectedCallback can pair it with a single unregisterAutoTrigger().
  // Required because `config.autoTrigger` may toggle between connect
  // and disconnect — without this flag a false reading on disconnect
  // would unbalance the refcount in autoTrigger.ts.
  private _autoTriggerRegistered: boolean = false;

  constructor() {
    super();
    this._shell = new AuthShell(this);
  }

  // --- Input attributes ---

  get domain(): string {
    return this.getAttribute("domain") || "";
  }

  set domain(value: string) {
    this.setAttribute("domain", value);
  }

  get clientId(): string {
    return this.getAttribute("client-id") || "";
  }

  set clientId(value: string) {
    this.setAttribute("client-id", value);
  }

  get redirectUri(): string {
    return this.getAttribute("redirect-uri") || "";
  }

  set redirectUri(value: string) {
    this.setAttribute("redirect-uri", value);
  }

  get audience(): string {
    return this.getAttribute("audience") || "";
  }

  set audience(value: string) {
    this.setAttribute("audience", value);
  }

  get scope(): string {
    return this.getAttribute("scope") || "openid profile email";
  }

  set scope(value: string) {
    this.setAttribute("scope", value);
  }

  get cacheLocation(): "memory" | "localstorage" {
    const value = this.getAttribute("cache-location");
    return value === "localstorage" ? "localstorage" : "memory";
  }

  set cacheLocation(value: "memory" | "localstorage") {
    this.setAttribute("cache-location", value);
  }

  get useRefreshTokens(): boolean {
    const v = this.getAttribute("use-refresh-tokens");
    return v === null ? true : v !== "false";
  }

  set useRefreshTokens(value: boolean) {
    this.setAttribute("use-refresh-tokens", value ? "true" : "false");
  }

  get popup(): boolean {
    return this.hasAttribute("popup");
  }

  set popup(value: boolean) {
    if (value) {
      this.setAttribute("popup", "");
    } else {
      this.removeAttribute("popup");
    }
  }

  get remoteUrl(): string {
    return this.getAttribute("remote-url") || "";
  }

  set remoteUrl(value: string) {
    this.setAttribute("remote-url", value);
  }

  /**
   * Deployment mode. Resolved from:
   *
   * 1. `mode` attribute, if set to `"local"` or `"remote"` (wins).
   * 2. Otherwise, implicit: `"remote"` when `remote-url` has a non-empty value,
   *    else `"local"`. An empty `remote-url=""` is treated as unset.
   *
   * In `"remote"` mode the access token is not reachable from JS —
   * `.token` returns `null` and `getToken()` throws.
   */
  get mode(): AuthMode {
    const attr = this.getAttribute("mode");
    if (attr === "remote" || attr === "local") return attr;
    return this.remoteUrl ? "remote" : "local";
  }

  set mode(value: AuthMode) {
    this.setAttribute("mode", value);
  }

  // --- Output state (delegated to shell) ---

  get authenticated(): boolean {
    return this._shell.authenticated;
  }

  get user(): AuthUser | null {
    return this._shell.user;
  }

  /**
   * Access token.
   *
   * Local mode: returns the current access token (or `null`) so application
   * code can attach `Authorization: Bearer` headers to outbound requests.
   *
   * Remote mode: always returns `null`. The token stays inside AuthShell and
   * is sent on the wire only at the WebSocket handshake and during in-band
   * `auth:refresh`. See README-REMOTE for the rationale.
   *
   * Never part of the wcBindable surface (both modes).
   */
  get token(): string | null {
    return this._shell.token;
  }

  get loading(): boolean {
    return this._shell.loading;
  }

  get error(): AuthError | Error | null {
    return this._shell.error;
  }

  get connected(): boolean {
    return this._shell.connected;
  }

  /**
   * Raw Auth0 client — exposed for advanced use only. Typed as
   * `unknown` because `@auth0/auth0-spa-js` is a peer dependency of
   * this package and the public API surface must not silently leak
   * that type to consumers who have not installed it. Narrow in the
   * calling code via `as Auth0Client` if you need the SDK methods.
   */
  get client(): unknown {
    return this._shell.client;
  }

  get connectedCallbackPromise(): Promise<void> {
    return this._connectedCallbackPromise;
  }

  // --- Trigger (one-way command) ---

  get trigger(): boolean {
    return this._trigger;
  }

  set trigger(value: boolean) {
    const v = !!value;
    // Guard against double-trigger: a second `trigger=true` while a
    // previous login() is still in flight would queue a parallel
    // login() call (the `.finally()` handler has not yet fired, so
    // `_trigger` is still true). Auth0's `loginWithRedirect` tolerates
    // re-entry but the visible UX is two back-to-back navigations
    // racing each other; ignoring the redundant `true` keeps the
    // single-in-flight contract.
    if (v && this._trigger) return;
    if (v) {
      this._trigger = true;
      this._connectedCallbackPromise
        .then(() => this.login())
        .catch(() => { /* error surfaces via this.error (AuthShell state); avoid unhandled rejection */ })
        .finally(() => {
          this._trigger = false;
          this.dispatchEvent(new CustomEvent("auth0-gate:trigger-changed", {
            detail: false,
            bubbles: true,
          }));
        });
    }
  }

  // --- Methods ---

  private _buildShellOptions() {
    return {
      domain: this.domain,
      clientId: this.clientId,
      // Normalise empty attribute (`audience=""` or unset) to undefined
      // to match AuthShellOptions' optional contract — AuthShell
      // already skips `audience` when falsy, this keeps the types and
      // the runtime aligned instead of passing `""` under an optional
      // `string` type.
      audience: this.audience || undefined,
      scope: this.scope,
      redirectUri: this.redirectUri || undefined,
      cacheLocation: this.cacheLocation,
      useRefreshTokens: this.useRefreshTokens,
      mode: this.mode,
    };
  }

  async initialize(): Promise<void> {
    return this._shell.initialize(this._buildShellOptions());
  }

  async login(options?: Record<string, any>): Promise<void> {
    await this._connectedCallbackPromise;
    if (this.popup) {
      return this._shell.loginWithPopup(options);
    }
    return this._shell.login(options);
  }

  async logout(options?: Record<string, any>): Promise<void> {
    await this._connectedCallbackPromise;
    return this._shell.logout(options);
  }

  async getToken(options?: Record<string, any>): Promise<string | null> {
    await this._connectedCallbackPromise;
    return this._shell.getToken(options);
  }

  /**
   * Current access token's expiry as a millisecond epoch, or `null`.
   * Exposes only the `exp` claim; the token material stays inside the Shell.
   */
  getTokenExpiry(): number | null {
    return this._shell.getTokenExpiry();
  }

  /**
   * Establish an authenticated WebSocket connection.
   * If no URL is provided, uses the `remote-url` attribute.
   *
   * `options.failIfConnected` forwards an atomic ownership guard to
   * `AuthShell.connect()` — it rejects fast when another connection is
   * already open or a handshake is in flight, instead of closing the
   * other owner's socket. Used by `<auth0-session>` to close the
   * TOCTOU between its `auth.connected` check and this method's
   * `await connectedCallbackPromise` microtask hop
   * (SPEC-REMOTE §3.7 — Connection Ownership).
   */
  async connect(
    url?: string,
    options?: { failIfConnected?: boolean },
  ): Promise<ClientTransport> {
    await this._connectedCallbackPromise;
    return this._shell.connect(url || this.remoteUrl, options);
  }

  /**
   * In-band token refresh (§3.4.1). Sends a fresh token to the server
   * over the existing WebSocket. Core state is fully continuous.
   */
  async refreshToken(): Promise<void> {
    await this._connectedCallbackPromise;
    return this._shell.refreshToken();
  }

  /**
   * Refresh the token and establish a new WebSocket connection
   * (§3.4.2 — fallback for crash recovery).
   */
  async reconnect(): Promise<ClientTransport> {
    await this._connectedCallbackPromise;
    return this._shell.reconnect();
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
    if (config.autoTrigger && !this._autoTriggerRegistered) {
      registerAutoTrigger();
      this._autoTriggerRegistered = true;
    }
    // Catch mode / remote-url changes that occurred while detached
    // (attributeChangedCallback bails on !isConnected).
    this._shell.mode = this.mode;
    this._tryInitialize();
  }

  attributeChangedCallback(_name: string, _oldValue: string | null, _newValue: string | null): void {
    if (!this.isConnected) return;

    // Keep the shell's mode in sync with the live attribute so that
    // token / getToken() / connect() honour post-init mode changes in
    // both directions (local→remote AND remote→local).
    //
    // We deliberately DO NOT re-run `initialize()` when `mode`,
    // `audience`, `scope`, `redirect-uri`, `cache-location`, or
    // `use-refresh-tokens` change post-init. The Auth0 SPA SDK owns
    // refresh-token / session storage keyed by those options; swapping
    // them mid-session would orphan the stored session and force a
    // silent-auth fallback. Applications that truly need to reconfigure
    // must tear down the element and mount a fresh one — `connect()` /
    // `reconnect()` will fail fast for a remote-mode mismatch
    // (missing audience) so the operator sees the mistake at the call
    // site rather than via a 1008 close.
    if (_name === "mode" || _name === "remote-url") {
      this._shell.mode = this.mode;
    }

    // Coalesce synchronous attribute stamps (frameworks that set domain,
    // client-id, cache-location, … in sequence) into a single init
    // attempt. Without the microtask, init fires as soon as domain +
    // client-id arrive, potentially before cache-location or
    // use-refresh-tokens are stamped.
    if (this._shell.client || this._shell.initPromise) return;
    if (this._initScheduled) return;
    this._initScheduled = true;
    this._connectedCallbackPromise = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        this._initScheduled = false;
        if (
          !this.isConnected ||
          this._shell.client ||
          this._shell.initPromise ||
          !this.domain ||
          !this.clientId
        ) {
          resolve();
          return;
        }
        this.initialize().then(resolve, resolve);
      });
    });
  }

  private _tryInitialize(): void {
    // Guard against double-init during the in-flight window.
    // `_shell.client` alone is not sufficient: it is set only after
    // `createAuth0Client()` resolves, so a disconnect→reconnect that
    // lands between `initialize()` start and that resolution would
    // see `client === null` and fire a second `initialize()`,
    // racing two `createAuth0Client()` calls and producing
    // nondeterministic state. Also checking `_shell.initPromise`
    // closes that window — the shell has already started, and
    // `_connectedCallbackPromise` still points at the first in-flight
    // promise so callers awaiting it see the same completion.
    if (
      !this._shell.client &&
      !this._shell.initPromise &&
      this.domain &&
      this.clientId
    ) {
      this._connectedCallbackPromise = this.initialize();
    }
  }

  disconnectedCallback(): void {
    // Balance the registerAutoTrigger() call from connectedCallback so
    // the global `document` click listener is detached once the last
    // <auth0-gate> instance leaves the DOM. Only unregister if THIS
    // instance actually registered — otherwise we would under-decrement
    // the refcount for an element whose connect happened while
    // `config.autoTrigger` was false.
    if (this._autoTriggerRegistered) {
      unregisterAutoTrigger();
      this._autoTriggerRegistered = false;
    }
    // Release the remote session the element owns, but DEFER the
    // teardown one microtask so a same-task reconnect (React portal
    // move, framework reconciliation reinserting the node, route
    // transitions that preserve state) cancels it. Custom element
    // detach → reattach within the same task is common for hidden
    // controller elements; eager teardown here would drop the
    // authenticated WebSocket on every such hop and fire a spurious
    // `connected=false`. When the detach is a real removal (SPA route
    // change to a different view, conditional render), the element is
    // still disconnected by the time the microtask runs and we close
    // the socket to release the server-side session. The Auth0 SDK
    // itself is singleton and intentionally kept warm across mounts.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this._shell.disconnect();
    });
  }
}
