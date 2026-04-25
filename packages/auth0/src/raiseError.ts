/**
 * Package-identifying prefix for every Error thrown by auth0-gate.
 * Exported so downstream integrators (and tests) can match on it
 * without hard-coding the string in multiple places; the build
 * pipeline can also swap it at bundle time for forks / renames.
 */
export const ERROR_PREFIX = "[@wc-bindable/auth0]";

/**
 * Sentinel property attached to Connection Ownership violations
 * (SPEC-REMOTE §3.7). `AuthSession` preserves a standing ownership
 * error across auto-restarts triggered by framework attribute
 * re-stamps, and this sentinel is the stable identifier used for
 * that check — previously the code relied on a message-substring
 * match (`message.includes("§3.7")`) which would silently break if
 * the wording ever drifted. Using a non-enumerable symbol-ish
 * property keeps it out of serialisation paths while still being
 * instance-checkable via `isOwnershipError()`.
 */
export const OWNERSHIP_ERROR_MARKER = "_authOwnership" as const;

export function raiseError(message: string): never {
  throw new Error(`${ERROR_PREFIX} ${message}`);
}

/**
 * Throw a Connection Ownership violation (SPEC-REMOTE §3.7) error
 * tagged with `OWNERSHIP_ERROR_MARKER` so callers can identify it
 * without relying on brittle message-substring matching.
 */
export function raiseOwnershipError(message: string): never {
  const err = new Error(`${ERROR_PREFIX} ${message}`);
  (err as unknown as Record<string, boolean>)[OWNERSHIP_ERROR_MARKER] = true;
  throw err;
}

/** Narrow an unknown value to an ownership-violation Error. */
export function isOwnershipError(value: unknown): value is Error {
  return (
    value instanceof Error &&
    (value as unknown as Record<string, unknown>)[OWNERSHIP_ERROR_MARKER] === true
  );
}
