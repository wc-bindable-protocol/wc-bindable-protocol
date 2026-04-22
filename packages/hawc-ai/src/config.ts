import { raiseError } from "./raiseError.js";
import { IConfig, IWritableConfig } from "./types.js";

interface IInternalConfig extends IConfig {
  autoTrigger: boolean;
  triggerAttribute: string;
  tagNames: {
    ai: string;
    aiMessage: string;
  };
  remote: {
    enableRemote: boolean;
    remoteSettingType: "env" | "config";
    remoteCoreUrl: string;
  };
}

function resolveRemoteCoreUrl(cfg: IInternalConfig): string {
  if (cfg.remote.remoteSettingType === "env") {
    // Resolution order:
    // 1. process.env.AI_REMOTE_CORE_URL — Node.js / bundler build-time replacement
    // 2. globalThis.AI_REMOTE_CORE_URL  — browser global (set before script loads)
    return (
      (globalThis as any).process?.env?.AI_REMOTE_CORE_URL ??
      (globalThis as any).AI_REMOTE_CORE_URL ??
      ""
    );
  }
  return cfg.remote.remoteCoreUrl;
}

const _config: IInternalConfig = {
  autoTrigger: true,
  triggerAttribute: "data-aitarget",
  tagNames: {
    ai: "hawc-ai",
    aiMessage: "hawc-ai-message",
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

// Custom element tag grammar per whatwg/html: lowercase start, at least one "-",
// ASCII alnum / "-" / "_" / "." thereafter. Full PCEN is wider (Unicode etc.)
// but this conservative subset catches the 99% of real-world typos
// (whitespace, uppercase, missing hyphen) before customElements.define() is
// reached — keeping the failure mode at the setConfig() boundary.
const CUSTOM_ELEMENT_NAME_RE = /^[a-z][a-z0-9\-_.]*-[a-z0-9\-_.]*$/;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function setConfig(partialConfig: IWritableConfig): void {
  if (typeof partialConfig.autoTrigger === "boolean") {
    _config.autoTrigger = partialConfig.autoTrigger;
  }
  if ("triggerAttribute" in partialConfig) {
    // Empty/whitespace would let autoTrigger's `document.querySelectorAll("[]")`
    // throw a SyntaxError at registration time; non-string would pass through
    // Object.assign silently and surface later. Explicit `undefined` would
    // overwrite the default via the plain assignment below. Reject all three
    // here so the misuse surfaces at setConfig() with a formatted message.
    if (!isNonBlankString(partialConfig.triggerAttribute)) {
      raiseError("setConfig: triggerAttribute must be a non-empty string.");
    }
    _config.triggerAttribute = partialConfig.triggerAttribute;
  }
  if (partialConfig.tagNames) {
    // `customElements.define("", ...)` (and whitespace / uppercase / missing
    // hyphen variants) throw bare DOMExceptions; validating here keeps the
    // failure mode consistent with other setConfig guards. Use `in` rather
    // than `!== undefined` so an explicit `{ ai: undefined }` is rejected
    // — otherwise Object.assign below would clobber the default with
    // undefined and registerComponents() would call
    // customElements.define(undefined, Ai).
    if ("ai" in partialConfig.tagNames) {
      if (!isNonBlankString(partialConfig.tagNames.ai)) {
        raiseError("setConfig: tagNames.ai must be a non-empty string.");
      }
      if (!CUSTOM_ELEMENT_NAME_RE.test(partialConfig.tagNames.ai)) {
        raiseError(`setConfig: tagNames.ai must be a valid custom element name (lowercase, contains "-"), got ${JSON.stringify(partialConfig.tagNames.ai)}.`);
      }
    }
    if ("aiMessage" in partialConfig.tagNames) {
      if (!isNonBlankString(partialConfig.tagNames.aiMessage)) {
        raiseError("setConfig: tagNames.aiMessage must be a non-empty string.");
      }
      if (!CUSTOM_ELEMENT_NAME_RE.test(partialConfig.tagNames.aiMessage)) {
        raiseError(`setConfig: tagNames.aiMessage must be a valid custom element name (lowercase, contains "-"), got ${JSON.stringify(partialConfig.tagNames.aiMessage)}.`);
      }
    }
    Object.assign(_config.tagNames, partialConfig.tagNames);
  }
  if (partialConfig.remote) {
    // Silently coercing an unknown `remoteSettingType` to the default would
    // hide typos that flip a deployment onto the wrong resolver; reject it.
    // Use `in` so an explicit `{ remoteSettingType: undefined }` is also
    // rejected — otherwise Object.assign would clobber the default "config"
    // with undefined and resolveRemoteCoreUrl's `=== "env"` branch would
    // never fire.
    if ("remoteSettingType" in partialConfig.remote) {
      if (
        partialConfig.remote.remoteSettingType !== "env" &&
        partialConfig.remote.remoteSettingType !== "config"
      ) {
        raiseError(`setConfig: remote.remoteSettingType must be "env" or "config", got ${JSON.stringify(partialConfig.remote.remoteSettingType)}.`);
      }
    }
    Object.assign(_config.remote, partialConfig.remote);
  }
  frozenConfig = null;
}

export function getRemoteCoreUrl(): string {
  return resolveRemoteCoreUrl(_config);
}
