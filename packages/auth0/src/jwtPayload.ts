/**
 * Shared helpers for decoding JWT payloads on the client and server
 * sides of auth0-gate. Consolidates what used to be two near-identical
 * implementations in `AuthCore.ts` and `server/createAuthenticatedWSS.ts`
 * — keeping both in sync by construction and centralising the payload
 * type guard that keeps `JSON.parse(...)` from crashing on `null` or
 * a primitive payload (see `parseJwtPayload`).
 *
 * Runtime-agnostic: `atob` (browsers, Deno, Bun, CF Workers, Node 16+)
 * is preferred; `Buffer` is only the fallback for older Node runtimes
 * that still lack a global `atob`.
 */

/**
 * Decode a base64url-encoded string into a UTF-8 string.
 *
 * `atob` alone yields a "binary string" (one char per byte) which
 * silently corrupts non-ASCII JWT claims (e.g. a Japanese `name`
 * claim) and can make `JSON.parse` throw. Routing through
 * `TextDecoder` keeps callers honest for any claim beyond the
 * current `exp`-only read sites.
 */
export function base64UrlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  // Node ≤ 15 fallback (Node 16+ exposes a global `atob`).
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Parse the payload segment of a JWT and return it as a plain object,
 * or `null` if:
 *
 *   - the token shape is not `header.payload.signature` (fewer than 2
 *     segments),
 *   - the base64url / UTF-8 decode fails,
 *   - `JSON.parse` throws,
 *   - the decoded value is not a non-null object (e.g. `null`,
 *     `"string"`, `42`). Without this last guard, callers that read
 *     `payload.exp` would crash with `TypeError: Cannot read
 *     properties of null` on a minimally-crafted token. The try/catch
 *     at the call site would usually swallow this, but relying on
 *     that is fragile and hides the cause of the failure.
 *
 * Returns the payload as `Record<string, unknown>` so that individual
 * claim access has to `typeof`-check the field before use.
 */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const decoded = JSON.parse(base64UrlDecode(parts[1]));
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the `exp` claim from a JWT and return it as a millisecond
 * epoch, or `null` when:
 *
 *   - the token has no payload segment,
 *   - the payload is not a JSON object,
 *   - the `exp` claim is missing or not a number.
 *
 * Server-side callers that need to distinguish "no token" from
 * "parse failure" should use {@link parseJwtPayload} directly so they
 * can emit an observability event on the parse-failure branch.
 */
export function getTokenExpiryMs(token: string | null): number | null {
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number") {
    return payload.exp * 1000;
  }
  return null;
}
