import { WebSocketClientTransport } from "@wc-bindable/remote";
import type { ClientTransport, ClientMessage, ServerMessage } from "@wc-bindable/remote";
import { AuthCore } from "../core/AuthCore.js";
import { raiseError } from "../raiseError.js";
import { IWcBindable, AuthMode, AuthShellOptions } from "../types.js";
import { PROTOCOL_PREFIX } from "../protocolPrefix.js";

let _nextRefreshId = 1;
type RefreshResponseMessage = Extract<ServerMessage, { type: "return" | "throw" }>;

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
  private _transport: InterceptingClientTransport | null = null;
  private _url: string = "";
  private _mode: AuthMode = "local";
  // Synchronous in-flight claim used by the atomic `failIfConnected`
  // ownership guard in `connect()`. Flipped to `true` BEFORE the first
  // `await` and reset in `finally`, so concurrent callers — including
  // the race across `Auth.connect()`'s `await connectedCallbackPromise`
  // microtask — observe an existing handshake synchronously.
  private _connectInFlight: boolean = false;

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

  /** Deployment mode. See {@link AuthMode}. */
  get mode(): AuthMode {
    return this._mode;
  }

  set mode(value: AuthMode) {
    this._mode = value;
  }

  /**
   * Access token.
   *
   * In `"local"` mode: returns the current access token (or `null`) so
   * application code can attach `Authorization: Bearer` headers.
   *
   * In `"remote"` mode: always returns `null`. The token is held inside
   * AuthShell and sent on the wire only at the WebSocket handshake and
   * during in-band `auth:refresh`; application code must not read or
   * forward it.
   *
   * Never part of the wcBindable surface (by design).
   */
  get token(): string | null {
    if (this._mode === "remote") return null;
    return this._core.token;
  }

  get initPromise(): Promise<void> | null {
    return this._core.initPromise;
  }

  /**
   * Current access token's expiry as a millisecond epoch, or `null`
   * if no token is held. Does NOT expose the token material —
   * intended for refresh schedulers in remote deployments where
   * `token` is deliberately kept inside AuthShell.
   */
  getTokenExpiry(): number | null {
    return this._core.getTokenExpiry();
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Initialise the Auth0 client. Converts AuthShellOptions into the
   * Auth0ClientOptions that AuthCore expects.
   */
  initialize(options: AuthShellOptions): Promise<void> {
    this._mode = options.mode ?? "local";

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
    if (this._mode === "remote") {
      raiseError(
        "getToken() is disabled in remote mode. The access token stays inside AuthShell; use the WebSocket transport for authenticated calls and getTokenExpiry() for refresh scheduling.",
      );
    }
    return this._core.getToken(options);
  }

  // --- Remote connection ----------------------------------------------------

  /**
   * Establish an authenticated WebSocket connection.
   *
   * The access token is sent in the `Sec-WebSocket-Protocol` header as
   * `hawc-auth0.bearer.{JWT}`. Returns a `ClientTransport` that can be
   * passed to `createRemoteCoreProxy()`.
   *
   * `options.failIfConnected` opts into an atomic ownership guard: the
   * call rejects fast when another connection is open OR another
   * handshake is already in flight, instead of silently closing the
   * other party's socket via `_closeWebSocket()`. `<hawc-auth0-session>`
   * passes this flag to stop a race between its synchronous
   * `auth.connected` check and the subsequent `await auth.connect()`
   * microtask hop (SPEC-REMOTE §3.7 — Connection Ownership).
   * Direct callers that explicitly want to take over an existing
   * transport omit the flag and fall back to the legacy
   * `_closeWebSocket()`-then-reconnect behaviour.
   */
  async connect(
    url: string,
    options?: { failIfConnected?: boolean },
  ): Promise<ClientTransport> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!url) {
      raiseError(
        "connect(): WebSocket URL is required. Pass it as the argument or set the `remote-url` attribute on <hawc-auth0>.",
      );
    }

    // Atomic ownership claim. Both the existence check and the flag
    // toggle run BEFORE the first await, so a concurrent caller crossing
    // `Auth.connect()`'s `await connectedCallbackPromise` boundary
    // observes `_connectInFlight` and bails out instead of racing into
    // `_closeWebSocket()` and tearing down the first owner's socket.
    if (
      options?.failIfConnected &&
      (this._connectInFlight || this._ws !== null || this._connected)
    ) {
      raiseError(
        "connect(): target already owns a connection or a handshake is in flight. " +
        "Another path (<hawc-auth0-session>, direct authEl.connect(), or an in-flight call) " +
        "is managing the transport — see SPEC-REMOTE §3.7 (Connection Ownership).",
      );
    }
    this._connectInFlight = true;

    try {
      // Fetch-then-commit: same invariant as refreshToken / reconnect.
      // The token is published to AuthCore only after the server accepts
      // it via the WebSocket handshake (`open`). If the initial connection
      // fails, `_token` and `getTokenExpiry()` stay aligned with the last
      // server-accepted state (typically null on first attempt).
      const token = await this._core.fetchToken();
      if (!token) {
        raiseError("Failed to obtain access token.");
      }

      this._closeWebSocket();

      this._url = url;
      const ws = new WebSocket(url, [`${PROTOCOL_PREFIX}${token}`]);
      this._ws = ws;

      ws.addEventListener("close", () => {
        if (this._ws === ws) {
          // Null the reference so `_ws` reflects "live connection", not
          // "last connection that ever existed". Otherwise the
          // `failIfConnected` ownership guard (`_ws !== null`) would
          // keep rejecting subsequent reconnects by <hawc-auth0-session>
          // after any server-side close (network blip, token expiry,
          // server restart), stranding the session in an unrecoverable
          // state. `_ws === ws` guards against stomping on a newer
          // socket that already replaced this one.
          this._ws = null;
          this._setConnected(false);
        }
      });

      // Wait for the connection to open before returning the transport.
      // If the handshake fails we MUST drop `connected` back to false:
      // _closeWebSocket() above nulled `_ws` before close()-ing the
      // previous socket, so the previous socket's close handler became
      // a no-op (its `this._ws === ws` guard fails), and without this
      // explicit clear `connected` would stay true even though no live
      // transport remains. This corrupts any UI / retry logic keyed off
      // `connected`. Also null the failed socket reference so `_ws` does
      // not linger as a dangling reference to a dead socket between calls.
      try {
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => {
            reject(new Error(`[@wc-bindable/hawc-auth0] WebSocket connection failed: ${url}`));
          }, { once: true });
        });
      } catch (err) {
        if (this._ws === ws) {
          this._ws = null;
        }
        this._setConnected(false);
        throw err;
      }

      // Server accepted the token at handshake — safe to commit.
      this._core.commitToken(token);
      this._setConnected(true);
      return this._createTransport(ws);
    } finally {
      // Always release the ownership claim, whether we succeeded,
      // threw from a precondition, or rejected at handshake.
      this._connectInFlight = false;
    }
  }

  /**
   * In-band token refresh (Strategy A — §3.4.1).
   *
   * Obtains a fresh access token from Auth0 and sends it to the server
   * over the **existing** WebSocket as an `auth:refresh` command.
   * The server re-verifies the token and updates the session expiry
   * without reconstructing Cores — Core state is fully continuous.
   *
  * Sends directly on the raw WebSocket, but registers a one-shot
  * response interceptor on the returned ClientTransport so the
  * matching `return` / `throw` frame is consumed before downstream
  * consumers such as RemoteCoreProxy see it.
   */
  async refreshToken(): Promise<void> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      raiseError("No active connection. Call connect() first.");
    }

    // Fetch the new token WITHOUT committing it. We only publish it
    // into AuthCore once the server has confirmed acceptance, otherwise
    // `getTokenExpiry()` would advance ahead of the session the server
    // is actually enforcing, and exp-based schedulers would delay the
    // next refresh past the server-side deadline.
    const token = await this._core.fetchFreshToken();
    if (!token) {
      raiseError("Failed to refresh access token.");
    }

    const id = `auth-refresh-${_nextRefreshId++}`;
    const ws = this._ws;
    const transport = this._transport;
    if (!transport) {
      raiseError("No active connection. Call connect() first.");
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let releaseIntercept: (() => void) | undefined;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        releaseIntercept?.();
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
      };

      const onMessage = (msg: RefreshResponseMessage) => {
        cleanup();
        if (msg.type === "return") resolve();
        else reject(new Error(_getErrorMessage(msg.error)));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before token refresh completed"));
      };

      const onError = () => {
        cleanup();
        reject(new Error("WebSocket error during token refresh"));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Token refresh timed out"));
      }, 30_000);

      releaseIntercept = transport.interceptResponse(id, onMessage);
      ws.addEventListener("close", onClose, { once: true });
      ws.addEventListener("error", onError, { once: true });
      try {
        transport.send({
          type: "cmd",
          name: "auth:refresh",
          id,
          args: [token],
        });
      } catch (sendErr) {
        // ws.send can throw synchronously if the socket transitioned out
        // of OPEN between the readyState check and this call. Without an
        // explicit cleanup the 30-second timer, response interceptor, and
        // close/error listeners would survive, leaking an unhandled rejection
        // at timeout and risking misattribution of unrelated future frames.
        cleanup();
        reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
      }
    });

    // Server has returned success — safe to publish the new token.
    this._core.commitToken(token);
  }

  /**
   * Refresh the token and establish a new WebSocket connection
   * (Strategy B — §3.4.2, fallback for crash recovery).
   *
   * Returns a new `ClientTransport`. Use with `proxy.reconnect(transport)`
   * to swap the underlying connection. Note: server-side Core state is
   * rebuilt from scratch — property values may change.
   *
   * Shares the `_connectInFlight` ownership claim with `connect()`:
   * a concurrent `reconnect()` / `connect({ failIfConnected: true })`
   * fails fast instead of racing two `_closeWebSocket()` + handshake
   * pairs. Without this, a second reconnect call would close the
   * first reconnect's in-flight socket, leaving the first caller with
   * a broken transport while `_ws` pointed at the second's socket.
   */
  async reconnect(): Promise<ClientTransport> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!this._url) {
      raiseError("No previous connection URL. Call connect() first.");
    }

    // Atomic ownership claim shared with connect(). Set BEFORE any
    // await so a concurrent connect() / reconnect() observes it
    // synchronously. A parallel reconnect bails out with the same
    // ownership error as a racing connect(failIfConnected), and the
    // first caller proceeds to completion without being torn down.
    if (this._connectInFlight) {
      raiseError(
        "reconnect(): another handshake (connect or reconnect) is already in flight. " +
        "See SPEC-REMOTE §3.7 (Connection Ownership).",
      );
    }
    this._connectInFlight = true;

    try {
      // Fetch-then-commit: the new token is published to AuthCore only
      // after the server accepts it via the WebSocket handshake (`open`).
      // If the reconnection fails, `_token` and `getTokenExpiry()` stay
      // aligned with the last session the server actually honoured.
      const token = await this._core.fetchFreshToken();
      if (!token) {
        raiseError("Failed to refresh access token.");
      }

      this._closeWebSocket();

      const ws = new WebSocket(this._url, [`${PROTOCOL_PREFIX}${token}`]);
      this._ws = ws;

      ws.addEventListener("close", () => {
        if (this._ws === ws) {
          // Mirror connect(): null the stale reference so subsequent
          // `failIfConnected: true` calls are not rejected against a
          // dead socket. See connect()'s close handler for rationale.
          this._ws = null;
          this._setConnected(false);
        }
      });

      // See connect(): the previous socket's close handler is now a no-op,
      // so a handshake failure here would leave `connected` stuck at true
      // unless we explicitly clear it on the failure path. Also null the
      // failed socket reference so `_ws` does not linger as a dangling
      // reference to a dead socket between calls.
      try {
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => {
            reject(new Error(`[@wc-bindable/hawc-auth0] WebSocket reconnection failed: ${this._url}`));
          }, { once: true });
        });
      } catch (err) {
        if (this._ws === ws) {
          this._ws = null;
        }
        this._setConnected(false);
        throw err;
      }

      // Server accepted the new token at handshake — safe to commit.
      this._core.commitToken(token);
      this._setConnected(true);
      return this._createTransport(ws);
    } finally {
      // Always release the ownership claim so the next connect /
      // reconnect can proceed (including post-failure retries).
      this._connectInFlight = false;
    }
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
    if (this._transport) {
      this._transport.dispose();
      this._transport = null;
    }
  }

  private _createTransport(ws: WebSocket): InterceptingClientTransport {
    const transport = new InterceptingClientTransport(ws);
    this._transport = transport;
    return transport;
  }
}

