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

export const config: IConfig = _config as IConfig;

function validatePartialConfig(partialConfig: IWritableConfig): void {
  const rec = partialConfig as Record<string, unknown>;

  if ("tagNames" in rec && partialConfig.tagNames !== undefined) {
    const t = partialConfig.tagNames as Record<string, unknown>;
    if ("stripe" in t && t.stripe !== undefined && typeof t.stripe !== "string") {
      raiseError("config.tagNames.stripe must be a string.");
    }
  }

  if ("remote" in rec && partialConfig.remote !== undefined) {
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
