type ImportMetaEnvLike = {
  DEV?: boolean;
  PROD?: boolean;
  MODE?: string;
};

function isDevelopment(): boolean {
  const env = (import.meta as ImportMeta & { env?: ImportMetaEnvLike }).env;
  if (typeof env?.DEV === "boolean") return env.DEV;
  if (typeof env?.PROD === "boolean") return !env.PROD;

  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  return nodeEnv !== "production";
}

export function warnStreamParseFailure(
  provider: string,
  event: string | undefined,
  data: string,
  error: unknown
): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn("[@wc-bindable/hawc-ai] Failed to parse stream chunk.", {
    provider,
    event,
    data,
    error,
  });
}