class InterceptingClientTransport implements ClientTransport {
  private _base: WebSocketClientTransport;
  private _handler: ((message: ServerMessage) => void) | null = null;
  private _responseInterceptors = new Map<string, (message: RefreshResponseMessage) => void>();

  constructor(ws: WebSocket) {
    this._base = new WebSocketClientTransport(ws);
    this._base.onMessage((message) => {
      if ((message.type === "return" || message.type === "throw") && this._maybeIntercept(message)) {
        return;
      }
      this._handler?.(message);
    });
  }

  send(message: ClientMessage): void {
    this._base.send(message);
  }

  onMessage(handler: (message: ServerMessage) => void): void {
    this._handler = handler;
  }

  onClose(handler: () => void): void {
    this._base.onClose?.(handler);
  }

  dispose(): void {
    this._responseInterceptors.clear();
    this._handler = null;
    this._base.dispose?.();
  }

  interceptResponse(id: string, handler: (message: RefreshResponseMessage) => void): () => void {
    this._responseInterceptors.set(id, handler);
    return () => {
      if (this._responseInterceptors.get(id) === handler) {
        this._responseInterceptors.delete(id);
      }
    };
  }

  private _maybeIntercept(message: RefreshResponseMessage): boolean {
    const handler = this._responseInterceptors.get(message.id);
    if (!handler) return false;
    this._responseInterceptors.delete(message.id);
    handler(message);
    return true;
  }
}

function _getErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "Token refresh failed";
}
