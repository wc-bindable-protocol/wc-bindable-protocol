import { raiseError } from "../raiseError.js";
import { IWcBindable, Auth0ClientOptions, AuthUser } from "../types.js";

/**
 * Headless authentication core based on Auth0 SPA SDK.
 * Requires browser globals (location, history) for redirect callback handling.
 */
export class AuthCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "authenticated", event: "hawc-auth0:authenticated-changed" },
      { name: "user", event: "hawc-auth0:user-changed" },
      { name: "token", event: "hawc-auth0:token-changed" },
      { name: "loading", event: "hawc-auth0:loading-changed" },
      { name: "error", event: "hawc-auth0:error" },
    ],
  };

  private _target: EventTarget;
  private _client: any = null;
  private _authenticated: boolean = false;
  private _user: AuthUser | null = null;
  private _token: string | null = null;
  private _loading: boolean = false;
  private _error: any = null;
  private _initPromise: Promise<void> | null = null;
  private _initInFlight: boolean = false;

  constructor(target?: EventTarget) {
    super();
    this._target = target ?? this;
  }

  get authenticated(): boolean {
    return this._authenticated;
  }

  get user(): AuthUser | null {
    return this._user;
  }

  get token(): string | null {
    return this._token;
  }

  get loading(): boolean {
    return this._loading;
  }

  get error(): any {
    return this._error;
  }

  get client(): any {
    return this._client;
  }

  get initPromise(): Promise<void> | null {
    return this._initPromise;
  }

  /**
   * Return the current access token's expiry as a millisecond epoch,
   * or `null` if no token is held or the token has no `exp` claim.
   *
   * Exposes the `exp` claim only — the raw token material never leaves
   * AuthCore. Intended for refresh schedulers that need to know when
   * to call `refreshToken()` without touching the token string.
   */
  getTokenExpiry(): number | null {
    const token = this._token;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    try {
      const payload = JSON.parse(_base64UrlDecode(parts[1]));
      if (typeof payload.exp === "number") {
        return payload.exp * 1000;
      }
    } catch {
      // Fall through
    }
    return null;
  }

  private _setLoading(loading: boolean): void {
    this._loading = loading;
    this._target.dispatchEvent(new CustomEvent("hawc-auth0:loading-changed", {
      detail: loading,
      bubbles: true,
    }));
  }

  private _setError(error: any): void {
    this._error = error;
    this._target.dispatchEvent(new CustomEvent("hawc-auth0:error", {
      detail: error,
      bubbles: true,
    }));
  }

  private _setAuthenticated(value: boolean): void {
    this._authenticated = value;
    this._target.dispatchEvent(new CustomEvent("hawc-auth0:authenticated-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setUser(user: AuthUser | null): void {
    this._user = user;
    this._target.dispatchEvent(new CustomEvent("hawc-auth0:user-changed", {
      detail: user,
      bubbles: true,
    }));
  }

  private _setToken(token: string | null): void {
    this._token = token;
    this._target.dispatchEvent(new CustomEvent("hawc-auth0:token-changed", {
      detail: token,
      bubbles: true,
    }));
  }

  /**
   * Initialize the Auth0 client and handle redirect callback if needed.
   *
   * Coalesces concurrent calls: while a previous `_doInitialize` is
   * still awaiting `createAuth0Client` / `handleRedirectCallback` /
   * `_syncState`, a second `initialize()` returns the same in-flight
   * promise instead of racing a parallel Auth0 client construction.
   * Defense-in-depth against lifecycle paths (e.g. disconnect→reconnect
   * landing inside the init microtask gap); programmatic retry after
   * the previous attempt has settled is still supported — `_initInFlight`
   * clears in `finally`, so a post-failure retry starts a fresh attempt.
   */
  initialize(options: Auth0ClientOptions): Promise<void> {
    if (!options.domain) {
      raiseError("domain attribute is required.");
    }
    if (!options.clientId) {
      raiseError("client-id attribute is required.");
    }

    if (this._initInFlight && this._initPromise) {
      return this._initPromise;
    }

    const p = this._doInitialize(options);
    this._initPromise = p;
    return p;
  }

  private async _doInitialize(options: Auth0ClientOptions): Promise<void> {
    this._initInFlight = true;
    this._setLoading(true);
    this._setError(null);

    try {
      const { createAuth0Client } = await import("@auth0/auth0-spa-js");
      this._client = await createAuth0Client({
        domain: options.domain,
        clientId: options.clientId,
        authorizationParams: options.authorizationParams,
        cacheLocation: options.cacheLocation,
        useRefreshTokens: options.useRefreshTokens,
      });

      // リダイレクトコールバックの処理
      const query = globalThis.location?.search || "";
      if (query.includes("code=") && query.includes("state=")) {
        await this._client.handleRedirectCallback();
        // URLからcode/stateパラメータのみ除去（他のパラメータは保持）
        const url = new URL(globalThis.location.href);
        url.searchParams.delete("code");
        url.searchParams.delete("state");
        globalThis.history.replaceState({}, document.title, url.toString());
      }

      await this._syncState();
      this._setLoading(false);
    } catch (e: any) {
      this._setError(e);
      this._setLoading(false);
      // Clear the settled promise on failure so that <hawc-auth0>'s
      // connectedCallback guard (`!_shell.client && !_shell.initPromise`)
      // can fire a fresh attempt on a subsequent connect (e.g. a
      // disconnect→reconnect retry after a transient network / Auth0
      // outage). Leaving the resolved promise in place would make the
      // guard permanently false while `_client` stays null, stranding
      // the element in an unrecoverable error state without an
      // imperative `initialize()` call.
      this._initPromise = null;
    } finally {
      this._initInFlight = false;
    }
  }

  /**
   * Sync authentication state from the Auth0 client.
   */
  private async _syncState(): Promise<void> {
    const isAuthenticated = await this._client.isAuthenticated();
    this._setAuthenticated(isAuthenticated);

    if (isAuthenticated) {
      const user = await this._client.getUser();
      this._setUser(user ?? null);

      try {
        const token = await this._client.getTokenSilently();
        this._setToken(token ?? null);
      } catch (_e) {
        // トークン取得失敗は致命的ではない
        this._setToken(null);
      }
    } else {
      this._setUser(null);
      this._setToken(null);
    }
  }

  /**
   * Redirect to Auth0 login page.
   */
  async login(options?: Record<string, any>): Promise<void> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setLoading(true);
    this._setError(null);

    try {
      await this._client.loginWithRedirect({
        authorizationParams: options,
      });
      // リダイレクト後はこの行に到達しない
    } catch (e: any) {
      this._setError(e);
      this._setLoading(false);
    }
  }

  /**
   * Login via popup window.
   */
  async loginWithPopup(options?: Record<string, any>): Promise<void> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setLoading(true);
    this._setError(null);

    try {
      await this._client.loginWithPopup({
        authorizationParams: options,
      });
      await this._syncState();
      this._setLoading(false);
    } catch (e: any) {
      this._setError(e);
      this._setLoading(false);
    }
  }

  /**
   * Logout from Auth0.
   */
  async logout(options?: Record<string, any>): Promise<void> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setError(null);

    try {
      await this._client.logout(options);
      this._setAuthenticated(false);
      this._setUser(null);
      this._setToken(null);
    } catch (e: any) {
      this._setError(e);
    }
  }

  /**
   * Get access token silently (from cache or via refresh).
   */
  async getToken(options?: Record<string, any>): Promise<string | null> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setError(null);

    try {
      const token = await this._client.getTokenSilently(options);
      this._setToken(token ?? null);
      return this._token;
    } catch (e: any) {
      this._setError(e);
      return null;
    }
  }

  /**
   * Obtain an access token from Auth0 SPA SDK and return it
   * **without** updating `_token`. The caller is responsible for
   * handing the token to whatever downstream system must accept it —
   * typically the server — and only then calling `commitToken(token)`
   * to publish the new value to `_token` / `getTokenExpiry()` and
   * fire `token-changed`.
   *
   * Splitting fetch from commit keeps the invariant that `_token`
   * (and therefore `getTokenExpiry()`) reflects the token the
   * **server** has accepted, so that refresh schedulers cannot be
   * misled by a locally-obtained token that a downstream actor later
   * rejected. Use this in every connection establishment / refresh
   * path; only call `commitToken` after the server confirms acceptance.
   *
   * `options` is forwarded to `getTokenSilently` (e.g. pass
   * `{ cacheMode: "off" }` to force a network refresh).
   *
   * Mirrors `getToken`'s error semantics: when the Auth0 SDK rejects,
   * `_error` is set and `hawc-auth0:error` is dispatched, then `null`
   * is returned. This keeps the observable error contract consistent
   * across `connect` / `refreshToken` / `reconnect` so callers can
   * uniformly translate `null` into a domain-specific message
   * (e.g. "Failed to obtain access token.").
   */
  async fetchToken(options?: Record<string, any>): Promise<string | null> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setError(null);

    try {
      const token = await this._client.getTokenSilently(options);
      return token ?? null;
    } catch (e: any) {
      this._setError(e);
      return null;
    }
  }

  /**
   * Convenience wrapper for `fetchToken({ cacheMode: "off" })` —
   * forces Auth0 to issue a fresh access token instead of returning
   * a cached one. Same fetch-without-commit semantics as `fetchToken`.
   */
  async fetchFreshToken(): Promise<string | null> {
    return this.fetchToken({ cacheMode: "off" });
  }

  /**
   * Commit a token that has already been accepted by the downstream
   * system (server handshake, in-band `auth:refresh`, or a fresh
   * WebSocket `open`). Updates `_token` and dispatches `token-changed`.
   */
  commitToken(token: string | null): void {
    this._setToken(token);
  }
}

function _base64UrlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") return atob(base64);
  // Node fallback for environments without atob.
  return Buffer.from(base64, "base64").toString("binary");
}
