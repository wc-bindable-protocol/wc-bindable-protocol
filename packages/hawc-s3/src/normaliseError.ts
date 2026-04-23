import type { WcsS3AnyError } from "./types.js";

/**
 * Normalise any thrown value to the `WcsS3AnyError` union kept in `_error`.
 * Single choke-point shared by the Core (`S3Core._setError`) and the Shell
 * (`S3._setErrorState`) so remote and local consumers see identical
 * structure for any rejection — whether the provider threw an `Error`
 * instance, a bare string, a pre-serialised plain object from another realm,
 * or an AWS-SDK-shaped payload.
 *
 * The returned value always satisfies `WcsS3AnyError`:
 *   - `null` / `undefined` collapses to `null`
 *   - a real `Error` instance is returned as-is
 *   - a plain object with a `message` field is coerced to the fully-populated
 *     `SerializedError` shape (name/message/stack defaulted so downstream
 *     consumers never see optional fields missing from the required shape)
 *   - everything else (numbers, booleans, symbols, arrays, plain objects
 *     without a message) is wrapped as `new Error(String(err))`
 */
export function normaliseError(err: unknown): WcsS3AnyError {
  if (err == null) return null;
  if (err instanceof Error) return err;
  if (typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)) {
    // Plain-object shapes (pre-serialised error from another realm, AWS-SDK
    // shaped payloads, etc.). Coerce to the fully-populated SerializedError
    // shape rather than trusting the arbitrary input — callers see a stable
    // interface regardless of how the provider phrased the rejection.
    const e = err as Record<string, unknown>;
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: String(e.message ?? ""),
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  return new Error(String(err));
}
