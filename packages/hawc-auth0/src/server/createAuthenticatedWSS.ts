import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import type { ServerTransport } from "@wc-bindable/remote";
import { verifyAuth0Token } from "./verifyAuth0Token.js";
import { extractTokenFromProtocol } from "./extractTokenFromProtocol.js";
import { base64UrlDecode } from "../jwtPayload.js";
import { PROTOCOL_PREFIX } from "../protocolPrefix.js";
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
  /**
   * JWT claim key used to read Auth0 RBAC roles. Forwarded to
   * `verifyAuth0Token` — see `VerifyTokenOptions.rolesClaim` for the
   * full rationale (Auth0's out-of-the-box RBAC emits roles as a
   * namespaced custom claim; setting this option lets deployments
   * using that default configuration surface roles in `UserContext`
   * instead of `UserContext.roles` always being empty).
   */
  rolesClaim?: string;
  createCores: (user: UserContext) => EventTarget;
  proxyOptions?: AuthenticatedConnectionOptions["proxyOptions"];
  /** Observability hook — called for auth and connection lifecycle events. */
  onEvent?: (event: AuthEvent) => void;
  /**
   * Called after `auth:refresh` re-verifies a new token, before the
   * success response is sent to the client. Use this to propagate the
   * refreshed `UserContext` (e.g. updated permissions/roles) into the
   * Core returned by `createCores`.
   *
   * `createCores` returns a SINGLE `EventTarget` per connection — the
   * factory is named in the plural for historical reasons, but the
   * wire protocol binds one proxy per connection, so composing
   * multiple Cores is the caller's responsibility (typically behind a
   * facade `EventTarget` that fans out events). This hook receives
   * that one facade; if the facade owns multiple inner Cores, the
   * implementation is free to forward the refresh to each of them.
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
   * Optional pre-verified user context.
   *
   * Used by `createAuthenticatedWSS` to plumb the result of the
   * pre-handshake `verifyClient` hook through to `handleConnection`,
   * so that `handleConnection` does NOT re-run `verifyAuth0Token`
   * after the upgrade has already completed. When this is set the
   * client's `open` event is a true "server accepted the token"
   * signal — verification happened BEFORE the `101 Switching
   * Protocols` response — which is what keeps `token-changed`
   * subscribers and `getTokenExpiry()` from observing a token the
   * server never accepted.
   *
   * Direct callers of `handleConnection` that own their own HTTP
   * upgrade handling should pre-verify the token in the equivalent
   * of `verifyClient` and pass the result here; omitting it keeps
   * the legacy post-upgrade verification path for backwards
   * compatibility.
   */
  preVerifiedUser?: UserContext;
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

