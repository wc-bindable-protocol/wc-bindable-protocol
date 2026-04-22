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

// Dev-mode signal for streaming tool-call accumulators that are dropped because
// they are missing `id` or `name` by the time `_materializeToolCalls` runs. In
// a healthy stream every tool_call fragment carries both before arguments-only
// deltas begin, so a missing field usually means a provider bug, a truncated
// stream, or a parser misalignment. Silently skipping (the old behavior)
// produces a terminal assistant turn with no tool use from the consumer's
// perspective — tricky to debug without a log. Fires only in development; in
// production consumers can still observe the shape by inspecting
// `messages[*].toolCalls` on the stored turn.
export function warnMalformedToolCall(
  index: number,
  entry: { id?: string; name?: string; arguments: string }
): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn("[@wc-bindable/hawc-ai] Dropped malformed tool_call accumulator (missing id or name).", {
    index,
    id: entry.id,
    name: entry.name,
    argumentsLength: entry.arguments.length,
  });
}

// Dev-mode signal for remote-mode `api-key` attribute leakage. In remote mode
// the server is expected to hold provider credentials; forwarding the
// client-side `api-key` attribute (and its siblings `base-url` / `api-version`)
// over the WebSocket leaks the secret to logs, proxies, and any other observer
// on the transport. This usually happens because an author switched the
// component into remote mode without scrubbing a dev-time `api-key` attribute
// from the markup. Fire once per element to cap noise during HMR reloads.
export function warnApiKeyInRemoteMode(): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn(
    "[@wc-bindable/hawc-ai] `api-key` attribute is set on <hawc-ai> in remote mode. " +
    "In remote mode the server is expected to hold provider credentials, and forwarding a client-side key over the WebSocket leaks the secret to transport observers. " +
    "Remove the `api-key` attribute from the element (and `base-url` / `api-version` if they point at provider endpoints rather than your own proxy) before enabling remote mode."
  );
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