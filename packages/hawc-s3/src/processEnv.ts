/**
 * Read an environment variable from `process.env` without tripping
 * TypeScript's `no-explicit-any` when `process` is not declared (browser
 * bundle). The canonical `globalThis as any` dodge is centralised here so
 * every call site does not need its own opt-out.
 *
 * Returns `undefined` when:
 *   - `globalThis.process` is absent (browser),
 *   - `globalThis.process.env` is absent,
 *   - the requested variable is unset.
 */
export function readProcessEnv(name: string): string | undefined {
  // `globalThis` is always typed as the ambient `typeof globalThis`, which in
  // a browser target does not include `process`. The cast is the only place
  // we acknowledge that — callers see a typed, `no-any` API.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}
