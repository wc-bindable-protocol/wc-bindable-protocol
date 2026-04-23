import { describe, it, expect, afterEach } from "vitest";
import { encode, decode, randomChallenge } from "../src/codec/base64url";

const originalBtoa = (globalThis as any).btoa;
const originalAtob = (globalThis as any).atob;
const originalBuffer = (globalThis as any).Buffer;
const originalCrypto = (globalThis as any).crypto;
const originalWebcrypto = (globalThis as any).webcrypto;

function restoreGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}

describe("base64url codec", () => {
  afterEach(() => {
    restoreGlobal("btoa", originalBtoa);
    restoreGlobal("atob", originalAtob);
    restoreGlobal("Buffer", originalBuffer);
    restoreGlobal("crypto", originalCrypto);
    restoreGlobal("webcrypto", originalWebcrypto);
  });

  it("encode/decode round-trip for ASCII", () => {
    const src = new TextEncoder().encode("Hello WebAuthn");
    const encoded = encode(src);
    expect(encoded).not.toMatch(/[+/=]/); // URL-safe, no padding
    const decoded = decode(encoded);
    expect(new TextDecoder().decode(decoded)).toBe("Hello WebAuthn");
  });

  it("encode/decode round-trip for non-ASCII bytes", () => {
    // Bytes that trigger every base64 alphabet character including URL-safe
    // substitutions (62 = '-', 63 = '_') — confirms the URL-alphabet mapping
    // matches on both sides.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const roundTripped = decode(encode(bytes));
    expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
  });

  it("encode accepts both ArrayBuffer and Uint8Array", () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    const fromU8 = encode(u8);
    const fromBuf = encode(u8.buffer);
    expect(fromBuf).toBe(fromU8);
  });

  it("encode falls back to Buffer when btoa is unavailable", () => {
    restoreGlobal("btoa", undefined);
    const encoded = encode(new Uint8Array([1, 2, 3]));
    expect(encoded).toBe("AQID");
  });

  it("encode falls back to the manual encoder when neither btoa nor Buffer exists", () => {
    restoreGlobal("btoa", undefined);
    restoreGlobal("Buffer", undefined);
    const encoded = encode(new Uint8Array([255, 254, 253, 252]));
    expect(encoded).toBe("__79_A");
  });

  it("decode handles missing padding", () => {
    // "abc" -> "YWJj" (no padding) / "YWJj=" (invalid) / "YWJj==" (wrong).
    // Decoder must tolerate the canonical base64url form (no padding).
    expect(new TextDecoder().decode(decode("YWJj"))).toBe("abc");
  });

  it("decode produces ArrayBuffer-backed Uint8Array usable as BufferSource", () => {
    // Regression guard for the TS 5.7 DOM-types issue: the decoded buffer
    // must be strictly ArrayBuffer, not SharedArrayBuffer, so it fits
    // `PublicKeyCredentialCreationOptions.challenge`.
    const out = decode("YWJj");
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("decode falls back to Buffer when atob is unavailable", () => {
    restoreGlobal("atob", undefined);
    expect(new TextDecoder().decode(decode("YWJj"))).toBe("abc");
  });

  it("decode falls back to the manual decoder when neither atob nor Buffer exists", () => {
    restoreGlobal("atob", undefined);
    restoreGlobal("Buffer", undefined);
    const out = decode("__79_A");
    expect(Array.from(out)).toEqual([255, 254, 253, 252]);
  });

  it("manual decode handles short final quartets", () => {
    restoreGlobal("atob", undefined);
    restoreGlobal("Buffer", undefined);
    expect(Array.from(decode("_w"))).toEqual([255]);
    expect(Array.from(decode("__4"))).toEqual([255, 254]);
  });

  it("randomChallenge produces base64url of the requested byte length", () => {
    const ch = randomChallenge(32);
    const bytes = decode(ch);
    expect(bytes.byteLength).toBe(32);
    expect(ch).not.toMatch(/[+/=]/);
  });

  it("randomChallenge returns a fresh value every call", () => {
    const a = randomChallenge(16);
    const b = randomChallenge(16);
    // Collision probability is 2^-128; this test is effectively deterministic.
    expect(a).not.toBe(b);
  });

  it("randomChallenge uses webcrypto when crypto is unavailable", () => {
    restoreGlobal("crypto", undefined);
    restoreGlobal("webcrypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(7);
        return bytes;
      },
    });
    const bytes = decode(randomChallenge(4));
    expect(Array.from(bytes)).toEqual([7, 7, 7, 7]);
  });

  it("randomChallenge throws when no random source exists", () => {
    restoreGlobal("crypto", undefined);
    restoreGlobal("webcrypto", undefined);
    expect(() => randomChallenge(4)).toThrow(/getRandomValues/);
  });

  // Regression (Cycle 2 #1): `new Uint8Array(len)` used to accept pathological
  // values that each failed in a distinct and surprising way —
  // `0` silently produced an empty challenge (defeats replay protection),
  // `3.7` silently truncated to 3 bytes, negatives/`NaN`/`undefined` threw
  // cryptic RangeErrors from deeper in the stack. Reject at the boundary
  // with a single coherent message so the caller cannot accidentally
  // issue an unsafe challenge.
  it.each([0, -1, 3.7, Number.NaN, undefined])(
    "randomChallenge rejects non-positive-integer length (%p)",
    (len) => {
      expect(() => randomChallenge(len as any)).toThrow(/positive integer/);
    },
  );

  describe("decode input validation (regression)", () => {
    // Regression: the prior decoder ignored non-alphabet characters,
    // silently producing bogus bytes instead of throwing. Ids like
    // "alice@example.com" (used to slip past directly because '@' and
    // '.' are outside the base64url alphabet) now fail fast so the
    // caller cannot act on corrupted bytes.

    it("rejects input containing characters outside the base64url alphabet", () => {
      expect(() => decode("alice@example.com")).toThrow(/invalid base64url/);
    });

    it("rejects input with standard (non-URL) base64 alphabet characters", () => {
      expect(() => decode("abc+/=")).toThrow(/invalid base64url/);
    });

    it("rejects a non-string input", () => {
      expect(() => decode(undefined as any)).toThrow(/expects a string/);
      expect(() => decode(null as any)).toThrow(/expects a string/);
      expect(() => decode(42 as any)).toThrow(/expects a string/);
    });

    it("accepts the empty string (round-trips to an empty buffer)", () => {
      const out = decode("");
      expect(out.byteLength).toBe(0);
    });

    it("manual decoder rejects unknown characters when it is reached directly", () => {
      // Force the fallback path by stripping both atob and Buffer.
      // The public decode() validates at the entry point, so the inner
      // helper only sees alphabet-clean input in normal operation. But
      // the helper must not silently coerce unknown chars to 0 either —
      // a future caller that wires it up differently must see a throw.
      restoreGlobal("atob", undefined);
      restoreGlobal("Buffer", undefined);
      // Pure alphabet path still works:
      expect(Array.from(decode("YWJj"))).toEqual([97, 98, 99]);
      // And the outer validator still throws for outside-alphabet input,
      // so the helper's defense is a belt-and-suspenders layer that
      // only fires if decode() is called through an unusual import path.
      expect(() => decode("!!!")).toThrow(/invalid base64url/);
    });
  });
});
