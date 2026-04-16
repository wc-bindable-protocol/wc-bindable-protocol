import { IConfig, IWritableConfig } from "./types.js";

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
    // Mirror hawc-ai's resolution order: process.env first, then a global hook
    // for browser bundles that inject the URL before scripts execute.
    return (
      (globalThis as any).process?.env?.S3_REMOTE_CORE_URL ??
      (globalThis as any).S3_REMOTE_CORE_URL ??
      ""
    );
  }
  return cfg.remote.remoteCoreUrl;
}

const _config: IInternalConfig = {
  tagNames: {
    s3: "hawc-s3",
    s3Callback: "hawc-s3-callback",
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
