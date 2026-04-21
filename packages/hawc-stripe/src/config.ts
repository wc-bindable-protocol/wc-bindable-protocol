import { IConfig, IWritableConfig } from "./types.js";
import { raiseError } from "./raiseError.js";

interface IInternalConfig extends IConfig {
  tagNames: {
    stripe: string;
  };
  remote: {
    enableRemote: boolean;
    remoteSettingType: "env" | "config";
    remoteCoreUrl: string;
  };
}

function resolveRemoteCoreUrl(cfg: IInternalConfig): string {
  if (cfg.remote.remoteSettingType === "env") {
    // Mirror hawc-s3's resolution order: process.env first, then a global
    // hook for browser bundles that inject the URL before scripts execute.
    return (
      (globalThis as any).process?.env?.STRIPE_REMOTE_CORE_URL ??
      (globalThis as any).STRIPE_REMOTE_CORE_URL ??
      ""
    );
  }
  return cfg.remote.remoteCoreUrl;
}

const _config: IInternalConfig = {
  tagNames: {
    stripe: "hawc-stripe",
  },
  remote: {
    enableRemote: false,
    remoteSettingType: "config",
    remoteCoreUrl: "",
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

/**
 * Live read-only view of module configuration. All internal reads should go
 * through `getConfig()` (which returns a deep-frozen clone); this export is
 * retained as a convenience for reads only.
 *
 * Implementation: `Object.defineProperties` with getter-only, non-configurable
 * descriptors on a real object, then `Object.freeze` at the top level. Writes
 * and deletes fail with the engine's native TypeError under strict mode.
 * Enumeration (`Object.keys`, spread, `JSON.stringify`) sees the declared
 * properties directly — a Proxy trapping `ownKeys` /
 * `getOwnPropertyDescriptor` would report frozen descriptors for properties
 * that do not exist on the empty target and violate the ECMAScript proxy
 * invariant at enumeration time, so this shape is used instead.
 *
 * Every getter returns a value off the deep-frozen `getConfig()` snapshot, so
 * deep mutations (`config.remote.remoteCoreUrl = "x"`) also fail.
 */
export const config: IConfig = Object.freeze(
  Object.defineProperties({} as IConfig, {
    tagNames: {
      enumerable: true,
      configurable: false,
      get: () => getConfig().tagNames,
    },
    remote: {
      enumerable: true,
      configurable: false,
      get: () => getConfig().remote,
    },
  }),
);

function validatePartialConfig(partialConfig: IWritableConfig): void {
  const rec = partialConfig as Record<string, unknown>;

  if ("tagNames" in rec && partialConfig.tagNames !== undefined) {
    // `null` slips past `!== undefined` but breaks the `in` operator below
    // with a TypeError whose message predates raiseError's formatting. Reject
    // non-object shapes explicitly so callers see the consistent
    // `[@wc-bindable/hawc-stripe]`-prefixed error.
    if (typeof partialConfig.tagNames !== "object" || partialConfig.tagNames === null) {
      raiseError("config.tagNames must be an object.");
    }
    const t = partialConfig.tagNames as Record<string, unknown>;
    if ("stripe" in t && t.stripe !== undefined && typeof t.stripe !== "string") {
      raiseError("config.tagNames.stripe must be a string.");
    }
  }

  if ("remote" in rec && partialConfig.remote !== undefined) {
    if (typeof partialConfig.remote !== "object" || partialConfig.remote === null) {
      raiseError("config.remote must be an object.");
    }
    const r = partialConfig.remote as Record<string, unknown>;
    if ("enableRemote" in r && r.enableRemote !== undefined && typeof r.enableRemote !== "boolean") {
      raiseError("config.remote.enableRemote must be a boolean.");
    }
    if ("remoteSettingType" in r && r.remoteSettingType !== undefined) {
      if (r.remoteSettingType !== "env" && r.remoteSettingType !== "config") {
        raiseError('config.remote.remoteSettingType must be "env" or "config".');
      }
    }
    if ("remoteCoreUrl" in r && r.remoteCoreUrl !== undefined && typeof r.remoteCoreUrl !== "string") {
      raiseError("config.remote.remoteCoreUrl must be a string.");
    }
  }
}

export function getConfig(): IConfig {
  if (!frozenConfig) {
    frozenConfig = deepFreeze(deepClone(_config));
  }
  return frozenConfig;
}

export function setConfig(partialConfig: IWritableConfig): void {
  validatePartialConfig(partialConfig);
  // Only copy known keys. `Object.assign(_config.tagNames, partialConfig.tagNames)`
  // would silently persist unexpected keys like `evil` onto the internal
  // config, growing the schema by stealth and potentially shadowing future
  // well-known keys.
  if (partialConfig.tagNames) {
    if (partialConfig.tagNames.stripe !== undefined) {
      _config.tagNames.stripe = partialConfig.tagNames.stripe;
    }
  }
  if (partialConfig.remote) {
    if (partialConfig.remote.enableRemote !== undefined) {
      _config.remote.enableRemote = partialConfig.remote.enableRemote;
    }
    if (partialConfig.remote.remoteSettingType !== undefined) {
      _config.remote.remoteSettingType = partialConfig.remote.remoteSettingType;
    }
    if (partialConfig.remote.remoteCoreUrl !== undefined) {
      _config.remote.remoteCoreUrl = partialConfig.remote.remoteCoreUrl;
    }
  }
  frozenConfig = null;
}

export function getRemoteCoreUrl(): string {
  return resolveRemoteCoreUrl(_config);
}
