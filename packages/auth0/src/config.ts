import { raiseError } from "./raiseError.js";
import { IConfig, IWritableConfig } from "./types.js";

interface IInternalConfig extends IConfig {
  autoTrigger: boolean;
  triggerAttribute: string;
  tagNames: {
    auth: string;
    authLogout: string;
    authSession: string;
  };
}

const _config: IInternalConfig = {
  autoTrigger: true,
  triggerAttribute: "data-authtarget",
  tagNames: {
    auth: "auth0-gate",
    authLogout: "auth0-logout",
    authSession: "auth0-session",
  },
};

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    clone[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return clone as T;
}

let frozenConfig: IConfig | null = null;

export const config: IConfig = _config as IConfig;

export function getConfig(): IConfig {
  if (!frozenConfig) {
    frozenConfig = deepFreeze(deepClone(_config));
  }
  return frozenConfig;
}

/**
 * Merge a partial config into the library's mutable defaults.
 *
 * Fields omitted from `partialConfig` keep their current value —
 * this is a partial update, NOT a replacement. In particular,
 * `tagNames` is merged key-by-key via `Object.assign`: passing
 * `{ tagNames: { auth: "x-auth" } }` rewrites only `tagNames.auth`
 * and leaves `tagNames.authLogout` / `tagNames.authSession` intact.
 * Callers that want to reset a field must pass the desired value
 * explicitly; there is no "unset" sentinel.
 *
 * Invalidates the frozen snapshot returned by `getConfig()` so the
 * next read reflects the mutation.
 */
export function setConfig(partialConfig: IWritableConfig): void {
  if (typeof partialConfig.autoTrigger === "boolean") {
    _config.autoTrigger = partialConfig.autoTrigger;
  }
  if (typeof partialConfig.triggerAttribute === "string") {
    // Reject empty / whitespace-only values. Downstream `target.closest(
    // \`[${triggerAttribute}]\`)` would build the selector `[]`, which
    // throws `SyntaxError: '[]' is not a valid selector` at click time —
    // far from the configuration call site. Failing fast here keeps the
    // diagnostic next to the bad input (typo, empty JSON-sourced config).
    if (partialConfig.triggerAttribute.trim() === "") {
      raiseError(
        "setConfig(): `triggerAttribute` must be a non-empty attribute name. " +
        "An empty string would produce the invalid selector `[]` at click time.",
      );
    }
    _config.triggerAttribute = partialConfig.triggerAttribute;
  }
  if (partialConfig.tagNames) {
    // Reject empty / whitespace-only tag names. `customElements.define("",
    // ...)` throws `SyntaxError: The provided name is not a valid custom
    // element name`, which surfaces during `registerComponents()` —
    // usually far from the offending `setConfig` call. Validate here so
    // the error points at the field the caller actually set.
    //
    // Cycle 8 (J-001): explicitly skip `undefined` before the empty-string
    // check AND before the assignment. Sibling fields (`autoTrigger`,
    // `triggerAttribute`) naturally skip `undefined` via their
    // `typeof === "boolean" | "string"` guard; without an explicit skip
    // here, `Object.assign(_config.tagNames, { auth: undefined })` would
    // copy the own-enumerable `undefined` over a valid default and break
    // `customElements.define` / tagName comparisons downstream.
    for (const key of ["auth", "authLogout", "authSession"] as const) {
      const value = partialConfig.tagNames[key];
      if (value === undefined) continue;
      // Cycle 9 (K-002): non-string values (null, numbers, objects, …)
      // previously slipped through the `typeof === "string"` empty-check
      // and were assigned straight onto `_config.tagNames[key]`.
      // Downstream `customElements.define(null, ...)` would then throw
      // a TypeError at component-registration time, far from the
      // offending setConfig call. This mirrors the fail-fast contract
      // established by I-002 / J-001 — reject non-strings at the
      // configuration boundary so the diagnostic points at the caller.
      if (typeof value !== "string") {
        raiseError(
          `setConfig(): \`tagNames.${key}\` must be a string; got ${value === null ? "null" : typeof value}.`,
        );
      }
      if (value.trim() === "") {
        raiseError(
          `setConfig(): \`tagNames.${key}\` must be a non-empty custom element name. ` +
          "customElements.define('') would reject it with SyntaxError.",
        );
      }
      _config.tagNames[key] = value;
    }
  }
  frozenConfig = null;
}
