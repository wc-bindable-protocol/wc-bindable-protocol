import { WebAuthnCore } from "../core/WebAuthnCore.js";
import { WebAuthnUser } from "../types.js";
import { _statusFromError } from "./HttpError.js";

export interface WebAuthnHandlers {
  challenge(request: Request): Promise<Response>;
  verify(request: Request): Promise<Response>;
}

export interface CreateWebAuthnHandlersOptions {
  /**
   * Resolve a stable per-session identifier from the incoming request.
   * Typically cookie-derived. Without a stable sessionId the challenge
   * store cannot bind challenges to a specific browser — two concurrent
   * ceremonies would clobber each other's slot. Return `null` to reject
   * the request with 401, or throw an `HttpError(status, message)` to
   * surface a different status (e.g. 403 for a banned IP).
   */
  resolveSessionId(request: Request): string | null | Promise<string | null>;
  /**
   * Optional: map the verified credential back to a user descriptor that
   * the Shell should show. If omitted, verify() returns `{ credentialId }`
   * only and the Shell reads whatever user context it already has.
   */
  resolveUser?(userId: string): WebAuthnUser | null | Promise<WebAuthnUser | null>;
  /**
   * Registration only. The challenge POST carries a `user` body the caller
   * supplies — but trusting it verbatim would let a malicious client
   * register passkeys against other users. This hook lets the application
   * normalize / override the user based on session state (e.g. pin
   * user.id to the currently-signed-in account).
   *
   * Throw `HttpError(401, "...")` (or any Error with a `.status`) for
   * authentication failures — the handler surfaces the status verbatim
   * instead of collapsing to 500. Without this, the README pattern
   * `requireSignedInUser(req)` becomes "internal server error" for an
   * unauthenticated user, which both misleads the consumer and pollutes
   * 5xx infra alerts.
   */
  normalizeRegistrationUser?(request: Request, proposed: WebAuthnUser): WebAuthnUser | Promise<WebAuthnUser>;
  /**
   * Registration only. Return the credentialIds (base64url) the user
   * already has registered, so the option blob's `excludeCredentials`
   * list tells the browser to refuse re-enrollment of an existing
   * authenticator. The browser surfaces this as "you've already
   * registered this device" instead of producing a fresh attestation
   * the Core would then have to reject at verify time. The Core also
   * applies a server-side duplicate guard at verify, so omitting this
   * hook is safe — but doing so loses the better browser-side UX.
   */
  listExistingCredentials?(request: Request, userId: string): string[] | Promise<string[]>;
  /**
   * Authenticate only. Resolve the userId whose credentials should be
   * surfaced in `allowCredentials`, given the request and the
   * (untrusted) `userId` the client sent in the body.
   *
   * Without this hook the handler **ignores the client's userId
   * entirely** and falls through to the usernameless / discoverable-
   * credential flow (`allowCredentials: []`). That default exists to
   * close an enumeration vector: returning credentials based on a
   * client-supplied id lets any unauthenticated caller probe arbitrary
   * userIds and learn (a) whether a user has passkeys, (b) the actual
   * credential ids, and (c) the transports — both an info leak and an
   * authz footgun for step-up flows that mistakenly trust the body id.
   *
   * Wire this hook to opt in to userId-targeted authentication. Common
   * shapes:
   *   - Step-up: pin the userId to the signed-in session and refuse
   *     mismatch:  `(req, body) => { const me = requireUser(req); if (body && body !== me) throw new HttpError(403,"…"); return me; }`
   *   - Passwordless after username entry: only honor body userId after
   *     a separate "username submitted" step has produced an auth-ticket
   *     cookie that this hook reads from `req`.
   *
   * Return `null` to force usernameless. Throw `HttpError(...)` to
   * fail fast with a specific status.
   */
  resolveAuthenticationUserId?(
    request: Request,
    requestedUserId: string | undefined,
  ): string | null | Promise<string | null>;
}

/**
 * Thin adapter that exposes `WebAuthnCore` as two Fetch-API handlers.
 * Framework-agnostic: works under any server that speaks `Request` /
 * `Response` (Node 18+ native HTTP with `createServer` + a tiny adapter,
 * Bun, Deno, Cloudflare Workers, Hono, Fastify-fetch, Next.js app router).
 *
 * Why both endpoints on one factory and not separate functions: the two
 * sides of the ceremony share sessionId resolution and CORS / cookie
 * policy, and routing them through a single factory makes it impossible
 * to deploy one handler against one core and the other against another.
 */
