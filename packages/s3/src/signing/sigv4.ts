/**
 * Minimal AWS Signature V4 presigner for S3 GET/PUT/DELETE.
 *
 * Implemented against Web Crypto (globalThis.crypto.subtle) so it works
 * unchanged on Node 19+ and modern browsers without an AWS SDK.
 *
 * Only the subset required for presigned URLs is covered:
 *   - UNSIGNED-PAYLOAD payload hash (the body never flows through Core)
 *   - host as the only signed header
 *   - virtual-hosted-style and path-style endpoints
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/**
 * Query-string keys reserved for SigV4 presigned-URL construction. A caller-
 * supplied `extraQuery` that includes any of these would shadow the values
 * we emit below, producing a URL whose claims don't match its signature.
 * The check is case-insensitive — AWS matches these as-is on the URL, but
 * a buggy caller could pass lower-case and still forge if we compared
 * case-sensitively.
 *
 * Intentionally NOT a blanket `x-amz-*` prefix reject: S3 accepts many other
 * `x-amz-*` request parameters via the query string (object metadata,
 * server-side-encryption options, ACL, etc.), and rejecting them blanket
 * would force callers into awkward workarounds for legitimate features.
 */
const RESERVED_SIGV4_QUERY_KEYS: ReadonlySet<string> = new Set([
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-signedheaders",
  "x-amz-security-token",
  "x-amz-signature",
]);

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4PresignParams {
  method: "GET" | "PUT" | "POST" | "DELETE";
  region: string;
  bucket: string;
  key: string;
  /** epoch ms — defaults to Date.now(). Injected for deterministic tests. */
  now?: number;
  /** validity window in seconds, AWS caps at 604800 (7 days). */
  expiresInSeconds: number;
  /** optional explicit endpoint (e.g. R2/MinIO). Defaults to AWS virtual-hosted style. */
  endpoint?: string;
  /** override request style. `auto` -> virtual-hosted for AWS, path for explicit endpoint. */
  forcePathStyle?: boolean;
  /** extra query params to include in the signature (and final URL). */
  extraQuery?: Record<string, string>;
  /**
   * Maximum tolerated drift between the signer's clock and a reference clock
   * (`referenceNow`, defaulting to `Date.now()`). When set and `params.now`
   * is outside this window relative to the reference, `presignS3Url` throws
   * before building a URL that AWS is guaranteed to reject with
   * `RequestTimeTooSkewed`. Helps surface clock-drift in a server-side
   * signer instead of letting 403s appear client-side as opaque
   * `AccessDenied`s. Default: unused (no check).
   */
  allowableClockSkewMs?: number;
  /**
   * Reference clock for the skew check above. Defaults to `Date.now()`.
   * Injected for deterministic tests.
   */
  referenceNow?: number;
}

export interface SigV4PresignResult {
  url: string;
  expiresAt: number;
}

/**
 * Thrown when `presignS3Url` detects that the signer's local clock is too far
 * out of sync with the reference clock (see `allowableClockSkewMs`). Catches
 * the failure at signing time instead of letting the caller see an opaque
 * AWS 403 (`RequestTimeTooSkewed`) at PUT time.
 */
export class SkewError extends Error {
  declare readonly name: "SkewError";
  readonly skewMs: number;
  readonly allowedMs: number;
  constructor(skewMs: number, allowedMs: number) {
    super(`[@wc-bindable/s3] clock skew ${skewMs}ms exceeds allowable ${allowedMs}ms (signer clock vs reference).`);
    this.name = "SkewError";
    this.skewMs = skewMs;
    this.allowedMs = allowedMs;
  }
}

const subtle = (): SubtleCrypto => {
  // `globalThis.crypto` is typed as `Crypto` in modern lib.dom.d.ts; no `any`
  // cast is needed. The optional chain on `.subtle` keeps us safe against
  // exotic runtimes (old Node, iframes with crypto blocked) where `crypto`
  // exists without `subtle`.
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error("[@wc-bindable/s3] Web Crypto (crypto.subtle) is required. Use Node 19+ or a modern browser.");
  }
  return s;
};

const enc = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  // TS 5.7's Uint8Array generic narrowing requires an explicit cast for Web Crypto
  // input — the underlying ArrayBufferLike is BufferSource-compatible at runtime.
  const digest = await subtle().digest("SHA-256", buf as BufferSource);
  return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle().sign("HMAC", cryptoKey, enc.encode(data) as BufferSource);
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  // Array+join avoids the O(n^2) string concat cost on V8 for the typical
  // 32 / 64 byte buffers this sees — not a hot path, but harmless, and
  // easier to reason about if the digest size grows later.
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return parts.join("");
}

