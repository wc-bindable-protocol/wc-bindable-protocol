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

  const interceptingTransport: ServerTransport = {
    send: rawTransport.send.bind(rawTransport),
    onMessage(handler) {
      proxyMessageHandler = handler;
      rawTransport.onMessage((msg: any) => {
        // Intercept auth:refresh before it reaches RemoteShellProxy
        if (msg.type === "cmd" && msg.name === "auth:refresh") {
          const newToken = msg.args?.[0] as string;
          if (!newToken) {
            rawTransport.send({
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
            .then((newUser) => {
              user = newUser;
              sessionExpiresAt = _getExpFromToken(newToken, sessionGraceMs);
              scheduleExpiryCheck();
              onEvent?.({ type: "auth:refresh", user: newUser });
              rawTransport.send({ type: "return", id: msg.id, value: undefined });
            })
            .catch((err) => {
              onEvent?.({
                type: "auth:refresh-failure",
                error: err instanceof Error ? err : new Error(String(err)),
              });
              rawTransport.send({
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
          sessionGraceMs: options.sessionGraceMs,
        },
      );
    } catch (_err) {
      socket.close(1008, "Unauthorized");
    }
  });

  return wss;
}
