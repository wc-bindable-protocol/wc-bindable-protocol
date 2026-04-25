/**
 * Base64url codec used at the Shell <-> Core wire boundary.
 *
 * The Shell reads `ArrayBuffer` fields from `PublicKeyCredential` and must
 * encode them to send over JSON; the Core's option blobs include a base64url
 * challenge that the browser must decode back to an ArrayBuffer before
 * passing to `navigator.credentials`. This module is the single source of
 * truth for both directions so the two sides cannot drift.
 *
 * Deliberately does NOT depend on Buffer (Node-only) or atob/btoa with
 * binary-string gymnastics (silently corrupts non-ASCII bytes). Uses
 * Uint8Array + TextEncoder/Decoder so it works identically in every
 * EventTarget runtime HAWC targets.
 */

const STANDARD_TO_URL: Record<string, string> = { "+": "-", "/": "_" };
const URL_TO_STANDARD: Record<string, string> = { "-": "+", _: "/" };

export function encode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.byteLength; i++) binary += String.fromCharCode(view[i]);
  const b64 = (typeof btoa === "function"
    ? btoa(binary)
    : _nodeBase64(view));
  return b64.replaceAll("+", STANDARD_TO_URL["+"]).replaceAll("/", STANDARD_TO_URL["/"]).replace(/=+$/, "");
}

// base64url alphabet: A-Z a-z 0-9 - _ ; no padding at the boundary (we add it
// below). Any character outside this set is a protocol violation — the decoder
// used to silently ignore such inputs because both `atob` and the manual
// fallback would either throw cryptic errors or treat the unknown character
// as zero, producing bogus bytes the caller would then feed into WebAuthn
// primitives. Reject loudly so a tainted wire payload fails verification
// rather than round-tripping into mangled buffers.
const _BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/**
 * Decode a base64url string into a `Uint8Array` backed by a fresh
 * `ArrayBuffer`.
 *
 * Return-type note: the generic form `Uint8Array<ArrayBuffer>` requires
 * TypeScript 5.7 or newer. Under older compilers `lib.dom.d.ts` accepts
 * `Uint8Array<ArrayBufferLike>` as a BufferSource but not
 * `Uint8Array<ArrayBuffer>`, and dropping the generic would silently
 * coerce the return into `Uint8Array<ArrayBufferLike>` — which can alias
 * a SharedArrayBuffer and therefore fails WebAuthn's BufferSource
 * narrowing. The whole package is built against TS 5.9 (see the root
 * `typescript` devDependency), so we pin the tighter type here to keep
 * the wire boundary type-safe.
 */
export function decode(input: string): Uint8Array<ArrayBuffer> {
  if (typeof input !== "string") {
    throw new TypeError("[@wc-bindable/webauthn] base64url decode expects a string input.");
  }
  if (!_BASE64URL_PATTERN.test(input)) {
    throw new Error("[@wc-bindable/webauthn] invalid base64url input: contains characters outside A-Za-z0-9_-.");
  }
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const standard = padded.replaceAll("-", URL_TO_STANDARD["-"]).replaceAll("_", URL_TO_STANDARD._);
  const binary = typeof atob === "function"
    ? atob(standard)
    : _nodeBase64Decode(standard);
  // Explicit ArrayBuffer backing (not ArrayBufferLike) so the result is
  // usable as a DOM BufferSource without casts. Lib.dom's BufferSource
  // rejects Uint8Array<ArrayBufferLike> under TS 5.7+ because the latter
  // can alias a SharedArrayBuffer, which WebAuthn APIs forbid.
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function _nodeBase64(bytes: Uint8Array): string {
  // Fallback for environments without btoa (older Node). Modern Node 16+
  // has globalThis.btoa so this path is effectively unused in supported runtimes.
  const B = (globalThis as any).Buffer;
  if (B) return B.from(bytes).toString("base64");
  // Last-resort manual encoder — kept tiny to avoid pulling in a polyfill.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const chunk = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(chunk >> 18) & 63] + alphabet[(chunk >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[chunk & 63] : "=";
  }
  return out;
}

function _nodeBase64Decode(base64: string): string {
  const B = (globalThis as any).Buffer;
  if (B) return B.from(base64, "base64").toString("binary");
  // Mirror _nodeBase64: rarely reached in supported runtimes, but keeps the
  // module standalone for wildly stripped environments.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) lookup.set(alphabet[i], i);
  const clean = base64.replace(/=+$/, "");
  // Defensive lookup: the public `decode()` already rejects non-alphabet
  // input before it reaches us, but this helper is also reachable in
  // stripped runtimes and via direct imports in tests. Returning 0 for
  // an unknown byte (the prior `!` non-null assertion's effective
  // behavior) would silently corrupt the output; throw instead so the
  // caller cannot act on bogus bytes.
  const get = (ch: string | undefined): number => {
    if (ch === undefined) return 0;
    const v = lookup.get(ch);
    if (v === undefined) {
      throw new Error("[@wc-bindable/webauthn] invalid base64 character during decode.");
    }
    return v;
  };
  let out = "";
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = get(clean[i]);
    const n1 = get(clean[i + 1]);
    const n2 = i + 2 < clean.length ? get(clean[i + 2]) : 0;
    const n3 = i + 3 < clean.length ? get(clean[i + 3]) : 0;
    const chunk = (n0 << 18) | (n1 << 12) | (n2 << 6) | n3;
    out += String.fromCharCode((chunk >> 16) & 0xff);
    if (i + 2 < clean.length) out += String.fromCharCode((chunk >> 8) & 0xff);
    if (i + 3 < clean.length) out += String.fromCharCode(chunk & 0xff);
  }
  return out;
}

/** Generate a cryptographically random challenge of `len` bytes, base64url.
 *
 * Input validation: `len` must be a positive integer. Without this guard
 * `new Uint8Array(len)` accepts several pathological values that all fail
 * in different surprising ways downstream — `0` yields an empty challenge
 * (silently defeats replay protection), non-integers like `3.7` silently
 * truncate to `3`, and negatives throw a cryptic RangeError from the
 * Uint8Array constructor. Reject loudly at the boundary so callers cannot
 * accidentally produce unsafe challenges. */
export function randomChallenge(len: number): string {
  if (!Number.isInteger(len) || len <= 0) {
    throw new Error("[@wc-bindable/webauthn] randomChallenge length must be a positive integer.");
  }
  const bytes = new Uint8Array(len);
  const cryptoObj: Crypto | undefined =
    (globalThis as any).crypto ?? (globalThis as any).webcrypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error("[@wc-bindable/webauthn] no Crypto.getRandomValues available in this runtime.");
  }
  cryptoObj.getRandomValues(bytes);
  return encode(bytes);
}