/**
 * RFC3986 percent-encoding per AWS SigV4 spec.
 * `encodeSlash=false` preserves the '/' in S3 object keys.
 *
 * Encodes the **UTF-8 byte sequence** of `str`, not its UTF-16 code units.
 * The naive char-by-char form (using `charAt(i)` + `encodeURIComponent(ch)`)
 * splits surrogate pairs and throws `URIError: URI malformed` on every emoji
 * or non-BMP CJK character (e.g. 😀, 𠮷). S3 object keys are full UTF-8, so
 * that path is unusable in production. Iterating bytes from TextEncoder gives
 * us the canonical UTF-8 percent-encoding required by SigV4.
 */
function awsEncode(str: string, encodeSlash = true): string {
  const bytes = enc.encode(str);
  // Collect emitted tokens into an array and join once at the end. V8
  // optimises repeated `out += …` to a rope internally, but for the bucket-
  // /key-length strings this sees (typically < 1 KiB) the pre-sized array
  // form is both marginally faster and easier to reason about if the input
  // size ever grows. Worst-case every byte produces 3 chars (`%XX`), so the
  // pre-allocated slot count equals `bytes.length`.
  const parts: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (
      (b >= 0x41 && b <= 0x5A) ||  // A-Z
      (b >= 0x61 && b <= 0x7A) ||  // a-z
      (b >= 0x30 && b <= 0x39) ||  // 0-9
      b === 0x5F || b === 0x2D || b === 0x7E || b === 0x2E  // _ - ~ .
    ) {
      parts[i] = String.fromCharCode(b);
    } else if (b === 0x2F) {  // '/'
      parts[i] = encodeSlash ? "%2F" : "/";
    } else {
      // Two-digit uppercase hex per the SigV4 spec.
      parts[i] = "%" + (b < 0x10 ? "0" : "") + b.toString(16).toUpperCase();
    }
  }
  return parts.join("");
}

function formatAmzDate(d: Date): { amzDate: string; dateStamp: string } {
  // ISO8601 basic format: YYYYMMDDTHHMMSSZ + YYYYMMDD
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return {
    amzDate: `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`,
    dateStamp: `${yyyy}${mm}${dd}`,
  };
}

function buildHost(bucket: string, region: string, endpoint: string | undefined, pathStyle: boolean): { host: string; pathPrefix: string; protocol: string } {
  if (endpoint) {
    const u = new URL(endpoint);
    const host = u.host;
    // Preserve any path component on the endpoint. A reverse-proxy setup like
    // `https://example.com/storage` must route through `/storage/<bucket>/<key>`,
    // and dropping `u.pathname` here (as an earlier revision did) built URLs
    // that targeted the proxy root and 404'd for every object.
    //
    // `URL` normalises a bare origin to pathname `/`; strip both the leading
    // and trailing slash so we can concatenate cleanly against the bucket /
    // key segments we build below.
    const rawPath = u.pathname.replace(/^\/+|\/+$/g, "");
    const endpointPath = rawPath ? `/${rawPath}` : "";
    if (pathStyle) {
      return { host, pathPrefix: `${endpointPath}/${bucket}`, protocol: u.protocol };
    }
    return { host: `${bucket}.${host}`, pathPrefix: endpointPath, protocol: u.protocol };
  }
  if (pathStyle) {
    return { host: `s3.${region}.amazonaws.com`, pathPrefix: `/${bucket}`, protocol: "https:" };
  }
  return { host: `${bucket}.s3.${region}.amazonaws.com`, pathPrefix: "", protocol: "https:" };
}

function canonicalQuery(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  return keys
    .map(k => `${awsEncode(k)}=${awsEncode(params[k])}`)
    .join("&");
}

