import type { IConfig, IWritableConfig } from "./types.js";

interface IInternalConfig {
  tagNames: {
    flags: string;
  };
}

const _config: IInternalConfig = {
  tagNames: {
    flags: "feature-flags",
  },
};

/*
 * Both `deepFreeze` and `deepClone` recurse without a visited-set
 * cycle guard. This is intentional: {@link IInternalConfig}'s schema
 * is closed and strictly tree-shaped (see {@link _config} below — a
 * single `tagNames: { flags: string }` object of plain primitive
 * leaves). Before extending this config with a non-tree-shaped
 * structure (self-references, cross-branch links, or any value that
 * could re-enter the same object), either redesign the shape or
 * switch both helpers to a WeakSet-guarded walk — otherwise a cycle
 * causes unbounded recursion and a stack overflow at first use.
 */
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

export function setConfig(partialConfig: IWritableConfig): void {
  if (partialConfig.tagNames) {
    Object.assign(_config.tagNames, partialConfig.tagNames);
  }
  frozenConfig = null;
}
