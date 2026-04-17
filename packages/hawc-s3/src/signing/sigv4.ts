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
}

export interface SigV4PresignResult {
  url: string;
  expiresAt: number;
}

const subtle = (): SubtleCrypto => {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) {
    throw new Error("[@wc-bindable/hawc-s3] Web Crypto (crypto.subtle) is required. Use Node 19+ or a modern browser.");
  }
  return c.subtle;
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
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
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
  // Pre-size the output: in the worst case every byte becomes %XX (3 chars).
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (
      (b >= 0x41 && b <= 0x5A) ||  // A-Z
      (b >= 0x61 && b <= 0x7A) ||  // a-z
      (b >= 0x30 && b <= 0x39) ||  // 0-9
      b === 0x5F || b === 0x2D || b === 0x7E || b === 0x2E  // _ - ~ .
    ) {
      out += String.fromCharCode(b);
    } else if (b === 0x2F) {  // '/'
      out += encodeSlash ? "%2F" : "/";
    } else {
      // Two-digit uppercase hex per the SigV4 spec.
      out += "%" + (b < 0x10 ? "0" : "") + b.toString(16).toUpperCase();
    }
  }
  return out;
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
    throw new Error("[@wc-bindable/hawc-s3] missing AWS credentials.");
  }
  if (!params.region) throw new Error("[@wc-bindable/hawc-s3] missing region.");
  if (!params.bucket) throw new Error("[@wc-bindable/hawc-s3] missing bucket.");
  if (!params.key) throw new Error("[@wc-bindable/hawc-s3] missing key.");
  // AWS hard cap.
  const expires = Math.min(Math.max(1, params.expiresInSeconds | 0), 604800);

  const now = params.now ?? Date.now();
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

  const query: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
    ...(creds.sessionToken ? { "X-Amz-Security-Token": creds.sessionToken } : {}),
    ...(params.extraQuery ?? {}),
  };

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery(query),
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

  const finalQuery = `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
  return {
    url: `${protocol}//${host}${canonicalUri}?${finalQuery}`,
    expiresAt: now + expires * 1000,
  };
}
