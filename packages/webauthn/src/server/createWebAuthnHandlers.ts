import { WebAuthnCore } from "../core/WebAuthnCore.js";
import { WebAuthnUser } from "../types.js";
import { HttpError, _statusFromError } from "./HttpError.js";

// base64url alphabet (no padding). Used to sanity-check credential.id /
// credential.rawId on the verify path BEFORE handing the payload to the
// Core — the Core's verifier would throw later, but surfacing the
// malformed-wire case as a 400 here avoids a misleading stack trace and
// stops the Core from consuming the challenge slot on garbage input.
const _BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Validate the `credential` envelope the Shell POSTs to the verify
 * endpoint. Returns a human-readable reason for rejection, or `null`
 * when the shape is acceptable to hand to the Core.
 *
 * Rationale: the Core trusts its caller for structural integrity — it
 * fishes `response.id` and `response.response.*` out of the object on
 * the assumption that the Shell serialized them properly. If a client
 * (malicious or buggy) ships a wildly wrong shape, the Core would
 * either throw a cryptic `TypeError` or worse — consume the challenge
 * slot and then fail. Catching it here keeps the challenge intact and
 * the error comprehensible.
 */
function _validateCredentialShape(
  credential: any,
  mode: "register" | "authenticate",
): string | null {
  if (!credential || typeof credential !== "object") {
    return "credential is required";
  }
  if (typeof credential.id !== "string" || !_BASE64URL.test(credential.id)) {
    return "credential.id must be a non-empty base64url string";
  }
  if (typeof credential.rawId !== "string" || !_BASE64URL.test(credential.rawId)) {
    return "credential.rawId must be a non-empty base64url string";
  }
  // The WebAuthn spec defines `id` and `rawId` as two encodings of the
  // same credential id bytes: `rawId` is the raw ArrayBuffer and `id`
  // is its base64url encoding (both surfaced on `PublicKeyCredential`).
  // The Shell always serializes them from the same source, so they
  // MUST match. A payload where they differ is malformed — either a
  // buggy client, a mitm that rewrote one but not the other, or a
  // deliberate probe trying to get the verifier to pick one but the
  // store lookup to use the other. Rejecting here closes that confusion
  // vector before the Core takes the challenge slot.
  if (credential.id !== credential.rawId) {
    return "credential.id and credential.rawId must be equal (both encode the same credential id bytes)";
  }
  if (credential.type !== "public-key") {
    return "credential.type must be \"public-key\"";
  }
  const resp = credential.response;
  if (!resp || typeof resp !== "object") {
    return "credential.response is required";
  }
  if (typeof resp.clientDataJSON !== "string" || !_BASE64URL.test(resp.clientDataJSON)) {
    return "credential.response.clientDataJSON must be a base64url string";
  }
  if (mode === "register") {
    if (typeof resp.attestationObject !== "string" || !_BASE64URL.test(resp.attestationObject)) {
      return "credential.response.attestationObject must be a base64url string";
    }
  } else {
    if (typeof resp.authenticatorData !== "string" || !_BASE64URL.test(resp.authenticatorData)) {
      return "credential.response.authenticatorData must be a base64url string";
    }
    if (typeof resp.signature !== "string" || !_BASE64URL.test(resp.signature)) {
      return "credential.response.signature must be a base64url string";
    }
  }
  return null;
}

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
        // this is" — most often a 401/403. Honor caller-supplied status
        // AND message only when the thrown value is an HttpError (or any
        // Error with a well-formed `.status`) — that's the application
        // explicitly opting in to a specific user-facing message. For
        // every other throw, collapse the response body to the fixed
        // "unauthorized" string to avoid leaking internal decode /
        // parsing details to unauthenticated callers.
        return _json({ error: _clientMessage(e, "unauthorized") }, _statusFromError(e) ?? 401);
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
        //
        // Message surface: honor `e.message` when the error carries a
        // caller-supplied `.status` (HttpError is the common case) — the
        // application has explicitly decided the message is safe to show.
        // Otherwise fall back to the generic "challenge failed" string so
        // we do not relay raw internal errors (e.g. DB driver messages,
        // file paths from stack traces). Callers that want a specific
        // public-facing message should throw an HttpError.
        return _json(
          { error: _clientMessage(e, "challenge failed") },
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
        return _json({ error: _clientMessage(e, "unauthorized") }, _statusFromError(e) ?? 401);
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
      // Reject unknown modes up front. Doing this BEFORE the shape /
      // presence checks eliminates the earlier two-layer "credential is
      // required → unknown mode" cascade where an unknown-mode request
      // without a credential would report the wrong reason. Also gives
      // the Core a clean invariant: by the time we reach it `mode` is
      // one of the two documented values.
      if (mode !== "register" && mode !== "authenticate") {
        return _json({ error: `unknown mode: ${mode}` }, 400);
      }
      // Shape-check the credential envelope before the Core ever sees
      // it. The Core's verifier would eventually throw on a wildly wrong
      // shape, but only AFTER it took() the session's challenge slot —
      // meaning a malformed client payload could consume a legitimate
      // challenge and force the user to restart the ceremony. Reject
      // structural issues up-front so the challenge stays alive for a
      // retry with a well-formed payload.
      {
        const reason = _validateCredentialShape(credential, mode);
        if (reason) return _json({ error: reason }, 400);
      }

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
        } else {
          record = await core.verifyAuthentication(sessionId, credential);
        }
      } catch (e: any) {
        // Core's `_failVerify` marks its errors with `clientVisible: true`
        // so we surface them verbatim ("no active challenge", "challenge
        // expired", "mode mismatch", etc.) — those are the documented
        // public-facing protocol messages. Every other throw (verifier
        // internals from @simplewebauthn/server, TypeError from malformed
        // data, DB / store outages) goes through `_clientMessage` so
        // internal details stay off the wire. Prior shape leaked the raw
        // exception message unconditionally.
        return _json(
          { error: _clientMessage(e, "verify failed") },
          _statusFromError(e) ?? 400,
        );
      }

      let user: WebAuthnUser | null = null;
      if (resolveUser) {
        try {
          user = (await resolveUser(record.userId)) ?? null;
        } catch (e: any) {
          // Same HttpError-only message policy as the challenge catch:
          // preserve caller-supplied messages (HttpError, Error with
          // `.status`) but mask plain internal failures behind the fixed
          // "user lookup failed" string. Prevents DB driver / stack
          // trace fragments from leaking to unauthenticated callers.
          return _json(
            { error: _clientMessage(e, "user lookup failed") },
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

/**
 * Pick a safe response body message for a caught exception.
 *
 * Returns `e.message` ONLY when the application explicitly opted in via
 * one of three markers:
 *   1. `HttpError` — canonical handler-level opt-in.
 *   2. Any Error with a valid numeric `.status` — typed-error apps that
 *      do not import `HttpError`.
 *   3. Any Error with `clientVisible === true` — Core's `_failVerify`
 *      tags its protocol errors with this so the verify catch can relay
 *      them without special-casing the Core class. Also available to
 *      application code that wants to mark a specific error as
 *      safe-to-surface without attaching a status.
 *
 * Every other throw — plain `Error`, third-party library exceptions,
 * DB-driver messages with file paths / connection strings — collapses
 * to the generic `fallback` string, preventing internal details from
 * leaking to unauthenticated callers.
 */
function _clientMessage(e: unknown, fallback: string): string {
  if (e instanceof HttpError) {
    return typeof e.message === "string" && e.message.length > 0 ? e.message : fallback;
  }
  if (_statusFromError(e) !== undefined) {
    // Error with caller-supplied `.status` — treat as application-
    // explicit just like HttpError. A typed-error-using app that does
    // not import HttpError should still be able to surface its own
    // messages to clients.
    const msg = (e as any)?.message;
    return typeof msg === "string" && msg.length > 0 ? msg : fallback;
  }
  if (e && typeof e === "object" && (e as any).clientVisible === true) {
    // Core-side `_failVerify` opt-in: messages like "no active
    // challenge for this session", "challenge expired", "mode
    // mismatch" are the documented public-facing protocol surface and
    // MUST be relayed so the Shell can produce a meaningful retry.
    const msg = (e as any).message;
    return typeof msg === "string" && msg.length > 0 ? msg : fallback;
  }
  return fallback;
}
