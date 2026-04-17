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
 */

export type AiToolHandler = (args: any) => unknown | Promise<unknown>;

const handlers = new Map<string, AiToolHandler>();

/**
 * Register a handler for `name`. Overwrites any previous handler for the same name
 * (callers wanting strict semantics should check with `getRegisteredTool` first).
 */
export function registerTool(name: string, handler: AiToolHandler): void {
  if (!name) throw new Error("[@wc-bindable/hawc-ai] registerTool: name is required.");
  if (typeof handler !== "function") {
    throw new Error("[@wc-bindable/hawc-ai] registerTool: handler must be a function.");
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