export function createWebAuthnHandlers(
  core: WebAuthnCore,
  options: CreateWebAuthnHandlersOptions,
): WebAuthnHandlers {
  const {
    resolveSessionId, resolveUser, normalizeRegistrationUser,
    listExistingCredentials, resolveAuthenticationUserId,
  } = options;

  return {
    async challenge(request: Request): Promise<Response> {
      if (request.method !== "POST") {
        return _json({ error: "method not allowed" }, 405);
      }
      let sessionId: string | null;
      try {
        sessionId = await resolveSessionId(request);
      } catch (e: any) {
        // resolveSessionId is allowed to throw for "I cannot decide who
        // this is" — most often a 401/403. Honor caller-supplied status,
        // default to 401 (it is the session-resolution endpoint after all).
        return _json({ error: e?.message || "unauthorized" }, _statusFromError(e) ?? 401);
      }
      if (!sessionId) return _json({ error: "session required" }, 401);

      let body: any;
      try {
        body = await request.json();
      } catch {
        return _json({ error: "invalid json body" }, 400);
      }
      const mode = body?.mode;

      try {
        if (mode === "register") {
          const proposed: WebAuthnUser | undefined = body?.user;
          if (!proposed?.id || !proposed?.name || !proposed?.displayName) {
            return _json({ error: "user.id/name/displayName are required for registration" }, 400);
          }
          const user = normalizeRegistrationUser
            ? await normalizeRegistrationUser(request, proposed)
            : proposed;
          const existing = listExistingCredentials
            ? await listExistingCredentials(request, user.id)
            : [];
          const optionsBlob = await core.createRegistrationChallenge(sessionId, user, existing);
          return _json(optionsBlob, 200);
        }
        if (mode === "authenticate") {
          // Safe-by-default: ignore client-supplied userId unless the
          // application explicitly opts in through resolveAuthenticationUserId.
          // Without the hook, untargeted authentication (allowCredentials: [])
          // is forced — the browser falls back to the usernameless /
          // discoverable-credential flow and the server cannot be made to
          // enumerate other users' credential ids on behalf of an
          // unauthenticated caller.
          const requestedUserId: string | undefined = body?.userId;
          const targetUserId = resolveAuthenticationUserId
            ? (await resolveAuthenticationUserId(request, requestedUserId)) ?? undefined
            : undefined;
          const optionsBlob = await core.createAuthenticationChallenge(sessionId, targetUserId);
          return _json(optionsBlob, 200);
        }
        return _json({ error: `unknown mode: ${mode}` }, 400);
      } catch (e: any) {
        // Caller-supplied status wins. Without this every auth/permission
        // failure inside a hook collapses into 500, which both misleads
        // operators and corrupts 5xx-based infra alerts. Default 500 only
        // for genuinely unexpected exceptions.
        return _json(
          { error: e?.message || "challenge failed" },
          _statusFromError(e) ?? 500,
        );
      }
    },

    async verify(request: Request): Promise<Response> {
      if (request.method !== "POST") {
        return _json({ error: "method not allowed" }, 405);
      }
      let sessionId: string | null;
      try {
        sessionId = await resolveSessionId(request);
      } catch (e: any) {
        return _json({ error: e?.message || "unauthorized" }, _statusFromError(e) ?? 401);
      }
      if (!sessionId) return _json({ error: "session required" }, 401);

      let body: any;
      try {
        body = await request.json();
      } catch {
        return _json({ error: "invalid json body" }, 400);
      }
      const mode = body?.mode;
      const credential = body?.credential;
      if (!credential) return _json({ error: "credential is required" }, 400);

      // Verify and resolveUser have DIFFERENT default statuses on failure
      // and must not share a catch — collapsing them (the prior shape)
      // turned a DB outage inside `resolveUser` into a 400 and silently
      // hid 5xx events from monitoring. Verify failures are almost always
      // client-caused (expired challenge, wrong origin, replayed
      // credential) → default 400. resolveUser is application territory
      // (DB / cache / external IdP) → default 500, so infra alerts tuned
      // on 5xx still fire. Caller-supplied status via HttpError /
      // `.status` wins in both cases.
      let record;
      try {
        if (mode === "register") {
          record = await core.verifyRegistration(sessionId, credential);
        } else if (mode === "authenticate") {
          record = await core.verifyAuthentication(sessionId, credential);
        } else {
          return _json({ error: `unknown mode: ${mode}` }, 400);
        }
      } catch (e: any) {
        return _json(
          { error: e?.message || "verify failed" },
          _statusFromError(e) ?? 400,
        );
      }

      let user: WebAuthnUser | null = null;
      if (resolveUser) {
        try {
          user = (await resolveUser(record.userId)) ?? null;
        } catch (e: any) {
          return _json(
            { error: e?.message || "user lookup failed" },
            _statusFromError(e) ?? 500,
          );
        }
      }
      return _json({ credentialId: record.credentialId, user }, 200);
    },
  };
}

function _json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
