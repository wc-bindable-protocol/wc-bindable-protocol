import { createRemoteJWKSet, jwtVerify } from "jose";
import type { VerifyTokenOptions, UserContext } from "../types.js";

/**
 * JWKS keyed by issuer URL. `createRemoteJWKSet` already caches the
 * fetched keys internally based on HTTP cache headers, so a single
 * instance per domain is sufficient.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Verify an Auth0 access token and return the authenticated user context.
 *
 * Uses the Auth0 JWKS endpoint for RS256 signature verification and
 * validates `iss`, `aud`, `exp`, `iat`, and `nbf` claims.
 */
export async function verifyAuth0Token(
  token: string,
  options: VerifyTokenOptions,
): Promise<UserContext> {
  const { domain, audience, rolesClaim } = options;
  const issuer = `https://${domain}/`;
  const jwksUri = `${issuer}.well-known/jwks.json`;

  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience,
  });

  if (!payload.sub) {
    throw new Error("[@wc-bindable/hawc-auth0] JWT payload missing 'sub' claim.");
  }

  const payloadRec = payload as Record<string, unknown>;
  // SPEC-REMOTE §4.2 documents the default shape as
  // `payload["https://{namespace}/roles"]` because Auth0 reserves
  // non-namespaced claims for its OIDC payload. When `rolesClaim` is
  // configured we look there first and fall back to the non-namespaced
  // `payload.roles` key only if the namespaced claim is absent — that
  // preserves backward compatibility with tenants whose custom Action
  // already emits `roles` under the reserved key (and has always
  // happened to work so far because Auth0 tolerates it). Without the
  // configured lookup, out-of-the-box Auth0 RBAC deployments would
  // observe `UserContext.roles === []` and every `roles.includes(...)`
  // check on the server would fail-closed, silently stripping
  // authorization for every such user.
  const rolesRaw = rolesClaim !== undefined && rolesClaim !== ""
    ? payloadRec[rolesClaim] ?? payloadRec.roles
    : payloadRec.roles;

  return {
    sub: payload.sub,
    email: payload.email as string | undefined,
    name: payload.name as string | undefined,
    // `permissions` / `roles` drive authorization decisions downstream
    // (e.g. `user.roles.includes("admin")`). Auth0 rules / actions can
    // in principle emit them as non-arrays (misconfigured template,
    // custom claim shape, legacy scope-as-string). A bare `as string[]`
    // cast would let a string like `"admin"` through unchecked, and
    // `"admin_readonly".includes("admin")` would then silently grant
    // admin access via substring match. Normalize fail-closed: only
    // accept arrays of strings; any other shape collapses to `[]` so
    // downstream authorization falls through to its default deny path.
    permissions: _normalizeStringArray(payloadRec.permissions),
    roles: _normalizeStringArray(rolesRaw),
    orgId: payload.org_id as string | undefined,
    raw: payloadRec,
  };
}

function _normalizeStringArray(claim: unknown): string[] {
  if (!Array.isArray(claim)) return [];
  return claim.filter((x): x is string => typeof x === "string");
}

/**
 * Reset the process-wide JWKS resolver cache. Intended for test
 * teardown — multi-file suites that mock `createRemoteJWKSet`
 * with a per-test resolver would otherwise leak a resolver from an
 * earlier file into a later file that expects a fresh instantiation.
 *
 * Not a public runtime API: production servers live for the duration
 * of the process and benefit from the cache, so there is no
 * application-level reason to clear it.
 */
export function _clearJwksCache(): void {
  jwksCache.clear();
}
