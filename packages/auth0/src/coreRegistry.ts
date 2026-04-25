import type { WcBindableDeclaration } from "@wc-bindable/core";
import { raiseError } from "./raiseError.js";

/**
 * Registry of Core wcBindable declarations, keyed by string.
 *
 * `<auth0-session core="key">` resolves its Core declaration by
 * looking up `key` in this registry. Using strings (rather than direct
 * JS object references) lets the HTML author stay declarative: the
 * application registers the declaration once at bootstrap and referencing
 * it from markup is just an attribute value.
 *
 * The registry is a process-wide singleton. Keys are case-sensitive.
 */
const _registry = new Map<string, WcBindableDeclaration>();

/**
 * Register a Core wcBindable declaration under `key`.
 *
 * Re-registering the same key with a different declaration throws — a
 * silent overwrite would desynchronize already-mounted
 * `<auth0-session>` elements whose proxies were built against the
 * previous declaration. Re-registering with an identical reference is a
 * no-op (supports idempotent bootstrap).
 */
export function registerCoreDeclaration(
  key: string,
  declaration: WcBindableDeclaration,
): void {
  if (!key) {
    raiseError("registerCoreDeclaration: key must be a non-empty string.");
  }
  const existing = _registry.get(key);
  if (existing && existing !== declaration) {
    raiseError(
      `registerCoreDeclaration: key "${key}" is already registered with a different declaration.`,
    );
  }
  _registry.set(key, declaration);
}

/** Look up a Core declaration by key. Returns `undefined` if not registered. */
export function getCoreDeclaration(
  key: string,
): WcBindableDeclaration | undefined {
  return _registry.get(key);
}

/**
 * Remove a Core declaration from the registry.
 *
 * Intended for test teardown. Does not notify or tear down already-mounted
 * `<auth0-session>` elements — their proxies keep working against the
 * captured declaration.
 */
export function unregisterCoreDeclaration(key: string): boolean {
  return _registry.delete(key);
}

/** Test-only: clear the entire registry. */
export function _clearCoreRegistry(): void {
  _registry.clear();
}
