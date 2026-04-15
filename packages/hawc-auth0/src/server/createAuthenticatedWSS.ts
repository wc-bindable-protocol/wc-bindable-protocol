import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import type { ServerTransport } from "@wc-bindable/remote";
import { verifyAuth0Token } from "./verifyAuth0Token.js";
import { extractTokenFromProtocol } from "./extractTokenFromProtocol.js";
import type { AuthenticatedConnectionOptions, UserContext } from "../types.js";

/**
 * WebSocket-like interface accepted by `WebSocketServerTransport`.
 * Works with the `ws` library, Deno, and Node 22+ built-in WebSocket.
 */
interface WebSocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (...args: any[]) => void): void;
  on?(type: string, listener: (...args: any[]) => void): void;
}

/**
 * Observability event emitted by the connection handler.
 *
 * `auth:exp-parse-failure` fires when the JWT payload cannot be decoded
 * or lacks a numeric `exp` claim. What happens next depends on
 * `expParseFailurePolicy`:
 *
 * - `"allow"` (default): the connection proceeds, but server-side session
 *   expiry enforcement is effectively disabled for that connection
 *   (`sessionExpiresAt` falls back to `Infinity`). The event is the only
 *   signal — subscribe to log, alert, or close the socket imperatively.
 * - `"close"`: the connection is rejected.
 *   - On the initial handshake, `auth:exp-parse-failure` is followed by
 *     `auth:failure` and `handleConnection` throws; the caller
 *     (e.g. `createAuthenticatedWSS`) closes the socket with
 *     `1008 Unauthorized`. `createCores` is **not** called.
 *   - On in-band `auth:refresh`, the refresh is rejected with a `throw`
 *     response and `auth:refresh-failure`; the previously honoured
 *     deadline stays in effect and the connection closes at the
 *     original `exp + sessionGraceMs`.
 *
 * See `HandleConnectionOptions.expParseFailurePolicy` for the knob.
 */
export interface AuthEvent {
  type:
    | "auth:success"
    | "auth:failure"
    | "auth:refresh"
    | "auth:refresh-failure"
    | "auth:exp-parse-failure"
    | "connection:open"
    | "connection:close";
  user?: UserContext;
  error?: Error;
}

export interface HandleConnectionOptions {
  auth0Domain: string;
  auth0Audience: string;
  createCores: (user: UserContext) => EventTarget;
  proxyOptions?: AuthenticatedConnectionOptions["proxyOptions"];
  /** Observability hook — called for auth and connection lifecycle events. */
  onEvent?: (event: AuthEvent) => void;
  /**
   * Called after `auth:refresh` re-verifies a new token, before the
   * success response is sent to the client. Use this to propagate the
   * refreshed `UserContext` (e.g. updated permissions/roles) into the
   * Core(s) returned by `createCores`. The library does not presume any
   * particular Core shape.
   *
   * May be sync or async. When async, the handler is awaited and the
   * commit only proceeds if it resolves; any rejection (or sync throw)
   * rolls back the refresh exactly like a sync failure — the client
   * receives `throw`, no session state advances, and an
   * `auth:refresh-failure` event fires.
   *
   * For the reference `UserCore`, pass `(core, user) => core.updateUser(user)`.
   */
  onTokenRefresh?: (core: EventTarget, user: UserContext) => void | Promise<void>;
  /**
   * Grace period (ms) after token `exp` before the server forcefully
   * closes the connection. Set to 0 to disable server-side expiry
   * enforcement. Default: 60000 (60 seconds).
   */
  sessionGraceMs?: number;
  /**
   * Policy for handling JWT `exp` claim parse failures.
   *
   * - `"allow"` (default): parse failure falls back to `Infinity`, so
   *   server-side expiry enforcement is disabled **for that connection**.
   *   The failure is still observable via `auth:exp-parse-failure`.
   *   Preserves backward compatibility and lets operators decide policy
   *   out-of-band by subscribing to `onEvent`.
   * - `"close"`: parse failure rejects the connection.
   *   - **Initial handshake:** `auth:exp-parse-failure` is emitted,
   *     then `auth:failure` fires and `handleConnection` throws — the
   *     caller (e.g. `createAuthenticatedWSS`) closes the socket.
   *   - **In-band `auth:refresh`:** the refresh is rejected with a
   *     `throw` response and `auth:refresh-failure`. The previously
   *     honoured deadline stays in effect, so the connection still
   *     closes at the original expiry and never runs unbounded.
   *
   * Choose `"close"` for deployments that must guarantee bounded
   * session lifetime even when IdP claim shapes drift unexpectedly.
   */
  expParseFailurePolicy?: "allow" | "close";
}