export function _normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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
    preVerifiedUser,
  } = options;

  const token = extractTokenFromProtocol(protocolHeader);
  let user: UserContext;
  if (preVerifiedUser) {
    // Upstream (createAuthenticatedWSS' verifyClient) already ran
    // verifyAuth0Token BEFORE the upgrade response, so the handshake
    // we're now processing was ONLY allowed to reach this point
    // because the token verified cleanly. Skipping re-verification
    // closes the open→close race that otherwise leaks a token the
    // server has not yet accepted to `token-changed` / `getTokenExpiry`.
    user = preVerifiedUser;
  } else {
    try {
      user = await verifyAuth0Token(token, {
        domain: options.auth0Domain,
        audience: options.auth0Audience,
        rolesClaim: options.rolesClaim,
      });
    } catch (err) {
      onEvent?.({ type: "auth:failure", error: _normalizeError(err) });
      throw err;
    }
  }

  // Parse initial token expiry BEFORE emitting auth:success /
  // connection:open and before calling createCores. Under
  // expParseFailurePolicy "close" a parse failure aborts the
  // handshake; doing the parse here avoids leaking the operator's
  // createCores side effects for a connection we're about to reject.
  let initialExpParseFailed = false;
  const initialExpiresAt = _getExpFromToken(token, sessionGraceMs, (e) => {
    initialExpParseFailed = true;
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
    // Always drop the previous timer BEFORE checking whether to schedule
    // a new one. Otherwise a transition from a finite `sessionExpiresAt`
    // to `Infinity` (e.g. `allow` policy + refresh with an unparseable
    // `exp`) would leave the old deadline's timer live, so the
    // connection would be closed with 4401 at the old deadline even
    // though the JSDoc contract for `allow` says enforcement is
    // effectively disabled after parse failure. Clearing first keeps
    // `sessionExpiresAt` the single source of truth for enforcement.
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    if (sessionGraceMs <= 0 || sessionExpiresAt === Infinity) return;
    const delay = Math.max(0, sessionExpiresAt - Date.now());
    expiryTimer = setTimeout(() => {
      socket.close?.(4401, "Session expired");
    }, delay);
  }

  scheduleExpiryCheck();

  // Serialise concurrent `auth:refresh` commands on the same connection.
  // The handler captures `oldExpiresAt = sessionExpiresAt` BEFORE awaiting
  // `onTokenRefresh`; a second refresh that interleaves the first one's
  // `await` would capture a transiently-written-then-rolled-back value as
  // its "previous deadline", producing inconsistent expiry / user /
  // onTokenRefresh ordering on failure. SPEC-REMOTE §3.4.1 does not
  // guarantee serialisation, and the client-side `refreshToken()` only
  // fires one at a time, so rejecting concurrent refreshes is the
  // simplest correct behaviour: clients that genuinely need parallel
  // refreshes can queue them themselves.
  let refreshInFlight = false;

  // Create a transport wrapper that intercepts auth:refresh
  const rawTransport: ServerTransport = new WebSocketServerTransport(socket as any);

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
    // Route every outbound message through `_safeSend` — not just the
    // refresh-path response. `rawTransport.send()` throws synchronously
    // once the peer has transitioned to CLOSING / CLOSED (ws library
    // behaviour), and the send paths that bypass the refresh interceptor
    // (RemoteShellProxy property-change pushes, normal `cmd` responses)
    // would otherwise propagate that throw into the RemoteShellProxy
    // event loop. After a fast client disconnect the proxy's "property
    // changed" notification races the socket close; an unguarded send
    // there surfaces as an `unhandledRejection` / `uncaughtException`
    // under Node and tears down the process. The transport's own close
    // path still fires `dispose()` and the `connection:close` event, so
    // swallowing the synchronous throw is safe and keeps the handler
    // stable regardless of how the proxy chooses to send.
    send: _safeSend,
    onMessage(handler) {
      rawTransport.onMessage((msg: any) => {
        // Intercept auth:refresh before it reaches RemoteShellProxy
        if (msg.type === "cmd" && msg.name === "auth:refresh") {
          // Validate the refresh argument BEFORE handing it to
          // `verifyAuth0Token`. The wire payload is untrusted — a
          // client could send a non-string (number, object) or empty
          // string; an unchecked cast would bubble a confusing jose
          // error through `auth:refresh-failure` instead of the
          // contract-named "Missing token argument" response.
          const rawArg = msg.args?.[0];
          const newToken = typeof rawArg === "string" ? rawArg : "";
          if (!newToken) {
            _safeSend({
              type: "throw",
              id: msg.id,
              error: { name: "Error", message: "Missing token argument" },
            });
            return;
          }
          // Reject concurrent refreshes rather than interleave their
          // rollback paths. See `refreshInFlight` declaration above for
          // the ordering hazard this avoids.
          if (refreshInFlight) {
            _safeSend({
              type: "throw",
              id: msg.id,
              error: {
                name: "Error",
                message: "Token refresh already in progress",
              },
            });
            return;
          }
          refreshInFlight = true;
          verifyAuth0Token(newToken, {
            domain: options.auth0Domain,
            audience: options.auth0Audience,
            rolesClaim: options.rolesClaim,
          })
            .then(async (newUser) => {
              if (newUser.sub !== initialSub) {
                onEvent?.({
                  type: "auth:refresh-failure",
                  error: new Error("Token subject mismatch"),
                });
                // Send a structured `throw` response BEFORE closing the
                // socket so the client's `refreshToken()` promise rejects
                // with a specific "Token subject mismatch" message rather
                // than the generic "WebSocket closed before token refresh
                // completed" that the close handler would otherwise
                // synthesise. Without this, downstream code cannot
                // distinguish a subject-mismatch (a policy failure the
                // application might want to surface explicitly) from a
                // transport-level close triggered by network loss / server
                // restart. `_safeSend` swallows the case where the socket
                // is already CLOSING/CLOSED so the subsequent `close()`
                // remains the authoritative teardown step.
                _safeSend({
                  type: "throw",
                  id: msg.id,
                  error: { name: "Error", message: "Token subject mismatch" },
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
                refreshExpParseFailed = true;
                onEvent?.(e);
              });

              if (refreshExpParseFailed && expParseFailurePolicy === "close") {
                // Reject the refresh and keep the previously honoured
                // deadline. We deliberately do NOT close the whole
                // socket here — the old deadline is finite and will
                // still fire because we `return` BEFORE calling
                // `scheduleExpiryCheck()`, so the original timer
                // scheduled at connection setup remains untouched.
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
                error: _normalizeError(err),
              });
              _safeSend({
                type: "throw",
                id: msg.id,
                error: { name: "Error", message: "Token refresh failed" },
              });
            })
            .finally(() => {
              // Release the re-entrancy guard whether we committed, rolled
              // back, or failed verification. A subsequent `auth:refresh`
              // on the same connection starts fresh against the now-stable
              // `sessionExpiresAt` / `user` state.
              refreshInFlight = false;
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
    // Guard against primitive / null payloads before accessing `exp`
    // — a token like `eyJ...null...` would otherwise crash with
    // `TypeError: Cannot read properties of null`, which the try/catch
    // would then route to `auth:exp-parse-failure` but with a misleading
    // "Cannot read properties of null" message that suggests a code bug
    // rather than a malformed claim.
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      onEvent?.({
        type: "auth:exp-parse-failure",
        error: new Error("JWT payload is not an object"),
      });
      return Infinity;
    }
    const exp = (payload as Record<string, unknown>).exp;
    if (typeof exp === "number") {
      return exp * 1000 + graceMs;
    }
    onEvent?.({
      type: "auth:exp-parse-failure",
      error: new Error("JWT payload has no numeric `exp` claim"),
    });
  } catch (err) {
    onEvent?.({
      type: "auth:exp-parse-failure",
      error: _normalizeError(err),
    });
  }
  return Infinity;
}

/**
 * Convenience factory that creates a `ws.WebSocketServer` with built-in
 * Auth0 token verification, Core construction, in-band refresh, and
 * session expiry enforcement.
 *
 * Requires the `ws` package as a peer dependency.
 *
 * **Token-refresh / Core user propagation contract.**
 * `createCores(user)` is invoked exactly ONCE per WebSocket connection,
 * with the `UserContext` derived from the initial handshake token.
 * Subsequent `auth:refresh` commands re-verify the token and update
 * the server-side `user` binding used for `auth:refresh` event
 * payloads and the `sub` consistency check — but the `EventTarget`
 * returned by `createCores` is NOT reconstructed and does NOT
 * automatically learn the refreshed claims. Any per-connection Core
 * state derived from `UserContext.permissions` / `UserContext.roles`
 * / custom claims is therefore **frozen at the initial token's
 * claims** unless `onTokenRefresh` is wired.
 *
 * Wire `onTokenRefresh: (core, user) => core.updateUser(user)` (for
 * the reference `UserCore`) whenever the Core surfaces
 * token-derived bindable state that can change across refreshes.
 * See SPEC-REMOTE §3.4.1 for the full contract and rollback
 * semantics.
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

  // Plumb the pre-handshake Auth0 verify result to the connection
  // handler. A WeakMap keyed on the request avoids mutating the
  // HTTP IncomingMessage and lets GC reclaim entries if a request
  // never reaches the `connection` event (e.g. upgrade aborted).
  const preVerifiedUsers = new WeakMap<object, UserContext>();

  const wss = new WebSocketServer({
    port: options.port,
    handleProtocols(protocols: Set<string>) {
      for (const proto of protocols) {
        if (proto.startsWith(PROTOCOL_PREFIX)) {
          return proto;
        }
      }
      return false;
    },
    // Verify the Auth0 token (and origin) BEFORE the upgrade response
    // is sent. ws runs `verifyClient` synchronously with the upgrade
    // request: `cb(false, ...)` rejects with an HTTP error status
    // BEFORE `101 Switching Protocols`, so the client never sees an
    // `open` event for an unauthorized token. This closes the window
    // where `AuthShell.connect()` would commit the new token at `open`
    // only to learn via a 1008 close moments later that the server had
    // not actually accepted it — `token-changed` / `getTokenExpiry()`
    // subscribers no longer observe a token the server rejected.
    //
    // Origin check is inlined here so origin rejection is ALSO
    // pre-handshake; the legacy `on("connection")` origin check is
    // kept below as a defense-in-depth guard for direct users who
    // might bypass `verifyClient` via their own upgrade plumbing.
    verifyClient(info: { origin: string; secure: boolean; req: any }, cb: (result: boolean, code?: number, message?: string) => void): void {
      if (options.allowedOrigins && options.allowedOrigins.length > 0) {
        const origin = info.req.headers.origin;
        if (!origin || !options.allowedOrigins.includes(origin)) {
          cb(false, 403, "Forbidden origin");
          return;
        }
      }
      const protocolHeader = info.req.headers["sec-websocket-protocol"];
      let token: string;
      try {
        token = extractTokenFromProtocol(protocolHeader);
      } catch (err) {
        options.onEvent?.({
          type: "auth:failure",
          error: _normalizeError(err),
        });
        cb(false, 401, "Unauthorized");
        return;
      }
      verifyAuth0Token(token, {
        domain: options.auth0Domain,
        audience: options.auth0Audience,
        rolesClaim: options.rolesClaim,
      })
        .then((user) => {
          preVerifiedUsers.set(info.req, user);
          cb(true);
        })
        .catch((err) => {
          options.onEvent?.({
            type: "auth:failure",
            error: _normalizeError(err),
          });
          cb(false, 401, "Unauthorized");
        });
    },
  } as any);

  wss.on("connection", async (socket, req) => {
    // Origin check retained as defense-in-depth. When verifyClient runs
    // (the normal path under this factory), a disallowed origin has
    // already been rejected pre-handshake, so this branch is a no-op.
    // Direct users that compose `WebSocketServer` differently still
    // get origin enforcement here.
    if (options.allowedOrigins && options.allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      if (!origin || !options.allowedOrigins.includes(origin)) {
        socket.close(1008, "Forbidden origin");
        return;
      }
    }

    try {
      const preVerifiedUser = preVerifiedUsers.get(req);
      preVerifiedUsers.delete(req);
      await handleConnection(
        socket as unknown as WebSocketLike,
        req.headers["sec-websocket-protocol"],
        {
          auth0Domain: options.auth0Domain,
          auth0Audience: options.auth0Audience,
          rolesClaim: options.rolesClaim,
          createCores: options.createCores,
          proxyOptions: options.proxyOptions,
          onEvent: options.onEvent,
          onTokenRefresh: options.onTokenRefresh,
          sessionGraceMs: options.sessionGraceMs,
          expParseFailurePolicy: options.expParseFailurePolicy,
          preVerifiedUser,
        },
      );
    } catch (_err) {
      socket.close(1008, "Unauthorized");
    }
  });

  return wss;
}
