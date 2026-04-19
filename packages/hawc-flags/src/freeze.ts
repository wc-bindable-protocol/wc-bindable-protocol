import type { FlagMap, FlagValue } from "./types.js";

/**
 * Deep-clone-and-freeze a {@link FlagMap}.
 *
 * Why clone instead of plain `Object.freeze(outer)`:
 * 1. **Consumer-side mutation defense** — without freezing the nested
 *    object values (Flagsmith's `{ enabled, value }` or JSON-shaped
 *    flags), a consumer writing `values.flags.x.enabled = true` would
 *    silently succeed. The docstring on `FlagsCore.flags` promises a
 *    frozen snapshot; the contract must hold all the way down.
 * 2. **Provider-source isolation** — a Provider (notably
 *    {@link InMemoryFlagProvider}) may hand us a map whose values
 *    share references with its own rule definitions. If we only froze
 *    the outer map, a consumer mutation would contaminate the
 *    Provider's source of truth. If we deep-*froze* the Provider's
 *    own references, subsequent rule updates inside the Provider
 *    would throw in strict mode. Cloning isolates both sides.
 *
 * Scope: {@link FlagValue} is JSON-serializable by type. `null`,
 * primitives, arrays, and plain objects are handled. Non-plain
 * objects (class instances, Dates) are outside the contract and are
 * passed through — the flag protocol does not carry them.
 */
export function deepCloneAndFreeze(map: FlagMap): FlagMap {
  const out: Record<string, FlagValue> = {};
  for (const key of Object.keys(map)) {
    out[key] = _cloneValue(map[key]);
  }
  return Object.freeze(out);
}

function _cloneValue(v: FlagValue): FlagValue {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const arr: FlagValue[] = v.map(_cloneValue);
    return Object.freeze(arr) as FlagValue;
  }
  const out: Record<string, FlagValue> = {};
  for (const k of Object.keys(v)) {
    out[k] = _cloneValue((v as Record<string, FlagValue>)[k]);
  }
  return Object.freeze(out) as FlagValue;
}