/**
 * Low-level primitive: verify the token from the protocol header,
 * construct the Core, and wrap it in a `RemoteShellProxy`.
 *
 * Intercepts `auth:refresh` commands at the transport layer before
 * they reach RemoteShellProxy, re-verifies the token, and updates
 * the session expiry without reconstructing Cores.
 *
 * Works with any WebSocket implementation — no dependency on `ws`.
 *
 * @returns The created `RemoteShellProxy` (useful for lifecycle management).
 */
export async function handleConnection(
  socket: WebSocketLike,
  protocolHeader: string | string[] | undefined,
  options: HandleConnectionOptions,
): Promise<RemoteShellProxy> {
  const {
    onEvent,
    sessionGraceMs = 60_000,
    expParseFailurePolicy = "allow",
  } = options;

  const token = extractTokenFromProtocol(protocolHeader);
  let user: UserContext;
  try {
    user = await verifyAuth0Token(token, {
      domain: options.auth0Domain,
      audience: options.auth0Audience,
    });
  } catch (err) {
    onEvent?.({ type: "auth:failure", error: err instanceof Error ? err : new Error(String(err)) });
    throw err;
  }

  // Parse initial token expiry BEFORE emitting auth:success /
  // connection:open and before calling createCores. Under
  // expParseFailurePolicy "close" a parse failure aborts the
  // handshake; doing the parse here avoids leaking the operator's
  // createCores side effects for a connection we're about to reject.
  let initialExpParseFailed = false;
  const initialExpiresAt = _getExpFromToken(token, sessionGraceMs, (e) => {
    if (e.type === "auth:exp-parse-failure") initialExpParseFailed = true;
    onEvent?.(e);
  });

  if (initialExpParseFailed && expParseFailurePolicy === "close") {
    const err = new Error(
      "[@wc-bindable/hawc-auth0] JWT exp claim unparseable under 'close' policy; rejecting connection.",
    );
    onEvent?.({ type: "auth:failure", error: err });
    throw err;
  }

  onEvent?.({ type: "auth:success", user });
  onEvent?.({ type: "connection:open", user });

  const initialSub = user.sub;
  const core = options.createCores(user);

  let sessionExpiresAt = initialExpiresAt;

  // Set up session expiry timer
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleExpiryCheck() {
    if (sessionGraceMs <= 0 || sessionExpiresAt === Infinity) return;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    const delay = Math.max(0, sessionExpiresAt - Date.now());
    expiryTimer = setTimeout(() => {
      socket.close?.(4401, "Session expired");
    }, delay);
  }

  scheduleExpiryCheck();

  // Create a transport wrapper that intercepts auth:refresh
  const rawTransport: ServerTransport = new WebSocketServerTransport(socket as any);
  let proxyMessageHandler: ((msg: any) => void) | null = null;

  // `rawTransport.send()` can throw synchronously once the peer has
  // already closed (e.g. `ws` throws on a CLOSING/CLOSED socket).
  // The refresh chain has no realistic recovery — the client is gone,
  // delivery cannot succeed — and an unguarded throw in the success
  // path would propagate into the chain's `.catch`, which would then
  // call send() a *second* time and either re-throw or emit a
  // protocol-violating duplicate response (a `throw` after a `return`
  // for the same id). The transport's own close path will fire the
  // server-side `dispose()` cycle and emit `connection:close`, so
  // swallowing here is safe and keeps the handler stable.
  function _safeSend(message: any): void {
    try {
      rawTransport.send(message);
    } catch {
      // intentionally ignored — see comment above
    }
  }

  const interceptingTransport: ServerTransport = {
    send: rawTransport.send.bind(rawTransport),
    onMessage(handler) {
      proxyMessageHandler = handler;
      rawTransport.onMessage((msg: any) => {
        // Intercept auth:refresh before it reaches RemoteShellProxy
        if (msg.type === "cmd" && msg.name === "auth:refresh") {
          const newToken = msg.args?.[0] as string;
          if (!newToken) {
            _safeSend({
              type: "throw",
              id: msg.id,
              error: { name: "Error", message: "Missing token argument" },
            });
            return;
          }
          verifyAuth0Token(newToken, {
            domain: options.auth0Domain,
            audience: options.auth0Audience,
          })
            .then(async (newUser) => {
              if (newUser.sub !== initialSub) {
                onEvent?.({
                  type: "auth:refresh-failure",
                  error: new Error("Token subject mismatch"),
                });
                socket.close?.(4403, "Token subject mismatch");
                return;
              }
              // Pre-extend the session expiry BEFORE awaiting the hook.
              // The token has already passed JWT verification and the sub
              // check, so it is provably acceptable; the hook only decides
              // whether to publish the new claims into the Core, not
              // whether the connection is allowed to live longer. Without
              // this pre-extension, a slow async hook (external I/O,
              // policy lookup) can be killed mid-execution by the old
              // expiry timer firing 4401 against a legitimate refresh.
              // On hook failure we roll the expiry back so the deadline
              // the server actually honoured still applies.
              const oldExpiresAt = sessionExpiresAt;
              let refreshExpParseFailed = false;
              sessionExpiresAt = _getExpFromToken(newToken, sessionGraceMs, (e) => {
                if (e.type === "auth:exp-parse-failure") refreshExpParseFailed = true;
                onEvent?.(e);
              });

              if (refreshExpParseFailed && expParseFailurePolicy === "close") {
                // Reject the refresh and keep the previously honoured
                // deadline. We deliberately do NOT close the whole
                // socket here — the old deadline is finite and will
                // still fire (the existing timer was not cleared,
                // because _getExpFromToken returned Infinity and
                // scheduleExpiryCheck early-returned on Infinity).
                // That preserves the "no unbounded session" invariant
                // that `expParseFailurePolicy: "close"` is meant to
                // uphold, without tearing down a session that was
                // otherwise still legitimate up to its original exp.
                sessionExpiresAt = oldExpiresAt;
                onEvent?.({
                  type: "auth:refresh-failure",
                  error: new Error(
                    "JWT exp claim unparseable under 'close' policy; refresh rejected.",
                  ),
                });
                _safeSend({
                  type: "throw",
                  id: msg.id,
                  error: {
                    name: "Error",
                    message: "Token refresh failed: exp claim unparseable",
                  },
                });
                return;
              }

              scheduleExpiryCheck();

              // Run the hook as part of the commit path: if it throws
              // (sync) or rejects (async), the refreshed session must
              // NOT be applied, otherwise the connection silently moves
              // forward while the client thinks the refresh failed and
              // the Core stays stale. `await` covers both cases — sync
              // throws are converted to a rejected microtask by async,
              // and `await undefined` is a no-op when no hook is wired.
              try {
                await options.onTokenRefresh?.(core, newUser);
              } catch (hookErr) {
                // Roll back the session expiry so the connection still
                // respects the previously honoured deadline, matching
                // the rollback of `user` / refresh event publication.
                sessionExpiresAt = oldExpiresAt;
                scheduleExpiryCheck();
                onEvent?.({
                  type: "auth:refresh-failure",
                  error: hookErr instanceof Error ? hookErr : new Error(String(hookErr)),
                });
                _safeSend({
                  type: "throw",
                  id: msg.id,
                  error: { name: "Error", message: "Token refresh hook failed" },
                });
                return;
              }
              user = newUser;
              // sessionExpiresAt + timer are already at the new value.
              onEvent?.({ type: "auth:refresh", user: newUser });
              _safeSend({ type: "return", id: msg.id, value: undefined });
            })
            .catch((err) => {
              onEvent?.({
                type: "auth:refresh-failure",
                error: err instanceof Error ? err : new Error(String(err)),
              });
              _safeSend({
                type: "throw",
                id: msg.id,
                error: { name: "Error", message: "Token refresh failed" },
              });
            });
          return; // Do not forward to RemoteShellProxy
        }
        // Forward all other messages to the proxy
        handler(msg);
      });
    },
    onClose: rawTransport.onClose?.bind(rawTransport),
    dispose() {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      onEvent?.({ type: "connection:close", user });
      rawTransport.dispose?.();
    },
  };

  return new RemoteShellProxy(core, interceptingTransport, options.proxyOptions);
}

