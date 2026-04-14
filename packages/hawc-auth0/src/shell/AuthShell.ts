import { WebSocketClientTransport } from "@wc-bindable/remote";
import type { ClientTransport } from "@wc-bindable/remote";
import { AuthCore } from "../core/AuthCore.js";
import { raiseError } from "../raiseError.js";
import { IWcBindable, AuthShellOptions } from "../types.js";

const PROTOCOL_PREFIX = "hawc-auth0.bearer.";
let _nextRefreshId = 1;

/**
 * Remote-capable authentication shell.
 *
 * Wraps AuthCore (which handles Auth0 SPA SDK interaction) and adds
 * WebSocket connection management for the remote HAWC architecture.
 *
 * AuthShell deliberately does NOT expose `token` in its wcBindable
 * declaration. The token is used internally only during the WebSocket
 * handshake, minimising XSS exposure surface.
 */
export class AuthShell extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "authenticated", event: "hawc-auth0:authenticated-changed" },
      { name: "user",          event: "hawc-auth0:user-changed" },
      { name: "loading",       event: "hawc-auth0:loading-changed" },
      { name: "error",         event: "hawc-auth0:error" },
      { name: "connected",     event: "hawc-auth0:connected-changed" },
    ],
  };

  private _core: AuthCore;
  private _connected: boolean = false;
  private _ws: WebSocket | null = null;
  private _url: string = "";

  constructor(target?: EventTarget) {
    super();
    // AuthCore dispatches events on the provided target, so passing `this`
    // means authenticated/user/loading/error events fire on the AuthShell.
    this._core = new AuthCore(target ?? this);
  }

  // --- Delegated getters ---------------------------------------------------

  get authenticated(): boolean {
    return this._core.authenticated;
  }

  get user() {
    return this._core.user;
  }

  get loading(): boolean {
    return this._core.loading;
  }

  get error(): any {
    return this._core.error;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Raw Auth0 client — exposed for advanced use only. */
  get client(): any {
    return this._core.client;
  }

  /** Access token — available via JS but NOT in wcBindable (by design). */
  get token(): string | null {
    return this._core.token;
  }

  get initPromise(): Promise<void> | null {
    return this._core.initPromise;
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Initialise the Auth0 client. Converts AuthShellOptions into the
   * Auth0ClientOptions that AuthCore expects.
   */
  initialize(options: AuthShellOptions): Promise<void> {
    const authorizationParams: Record<string, any> = {
      scope: options.scope ?? "openid profile email",
    };
    if (options.redirectUri) {
      authorizationParams.redirect_uri = options.redirectUri;
    }
    if (options.audience) {
      authorizationParams.audience = options.audience;
    }

    return this._core.initialize({
      domain: options.domain,
      clientId: options.clientId,
      authorizationParams,
      cacheLocation: options.cacheLocation,
      useRefreshTokens: options.useRefreshTokens ?? true,
    });
  }

  async login(options?: Record<string, any>): Promise<void> {
    return this._core.login(options);
  }

  async loginWithPopup(options?: Record<string, any>): Promise<void> {
    return this._core.loginWithPopup(options);
  }

  async logout(options?: Record<string, any>): Promise<void> {
    this._closeWebSocket();
    this._setConnected(false);
    return this._core.logout(options);
  }

  async getToken(options?: Record<string, any>): Promise<string | null> {
    return this._core.getToken(options);
  }

  // --- Remote connection ----------------------------------------------------

  /**
   * Establish an authenticated WebSocket connection.
   *
   * The access token is sent in the `Sec-WebSocket-Protocol` header as
   * `hawc-auth0.bearer.{JWT}`. Returns a `ClientTransport` that can be
   * passed to `createRemoteCoreProxy()`.
   */
  async connect(url: string): Promise<ClientTransport> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    const token = await this._core.getToken();
    if (!token) {
      raiseError("Failed to obtain access token.");
    }

    this._closeWebSocket();

    this._url = url;
    const ws = new WebSocket(url, [`${PROTOCOL_PREFIX}${token}`]);
    this._ws = ws;

    ws.addEventListener("close", () => {
      if (this._ws === ws) {
        this._setConnected(false);
      }
    });

    // Wait for the connection to open before returning the transport
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => {
        reject(new Error(`[@wc-bindable/hawc-auth0] WebSocket connection failed: ${url}`));
      }, { once: true });
    });

    this._setConnected(true);
    return new WebSocketClientTransport(ws);
  }

  /**
   * In-band token refresh (Strategy A — §3.4.1).
   *
   * Obtains a fresh access token from Auth0 and sends it to the server
   * over the **existing** WebSocket as an `auth:refresh` command.
   * The server re-verifies the token and updates the session expiry
   * without reconstructing Cores — Core state is fully continuous.
   *
   * Sends and receives directly on the raw WebSocket to avoid
   * interfering with RemoteCoreProxy's single-handler transport.
   * The server intercepts `auth:refresh` before RemoteShellProxy
   * sees it, so the proxy never receives the response either.
   */
  async refreshToken(): Promise<void> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      raiseError("No active connection. Call connect() first.");
    }

    const token = await this._core.client.getTokenSilently({ cacheMode: "off" });
    if (!token) {
      raiseError("Failed to refresh access token.");
    }

    const id = `auth-refresh-${_nextRefreshId++}`;
    const ws = this._ws;

    return new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id !== id) return;
        ws.removeEventListener("message", onMessage);
        if (msg.type === "return") resolve();
        else reject(new Error(msg.error?.message ?? "Token refresh failed"));
      };

      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({
        type: "cmd",
        name: "auth:refresh",
        id,
        args: [token],
      }));
    });
  }

  /**
   * Refresh the token and establish a new WebSocket connection
   * (Strategy B — §3.4.2, fallback for crash recovery).
   *
   * Returns a new `ClientTransport`. Use with `proxy.reconnect(transport)`
   * to swap the underlying connection. Note: server-side Core state is
   * rebuilt from scratch — property values may change.
   */
  async reconnect(): Promise<ClientTransport> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!this._url) {
      raiseError("No previous connection URL. Call connect() first.");
    }

    // Force a fresh token (bypass cache)
    const token = await this._core.client.getTokenSilently({ cacheMode: "off" });
    if (!token) {
      raiseError("Failed to refresh access token.");
    }

    this._closeWebSocket();

    const ws = new WebSocket(this._url, [`${PROTOCOL_PREFIX}${token}`]);
    this._ws = ws;

    ws.addEventListener("close", () => {
      if (this._ws === ws) {
        this._setConnected(false);
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => {
        reject(new Error(`[@wc-bindable/hawc-auth0] WebSocket reconnection failed: ${this._url}`));
      }, { once: true });
    });

    this._setConnected(true);
    return new WebSocketClientTransport(ws);
  }

  // --- Private helpers ------------------------------------------------------

  private _setConnected(value: boolean): void {
    if (this._connected === value) return;
    this._connected = value;
    this.dispatchEvent(new CustomEvent("hawc-auth0:connected-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _closeWebSocket(): void {
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      ws.close();
    }
  }
}
