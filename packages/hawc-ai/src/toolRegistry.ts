/**
 * Process-wide registry for tool handlers.
 *
 * In remote mode, `<hawc-ai>` strips handler functions from `AiRequestOptions.tools`
 * before sending over WebSocket (functions are not JSON-serializable). The server
 * uses this registry to resolve handlers by tool name at execution time.
 *
 * Usage (server bootstrap):
 * ```ts
 * import { registerTool } from "@wc-bindable/hawc-ai";
 * registerTool("get_weather", async ({ location }) => fetchWeather(location));
 * ```
 *
 * The registry is also consulted in local mode as a fallback when a tool
 * declaration omits `handler`, so the same code path works in both modes.
 *
 * **Capability boundary.** The registry supplies *handlers* for tools already
 * declared on `AiRequestOptions.tools` for the current `send()` call — it does
 * **not** widen the tool catalog. A model that hallucinates or replays a tool
 * name that the caller did not declare is refused regardless of what the
 * registry contains. Put another way: `options.tools` names what the model is
 * allowed to call on this request; the registry only fills in the function
 * bodies for those declarations when the wire payload could not carry them.
 */

import { warnToolHandlerOverwrite } from "./debug.js";

export type AiToolHandler = (args: any) => unknown | Promise<unknown>;

const handlers = new Map<string, AiToolHandler>();

/**
 * Register a handler for `name`. Overwrites any previous handler for the same name
 * (callers wanting strict semantics should check with `getRegisteredTool` first).
 *
 * Re-registering with the *same* function reference is idempotent and silent
 * (supports modules that register at top level and may be imported twice).
 * Re-registering with a *different* reference emits a dev-mode warning — this
 * is the HMR / hot-reload footgun: older sessions still hold a `send()` loop
 * that can reach the newly-installed handler and execute it with a previous
 * user's context. In production, use `core.registerTool()` to scope handlers
 * per connection (see README §Tool use).
 */
export function registerTool(name: string, handler: AiToolHandler): void {
  if (!name) throw new Error("[@wc-bindable/hawc-ai] registerTool: name is required.");
  if (typeof handler !== "function") {
    throw new Error("[@wc-bindable/hawc-ai] registerTool: handler must be a function.");
  }
  const existing = handlers.get(name);
  if (existing && existing !== handler) {
    warnToolHandlerOverwrite(name);
  }
  handlers.set(name, handler);
}

export function unregisterTool(name: string): boolean {
  return handlers.delete(name);
}

export function getRegisteredTool(name: string): AiToolHandler | undefined {
  return handlers.get(name);
}

/**
 * Remove all registered handlers. Primarily for tests; real deployments register
 * once at bootstrap and do not unregister.
 */
export function clearToolRegistry(): void {
  handlers.clear();
}