export async function presignS3Url(
  creds: SigV4Credentials,
  params: SigV4PresignParams,
): Promise<SigV4PresignResult> {
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error("[@wc-bindable/s3] missing AWS credentials.");
  }
  if (!params.region) throw new Error("[@wc-bindable/s3] missing region.");
  if (!params.bucket) throw new Error("[@wc-bindable/s3] missing bucket.");
  if (!params.key) throw new Error("[@wc-bindable/s3] missing key.");
  // AWS hard cap is 604800 seconds (7 days). Validate the input shape before
  // coercion: `| 0` is a signed int32 conversion and silently wraps values >=
  // 2^31 to negative numbers — `Math.max(1, ...)` then hides the wrap by
  // clamping to 1 second, producing a presigned URL that expires almost
  // immediately. Caller gets no signal that the lifetime they asked for was
  // discarded. Reject non-finite values and values above the S3 ceiling
  // loudly instead; truncate with `Math.trunc` for floats so the subsequent
  // arithmetic stays integer-valued.
  const rawExpires = params.expiresInSeconds;
  if (!Number.isFinite(rawExpires)) {
    throw new Error(`[@wc-bindable/s3] expiresInSeconds must be a finite number, got ${rawExpires}.`);
  }
  if (rawExpires > 604800) {
    throw new Error(`[@wc-bindable/s3] expiresInSeconds exceeds AWS limit of 604800 (7 days), got ${rawExpires}.`);
  }
  const expires = Math.min(Math.max(1, Math.trunc(rawExpires)), 604800);

  const now = params.now ?? Date.now();
  if (
    typeof params.allowableClockSkewMs === "number"
    && Number.isFinite(params.allowableClockSkewMs)
    && params.allowableClockSkewMs >= 0
  ) {
    const ref = params.referenceNow ?? Date.now();
    const skew = Math.abs(now - ref);
    if (skew > params.allowableClockSkewMs) {
      throw new SkewError(skew, params.allowableClockSkewMs);
    }
  }
  const date = new Date(now);
  const { amzDate, dateStamp } = formatAmzDate(date);

  const pathStyle = params.forcePathStyle ?? !!params.endpoint;
  const { host, pathPrefix, protocol } = buildHost(params.bucket, params.region, params.endpoint, pathStyle);

  // S3 keys are conventionally written without a leading slash; tolerate either.
  const cleanKey = params.key.replace(/^\/+/, "");
  const canonicalUri = `${pathPrefix}/${awsEncode(cleanKey, false)}`;

  const credentialScope = `${dateStamp}/${params.region}/${SERVICE}/aws4_request`;
  const credential = `${creds.accessKeyId}/${credentialScope}`;
  const signedHeaders = "host";

  // Reject any attempt to override reserved SigV4 query parameters via
  // `extraQuery`. Allowing them through would let a caller clobber the
  // algorithm / credential / date fields we build below, producing a signed
  // URL whose claims do not match its signature. Fail loudly here rather
  // than trusting the spread-merge order; a shipped override bug would only
  // surface as S3 403s (hard to correlate) or, in S3-compatible servers
  // that are lax about validation, accept a forged `X-Amz-Credential`.
  //
  // The reject list is an exact-name allowlist of the 7 SigV4 query-string
  // parameters we build below. Previously we rejected the entire `x-amz-*`
  // prefix, which incorrectly blocked legitimate S3 request-level knobs like
  // `x-amz-meta-*` (user metadata), `x-amz-server-side-encryption`, and
  // `x-amz-acl` that callers pass as query-string form when presigning
  // POST / PUT URLs. These are NOT SigV4 authentication fields — they are
  // S3 request parameters that happen to share the `x-amz-` vendor prefix.
  if (params.extraQuery) {
    for (const k of Object.keys(params.extraQuery)) {
      if (RESERVED_SIGV4_QUERY_KEYS.has(k.toLowerCase())) {
        throw new Error(`[@wc-bindable/s3] extraQuery must not include reserved SigV4 parameter "${k}".`);
      }
    }
  }

  const query: Record<string, string> = {
    // User-supplied extraQuery goes FIRST so the built-in SigV4 parameters
    // below take precedence if there is any accidental overlap that slipped
    // past the guard above. Belt-and-braces.
    ...(params.extraQuery ?? {}),
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
    ...(creds.sessionToken ? { "X-Amz-Security-Token": creds.sessionToken } : {}),
  };

  // Canonicalise once and reuse for both the signing string and the final
  // URL assembly. The prior double call re-sorted+encoded the query params
  // on every presign — cheap per-request but a needless repeat of identical
  // work, and (subtly) a correctness trap if the encoding ever became
  // non-deterministic for a given `query` shape.
  const canonQueryStr = canonicalQuery(query);

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonQueryStr,
    `host:${host}\n`,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(enc.encode("AWS4" + creds.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, params.region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const finalQuery = `${canonQueryStr}&X-Amz-Signature=${signature}`;
  return {
    url: `${protocol}//${host}${canonicalUri}?${finalQuery}`,
    expiresAt: now + expires * 1000,
  };
}
