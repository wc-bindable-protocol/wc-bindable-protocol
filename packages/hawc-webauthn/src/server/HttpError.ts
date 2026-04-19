/**
 * Application-controlled HTTP error.
 *
 * Throw from any `createWebAuthnHandlers` hook (`resolveSessionId`,
 * `resolveUser`, `normalizeRegistrationUser`, `listExistingCredentials`)
 * to short-circuit the handler with a specific status code instead of
 * the default 500 / 400. The canonical case is the README pattern
 * `requireSignedInUser(req)` inside `normalizeRegistrationUser`: an
 * unauthenticated registration attempt should return 401, not "server
 * error".
 *
 * The handler also honors plain Errors that carry a numeric `.status`
 * property — same protocol, no class import required for callers that
 * already throw their own typed errors.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * @internal — extract a numeric status from an arbitrary thrown value.
 * Returns `undefined` when no caller-supplied status is present, in
 * which case the handler falls back to its endpoint-specific default
 * (500 for challenge, 400 for verify).
 */
export function _statusFromError(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status: unknown }).status;
    if (typeof s === "number" && Number.isInteger(s) && s >= 100 && s < 600) {
      return s;
    }
  }
  return undefined;
}
