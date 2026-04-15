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
 */
export interface AuthEvent {
  type:
    | "auth:success"
    | "auth:failure"
    | "auth:refresh"
    | "auth:refresh-failure"
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
  const { onEvent, sessionGraceMs = 60_000 } = options;

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

  onEvent?.({ type: "auth:success", user });
  onEvent?.({ type: "connection:open", user });

  const initialSub = user.sub;
  const core = options.createCores(user);

  // Parse initial token expiry for session enforcement
  let sessionExpiresAt = _getExpFromToken(token, sessionGraceMs);

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
              sessionExpiresAt = _getExpFromToken(newToken, sessionGraceMs);
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
 * Extract exp from a JWT and add grace period.
 */
function _getExpFromToken(token: string, graceMs: number): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    if (typeof payload.exp === "number") {
      return payload.exp * 1000 + graceMs;
    }
  } catch {
    // Fall through
  }
  return Infinity;
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
        },
      );
    } catch (_err) {
      socket.close(1008, "Unauthorized");
    }
  });

  return wss;
}
