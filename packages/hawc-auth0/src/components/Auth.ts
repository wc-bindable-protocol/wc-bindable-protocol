import type { ClientTransport } from "@wc-bindable/remote";
import { config } from "../config.js";
import { IWcBindable, AuthMode } from "../types.js";
import { AuthShell } from "../shell/AuthShell.js";
import { registerAutoTrigger, unregisterAutoTrigger } from "../autoTrigger.js";

export class Auth extends HTMLElement {
  static hasConnectedCallbackPromise = true;
  static wcBindable: IWcBindable = {
    ...AuthShell.wcBindable,
    properties: [
      ...AuthShell.wcBindable.properties,
      { name: "trigger", event: "hawc-auth0:trigger-changed" },
    ],
  };
  static get observedAttributes(): string[] {
    return [
      "domain", "client-id", "redirect-uri", "audience", "scope",
      "remote-url", "mode",
    ];
  }

  private _shell: AuthShell;
  private _trigger: boolean = false;
  private _connectedCallbackPromise: Promise<void> = Promise.resolve();
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

  get user(): any {
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

  get error(): any {
    return this._shell.error;
  }

  get connected(): boolean {
    return this._shell.connected;
  }

  get client(): any {
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
    if (v) {
      this._trigger = true;
      this._connectedCallbackPromise
        .then(() => this.login())
        .catch(() => { /* error surfaces via this.error (AuthShell state); avoid unhandled rejection */ })
        .finally(() => {
          this._trigger = false;
          this.dispatchEvent(new CustomEvent("hawc-auth0:trigger-changed", {
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
   */
  async connect(url?: string): Promise<ClientTransport> {
    await this._connectedCallbackPromise;
    return this._shell.connect(url || this.remoteUrl);
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

  attributeChangedCallback(_name: string, _oldValue: string | null, _newValue: string | null): void {
    // No re-initialisation on attribute changes (initialise once only)
  }

  disconnectedCallback(): void {
    // Balance the registerAutoTrigger() call from connectedCallback so
    // the global `document` click listener is detached once the last
    // <hawc-auth0> instance leaves the DOM. Only unregister if THIS
    // instance actually registered — otherwise we would under-decrement
    // the refcount for an element whose connect happened while
    // `config.autoTrigger` was false.
    if (this._autoTriggerRegistered) {
      unregisterAutoTrigger();
      this._autoTriggerRegistered = false;
    }
    // The Auth0 client itself is used singleton-style, so no further
    // cleanup is needed here.
  }
}
