import { IConfig, IWritableConfig } from "./types.js";

interface IInternalConfig extends IConfig {
  tagNames: {
    webauthn: string;
  };
}

const _config: IInternalConfig = {
  tagNames: {
    webauthn: "passkey-auth",
  },
};

// The config object is small and hand-written (only `tagNames` today),
// so circular references are not expected from internal callers. But
// `setConfig()` accepts caller-supplied partials — an application that
// accidentally passes a self-referential object would hang the process
// in an unbounded recursion. Track visited nodes with a WeakSet so
// both helpers terminate on cycles; circular inputs still produce a
// safe (and consistent) output instead of a stack overflow.
function deepFreeze<T>(obj: T, seen: WeakSet<object> = new WeakSet()): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (seen.has(obj as object)) return obj;
  seen.add(obj as object);
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key], seen);
  }
  return obj;
}

function deepClone<T>(obj: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (seen.has(obj as object)) return seen.get(obj as object) as T;
  const clone: Record<string, unknown> = {};
  seen.set(obj as object, clone);
  for (const key of Object.keys(obj)) {
    clone[key] = deepClone((obj as Record<string, unknown>)[key], seen);
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

export function setConfig(partialConfig: IWritableConfig): void {
  if (partialConfig.tagNames) {
    Object.assign(_config.tagNames, partialConfig.tagNames);
  }
  frozenConfig = null;
}
