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
 *
 * Circular references are tolerated: any value already on the current
 * recursion path is replaced with the sentinel string `"[Circular]"`.
 * `FlagIdentity.attrs` is ultimately user-supplied (e.g. a custom
 * identify() call or an attr-building hook), so a cycle — even an
 * accidental one — must not take the process down via stack overflow.
 */
export function stableStringify(obj: Record<string, unknown>): string {
  return _stableValueImpl(obj, new WeakSet());
}

export function stableValue(v: unknown): string {
  return _stableValueImpl(v, new WeakSet());
}

const CIRCULAR_SENTINEL = JSON.stringify("[Circular]");

function _stableValueImpl(v: unknown, seen: WeakSet<object>): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  // `v` is narrowed to `object` here so WeakSet accepts it. A cycle
  // detected mid-walk is reported as the sentinel rather than
  // recursed into — guarantees O(nodes) work on any input.
  const o = v as object;
  if (seen.has(o)) return CIRCULAR_SENTINEL;
  seen.add(o);
  try {
    if (Array.isArray(v)) {
      return "[" + v.map((e) => _stableValueImpl(e, seen)).join(",") + "]";
    }
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ":" + _stableValueImpl((v as Record<string, unknown>)[k], seen));
    }
    return "{" + parts.join(",") + "}";
  } finally {
    // Pop on exit so sibling subtrees that legitimately share the
    // same nested object ref still serialize normally; only strict
    // ancestor-of-self cycles are treated as circular.
    seen.delete(o);
  }
}
