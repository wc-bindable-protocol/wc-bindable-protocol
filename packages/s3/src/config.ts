import { IConfig, IWritableConfig } from "./types.js";
import { readProcessEnv } from "./processEnv.js";

interface IInternalConfig extends IConfig {
  tagNames: {
    s3: string;
    s3Callback: string;
  };
  remote: {
    enableRemote: boolean;
    remoteSettingType: "env" | "config";
    remoteCoreUrl: string;
  };
}

function resolveRemoteCoreUrl(cfg: IInternalConfig): string {
  if (cfg.remote.remoteSettingType === "env") {
    // Mirror ai-agent's resolution order: process.env first, then a global hook
    // for browser bundles that inject the URL before scripts execute. The
    // global fallback (`globalThis.S3_REMOTE_CORE_URL`) is not a process env
    // lookup and therefore does not share the helper — it is a separate
    // inject-before-script convention we keep distinct from env resolution.
    const fromEnv = readProcessEnv("S3_REMOTE_CORE_URL");
    if (fromEnv !== undefined) return fromEnv;
    const fromGlobal = (globalThis as { S3_REMOTE_CORE_URL?: string }).S3_REMOTE_CORE_URL;
    return fromGlobal ?? "";
  }
  return cfg.remote.remoteCoreUrl;
}

const _config: IInternalConfig = {
  tagNames: {
    s3: "s3-uploader",
    s3Callback: "s3-callback",
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

// Internal-only accessor. The module-level `_config` is mutable (setConfig
// mutates it in place) and exposing it to callers conflated "give me the
// current settings" with "hand me a handle I can mutate". External callers
// go through `getConfig()` (deep-frozen clone) or the narrower typed
// accessors below. Internal call sites (S3 / S3Callback / registerComponents)
// use this getter to read the live mutable state without paying the freeze
// cost on every access.
export function _getInternalConfig(): IInternalConfig {
  return _config;
}

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
  if (partialConfig.remote) {
    Object.assign(_config.remote, partialConfig.remote);
  }
  frozenConfig = null;
}

export function getRemoteCoreUrl(): string {
  return resolveRemoteCoreUrl(_config);
}
