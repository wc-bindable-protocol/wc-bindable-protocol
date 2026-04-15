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
  const { domain, audience } = options;
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
    permissions: _normalizeStringArray((payload as Record<string, unknown>).permissions),
    roles: _normalizeStringArray((payload as Record<string, unknown>).roles),
    orgId: payload.org_id as string | undefined,
    raw: payload as Record<string, unknown>,
  };
}

function _normalizeStringArray(claim: unknown): string[] {
  if (!Array.isArray(claim)) return [];
  return claim.filter((x): x is string => typeof x === "string");
}
