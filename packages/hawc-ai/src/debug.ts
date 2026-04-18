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

// Dev-mode signal for HMR / module-reload scenarios where a bundler re-executes
// the registering module and hands the registry a *different* handler reference
// for the same tool name. In production this is a bootstrap-ordering bug worth
// investigating; in development it usually just means the module was hot-reloaded.
// Either way, silent replacement has security implications (older sessions
// running the newer user's handler — see README §Remote Mode / Tool use), so we
// surface a warning once per overwrite.
export function warnToolHandlerOverwrite(name: string): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn(
    `[@wc-bindable/hawc-ai] registerTool("${name}") replaced an existing handler with a different function reference. ` +
    "If this is an HMR / hot-reload cycle, call unregisterTool() in your bundler's dispose hook to silence this warning. " +
    "Cross-session handler replacement is a known footgun — see README §Tool use for per-connection authorization patterns (core.registerTool)."
  );
}