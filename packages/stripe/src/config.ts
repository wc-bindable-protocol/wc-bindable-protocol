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

interface EnvGlobals {
  readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> };
  readonly STRIPE_REMOTE_CORE_URL?: string;
}

function resolveRemoteCoreUrl(cfg: IInternalConfig): string {
  if (cfg.remote.remoteSettingType === "env") {
    // Mirror s3-uploader's resolution order: process.env first, then a global
    // hook for browser bundles that inject the URL before scripts execute.
    // Narrow typed cast instead of `any` so an accidental read against a
    // different shape (e.g. `(globalThis as any).process.exit(1)`) is a
    // type error rather than a silent pass.
    const g = globalThis as unknown as EnvGlobals;
    const fromProcess = typeof g.process?.env?.STRIPE_REMOTE_CORE_URL === "string"
      ? g.process.env.STRIPE_REMOTE_CORE_URL
      : undefined;
    const fromGlobal = typeof g.STRIPE_REMOTE_CORE_URL === "string"
      ? g.STRIPE_REMOTE_CORE_URL
      : undefined;
    return fromProcess ?? fromGlobal ?? "";
  }
  return cfg.remote.remoteCoreUrl;
}

const _config: IInternalConfig = {
  tagNames: {
    stripe: "stripe-checkout",
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
  // Array support keeps the helper correct if config grows an array-typed
  // entry later (e.g. `remote.origins: string[]`). Without this branch a
  // future clone would produce a `{0: "...", 1: "..."}` object, not an
  // array, and break `Array.isArray(getConfig().remote.origins)` checks.
  if (Array.isArray(obj)) return (obj.map(v => deepClone(v)) as unknown) as T;
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
 * @deprecated Prefer `getConfig()` — this convenience binding will be
 *   removed in v2. The only remaining consumer is the config test suite's
 *   readback assertions. Migrating call sites to `getConfig()` unblocks
 *   removal and shrinks the publish surface to the three setter/getter
 *   functions.
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

const KNOWN_TOP_LEVEL_KEYS = new Set(["tagNames", "remote"]);
const KNOWN_TAG_NAME_KEYS = new Set(["stripe"]);
const KNOWN_REMOTE_KEYS = new Set(["enableRemote", "remoteSettingType", "remoteCoreUrl"]);

function validatePartialConfig(partialConfig: IWritableConfig): void {
  const rec = partialConfig as Record<string, unknown>;

  // Reject unknown top-level keys up-front. A silent accept of typos
  // (`tagNms`, `remotee`) would ship misconfiguration to prod without
  // any signal — catching it at setConfig time is the cheapest feedback.
  for (const k of Object.keys(rec)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) {
      raiseError(`config: unknown key "${k}". Allowed: ${[...KNOWN_TOP_LEVEL_KEYS].join(", ")}.`);
    }
  }

  if ("tagNames" in rec && partialConfig.tagNames !== undefined) {
    // `null` slips past `!== undefined` but breaks the `in` operator below
    // with a TypeError whose message predates raiseError's formatting. Reject
    // non-object shapes explicitly so callers see the consistent
    // `[@wc-bindable/stripe]`-prefixed error.
    if (typeof partialConfig.tagNames !== "object" || partialConfig.tagNames === null) {
      raiseError("config.tagNames must be an object.");
    }
    const t = partialConfig.tagNames as Record<string, unknown>;
    for (const k of Object.keys(t)) {
      if (!KNOWN_TAG_NAME_KEYS.has(k)) {
        raiseError(`config.tagNames: unknown key "${k}".`);
      }
    }
    if ("stripe" in t && t.stripe !== undefined && typeof t.stripe !== "string") {
      raiseError("config.tagNames.stripe must be a string.");
    }
  }

  if ("remote" in rec && partialConfig.remote !== undefined) {
    if (typeof partialConfig.remote !== "object" || partialConfig.remote === null) {
      raiseError("config.remote must be an object.");
    }
    const r = partialConfig.remote as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      if (!KNOWN_REMOTE_KEYS.has(k)) {
        raiseError(`config.remote: unknown key "${k}".`);
      }
    }
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
  // Build the post-merge state in a staging object BEFORE touching `_config`,
  // validate the merged state, and commit atomically. Otherwise a partial
  // merge that later fails post-merge validation would leave `_config`
  // half-written — e.g. `setConfig({ remote: { enableRemote: true } })`
  // under default URL="" would set `enableRemote=true` on `_config` and
  // THEN throw on the empty-URL check, so a subsequent
  // `setConfig({ remote: { remoteCoreUrl: "ws://..." } })` would quietly
  // run against the leaked `enableRemote=true` and succeed. Atomic commit
  // closes that window.
  const staged = {
    tagNames: { stripe: _config.tagNames.stripe },
    remote: {
      enableRemote: _config.remote.enableRemote,
      remoteSettingType: _config.remote.remoteSettingType,
      remoteCoreUrl: _config.remote.remoteCoreUrl,
    },
  };
  // Only copy known keys. `Object.assign` would silently persist unexpected
  // keys like `evil` into `staged`, growing the schema by stealth.
  if (partialConfig.tagNames) {
    if (partialConfig.tagNames.stripe !== undefined) {
      staged.tagNames.stripe = partialConfig.tagNames.stripe;
    }
  }
  if (partialConfig.remote) {
    if (partialConfig.remote.enableRemote !== undefined) {
      staged.remote.enableRemote = partialConfig.remote.enableRemote;
    }
    if (partialConfig.remote.remoteSettingType !== undefined) {
      staged.remote.remoteSettingType = partialConfig.remote.remoteSettingType;
    }
    if (partialConfig.remote.remoteCoreUrl !== undefined) {
      staged.remote.remoteCoreUrl = partialConfig.remote.remoteCoreUrl;
    }
  }
  // Fail-loud for the common misconfiguration: `enableRemote: true` without
  // a URL source. The check is limited to `remoteSettingType === "config"`
  // because the `"env"` path resolves at runtime from `process.env` /
  // `globalThis.STRIPE_REMOTE_CORE_URL`, which may be injected AFTER the
  // `setConfig` call (server start, bundler-injected globals). For env mode
  // the fail-loud still occurs later, at `_initRemote` / `getRemoteCoreUrl`.
  if (staged.remote.enableRemote
    && staged.remote.remoteSettingType === "config"
    && !staged.remote.remoteCoreUrl) {
    raiseError('config.remote.enableRemote is true but remoteCoreUrl is empty. Set remoteCoreUrl, or set remoteSettingType to "env" to read from STRIPE_REMOTE_CORE_URL at runtime.');
  }
  // Atomic commit. Field-wise assignment preserves the identity of the
  // nested objects (`_config.tagNames`, `_config.remote`) so any code
  // holding a long-lived reference continues to observe updates.
  _config.tagNames.stripe = staged.tagNames.stripe;
  _config.remote.enableRemote = staged.remote.enableRemote;
  _config.remote.remoteSettingType = staged.remote.remoteSettingType;
  _config.remote.remoteCoreUrl = staged.remote.remoteCoreUrl;
  frozenConfig = null;
}

export function getRemoteCoreUrl(): string {
  return resolveRemoteCoreUrl(_config);
}