/**
 * Extract `exp` from a JWT payload and add the configured grace period.
 *
 * Returns `Infinity` when the payload cannot be decoded or has no numeric
 * `exp` claim, and reports the failure through `onEvent` as
 * `auth:exp-parse-failure`. How the caller reacts to that event is
 * governed by `expParseFailurePolicy`: `"allow"` keeps the connection
 * alive with expiry enforcement effectively disabled, while `"close"`
 * rejects the initial handshake (and rejects in-band refreshes) — see
 * `HandleConnectionOptions.expParseFailurePolicy` and the `AuthEvent`
 * doc. The regression this observability hook prevents: before it was
 * wired up, any non-Node runtime without global `Buffer` would throw
 * inside the decoder, hit the catch, and disable expiry silently.
 *
 * The decoder is runtime-agnostic: `atob` (available in browsers, Deno,
 * Bun, Cloudflare Workers, and Node 16+) is preferred; `Buffer` is only
 * used as a fallback for older Node where `atob` is absent.
 */
function _getExpFromToken(
  token: string,
  graceMs: number,
  onEvent?: (event: AuthEvent) => void,
): number {
  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      onEvent?.({
        type: "auth:exp-parse-failure",
        error: new Error("Invalid JWT format: missing payload segment"),
      });
      return Infinity;
    }
    const payload = JSON.parse(_base64UrlDecode(parts[1]));
    if (typeof payload.exp === "number") {
      return payload.exp * 1000 + graceMs;
    }
    onEvent?.({
      type: "auth:exp-parse-failure",
      error: new Error("JWT payload has no numeric `exp` claim"),
    });
  } catch (err) {
    onEvent?.({
      type: "auth:exp-parse-failure",
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
  return Infinity;
}

/**
 * Runtime-agnostic base64url decoder. Returns a binary string suitable
 * for `JSON.parse` when the payload is ASCII-compatible JSON (JWT `exp`
 * extraction only reads a numeric claim, so binary-string decoding is
 * sufficient here).
 */
function _base64UrlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") return atob(base64);
  // Node ≤ 15 fallback (Node 16+ exposes a global `atob`).
  return Buffer.from(base64, "base64").toString("binary");
}

const PROTOCOL_PREFIX = "hawc-auth0.bearer.";

/**
 * Convenience factory that creates a `ws.WebSocketServer` with built-in
 * Auth0 token verification, Core construction, in-band refresh, and
 * session expiry enforcement.
 *
 * Requires the `ws` package as a peer dependency.
 */
export async function createAuthenticatedWSS(
  options: AuthenticatedConnectionOptions & {
    port?: number;
    onEvent?: (event: AuthEvent) => void;
    sessionGraceMs?: number;
    expParseFailurePolicy?: "allow" | "close";
  },
) {
  const { WebSocketServer } = await import("ws");

  const wss = new WebSocketServer({
    port: options.port,
    handleProtocols(protocols) {
      for (const proto of protocols) {
        if (proto.startsWith(PROTOCOL_PREFIX)) {
          return proto;
        }
      }
      return false;
    },
  });

  wss.on("connection", async (socket, req) => {
    // Origin check
    if (options.allowedOrigins && options.allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      if (!origin || !options.allowedOrigins.includes(origin)) {
        socket.close(1008, "Forbidden origin");
        return;
      }
    }

    try {
      await handleConnection(
        socket as unknown as WebSocketLike,
        req.headers["sec-websocket-protocol"],
        {
          auth0Domain: options.auth0Domain,
          auth0Audience: options.auth0Audience,
          createCores: options.createCores,
          proxyOptions: options.proxyOptions,
          onEvent: options.onEvent,
          onTokenRefresh: options.onTokenRefresh,
          sessionGraceMs: options.sessionGraceMs,
          expParseFailurePolicy: options.expParseFailurePolicy,
        },
      );
    } catch (_err) {
      socket.close(1008, "Unauthorized");
    }
  });

  return wss;
}
