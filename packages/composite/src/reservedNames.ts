/**
 * Reserved-name policy for composed names (COMPOSITE.md § 4).
 *
 * `@wc-bindable/composite` depends only on `@wc-bindable/core`, so it cannot
 * import `@wc-bindable/remote`'s wire validator. Per § 4 a separate-package
 * implementation MUST instead track the SPEC-extensions.md § Reserved names
 * definition itself. This module is that tracked copy; keep it in lockstep with
 * `packages/remote/src/transport/messageValidation.ts`.
 */

/**
 * The wire-namespace prefix. A composed *name* (not event name) whose first 13
 * characters equal this prefix case-insensitively is rejected under remote
 * compatibility — and by default here, per § 4's reference-implementation
 * SHOULD-reject-by-default guidance.
 */
const WIRE_NAMESPACE_PREFIX = "@wc-bindable/"; // exactly 13 characters

/** Prototype-pollution-prone strings, rejected as composed names everywhere. */
const POLLUTION_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Fixed public-API members every composed shell needs (COMPOSITE.md § 4
 * "Fixed-API collisions", all-tiers base set). A composed name equal to one of
 * these would shadow discovery / the bind-target EventTarget surface, so it is
 * rejected on every shell. `dispose` is included because this implementation
 * always materializes a `dispose()` terminal on the shell (§ 10).
 */
const FIXED_API_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "dispose",
]);

/** Source ids that would corrupt a plain-object lookup map (§ 3 guidance). */
const POLLUTION_SOURCE_IDS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function hasWireNamespacePrefix(name: string): boolean {
  return (
    name.length >= WIRE_NAMESPACE_PREFIX.length &&
    name.slice(0, WIRE_NAMESPACE_PREFIX.length).toLowerCase() === WIRE_NAMESPACE_PREFIX
  );
}

/**
 * Is `name` rejected as a composed property / input / command name?
 *
 * The reference implementation rejects the entire remote wire reserved-name set
 * (the `@wc-bindable/` case-insensitive prefix plus the pollution names) by
 * default — even when remote compatibility is not claimed — because a name that
 * can never be remoted has little upside and silently makes the shell
 * impossible to expose through `@wc-bindable/remote` later (§ 4). It also
 * rejects the fixed-API members.
 */
export function isReservedComposedName(name: string): boolean {
  return (
    POLLUTION_NAMES.has(name) ||
    FIXED_API_NAMES.has(name) ||
    hasWireNamespacePrefix(name)
  );
}

/** Human-readable reason a composed name is reserved (for error messages). */
export function reservedComposedNameReason(name: string): string | undefined {
  if (POLLUTION_NAMES.has(name)) return "prototype-pollution-prone name";
  if (FIXED_API_NAMES.has(name)) return "shadows a fixed shell API member";
  if (hasWireNamespacePrefix(name)) return "uses the reserved @wc-bindable/ wire prefix";
  return undefined;
}

/** Is `id` rejected as a source id (§ 3)? */
export function isReservedSourceId(id: string): boolean {
  return id.length === 0 || id.includes(".") || POLLUTION_SOURCE_IDS.has(id);
}
