import type { FlagIdentity } from "../types.js";

/**
 * Canonical key for an identity used to dedupe per-identity state
 * across Provider implementations. Two identities collide iff both the
 * `userId` and every attribute that feeds the upstream service's
 * targeting rules match. Two tabs from the same authenticated user
 * with identical trait sets share state; a stale vs. refreshed trait
 * set intentionally allocates a separate one — the flag map may
 * legitimately differ.
 *
 * Shared across Provider implementations so Flagsmith and Unleash use
 * the same canonicalization rules.
 */
export function identityKey(identity: FlagIdentity): string {
  return identity.userId + "|" + stableStringify(identity.attrs ?? {});
}

/**
 * Deterministic JSON-like stringification: sorts object keys at every
 * depth so two maps with identical content but different insertion
 * orders compare equal. Array element order is preserved — the caller
 * is responsible for canonicalizing set-like arrays (e.g. the
 * permissions/roles sort in `FlagsCore._buildIdentity`).
 */
export function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableValue(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

export function stableValue(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableValue).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableValue((v as Record<string, unknown>)[k]));
  }
  return "{" + parts.join(",") + "}";
}
