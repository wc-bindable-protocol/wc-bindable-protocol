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

export function decode(input: string): Uint8Array<ArrayBuffer> {
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
  let out = "";
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = lookup.get(clean[i])!;
    const n1 = lookup.get(clean[i + 1])!;
    const n2 = i + 2 < clean.length ? lookup.get(clean[i + 2])! : 0;
    const n3 = i + 3 < clean.length ? lookup.get(clean[i + 3])! : 0;
    const chunk = (n0 << 18) | (n1 << 12) | (n2 << 6) | n3;
    out += String.fromCharCode((chunk >> 16) & 0xff);
    if (i + 2 < clean.length) out += String.fromCharCode((chunk >> 8) & 0xff);
    if (i + 3 < clean.length) out += String.fromCharCode(chunk & 0xff);
  }
  return out;
}

/** Generate a cryptographically random challenge of `len` bytes, base64url. */
export function randomChallenge(len: number): string {
  const bytes = new Uint8Array(len);
  const cryptoObj: Crypto | undefined =
    (globalThis as any).crypto ?? (globalThis as any).webcrypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error("[@wc-bindable/hawc-webauthn] no Crypto.getRandomValues available in this runtime.");
  }
  cryptoObj.getRandomValues(bytes);
  return encode(bytes);
}
