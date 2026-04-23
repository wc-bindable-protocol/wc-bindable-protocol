import {
  IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload, MultipartPart,
} from "../types.js";
import { presignS3Url, SigV4Credentials } from "../signing/sigv4.js";
import { raiseError } from "../raiseError.js";
import { readProcessEnv } from "../processEnv.js";

/**
 * Tolerant single-tag XML extractor. S3 namespaces the tags but the local
 * name is unique enough. Handles namespace-prefixed forms (`<x:tag>...`)
 * and optional XML attributes on the opening tag (`<tag attr="...">`), and
 * captures values that span newlines (pretty-printed XML).
 *
 * LIMITATIONS: this is strictly regex-based. It does NOT handle:
 *   - CDATA sections (`<tag><![CDATA[...]]></tag>`) — the inner `]]>` and
 *     `<![CDATA[` markers will leak into the returned value.
 *   - XML entity-escaped content (`&amp;`, `&lt;`, `&#x41;`, etc.) — the
 *     raw entity text is returned, NOT the decoded character.
 *   - Nested tags with the same local name — the lazy `.*?` grabs the first
 *     closing tag, which for well-formed S3 responses is always the intended
 *     one but would mis-parse a hand-crafted pathological document.
 *
 * Real S3 responses for the operations we call (CreateMultipartUpload,
 * CompleteMultipartUpload, error bodies) never use CDATA and only entity-escape
 * `&` / `<` / `>` in user-controlled fields like object keys — which this
 * code path does not re-parse. If a future S3-compatible provider emits
 * entity-escaped `UploadId`, `ETag`, `Code`, or `Message`, swap this to a
 * DOMParser-based extraction.
 */
function extractTag(xml: string, tag: string): string | null {
  // Match `<tag>value</tag>` allowing namespace-prefixed forms (`<x:tag>...`)
  // AND optional XML attributes on the opening tag (`<tag attr="...">`). The
  // previous regex required `>` immediately after the tag name, which meant
  // any S3-compatible server that emitted e.g. `<UploadId xmlns="...">` would
  // silently fail extraction. Also switched to `[\s\S]*?` for the value so
  // tags whose content spans newlines (pretty-printed XML) are captured.
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

function buildCompleteXml(parts: MultipartPart[]): string {
  // S3 expects parts in ascending PartNumber order; the wrapper sorts to be
  // resilient to parallel-upload completion order from the browser.
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const items = sorted.map(p => {
    // ETag must be the quoted form S3 returned. If the caller stripped the
    // outer quotes, re-wrap to keep S3 happy.
    const etag = /^".*"$/.test(p.etag) ? p.etag : `"${p.etag}"`;
    return `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${etag}</ETag></Part>`;
  }).join("");
  return `<CompleteMultipartUpload>${items}</CompleteMultipartUpload>`;
}

export interface AwsS3ProviderOptions {
  region?: string;
  /** Optional explicit credentials. When omitted, env vars are read. */
  credentials?: SigV4Credentials;
  /** Custom endpoint for S3-compatible stores (R2, MinIO, Wasabi). */
  endpoint?: string;
  /** Force path-style URLs (required for MinIO, optional for AWS). */
  forcePathStyle?: boolean;
  /** Default presigned URL lifetime, in seconds. */
  defaultExpiresInSeconds?: number;
  /**
   * Timeout (ms) for the provider's own control-plane HTTP calls —
   * deleteObject, initiateMultipart, completeMultipart, abortMultipart.
   * Does NOT apply to the data-plane PUTs the browser runs against the
   * presigned URLs (those are not issued by this provider). Protects
   * against a stalled S3 endpoint / misrouted DNS hanging the server
   * worker forever. Default 30 000 ms (30 s). Set to `0` to disable the
   * timeout (not recommended outside tests).
   */
  controlPlaneTimeoutMs?: number;
}

function resolveCredentials(opts: AwsS3ProviderOptions): SigV4Credentials {
  if (opts.credentials) return opts.credentials;
  const accessKeyId = readProcessEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readProcessEnv("AWS_SECRET_ACCESS_KEY");
  // An empty AWS_SESSION_TOKEN (e.g. shell `export AWS_SESSION_TOKEN=`)
  // must be treated as "unset", not as the literal empty string. Passing ""
  // through to SigV4Credentials would cause presignS3Url to emit an empty
  // `X-Amz-Security-Token` query parameter — which some S3-compatible servers
  // hard-reject, and which confuses AWS telemetry as "STS token present but
  // empty". Coercing falsy to `undefined` matches the accessKeyId/secretAccessKey
  // emptiness semantics below.
  const sessionTokenRaw = readProcessEnv("AWS_SESSION_TOKEN");
  const sessionToken = sessionTokenRaw || undefined;
  if (!accessKeyId || !secretAccessKey) {
    raiseError("AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars, or pass credentials option.");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function resolveRegion(opts: AwsS3ProviderOptions): string {
  const region = opts.region ?? readProcessEnv("AWS_REGION") ?? readProcessEnv("AWS_DEFAULT_REGION");
  if (!region) raiseError("AWS region not found. Set AWS_REGION env var or pass region option.");
  return region;
}

/**
 * Default S3 provider. Generates presigned URLs server-side using SigV4.
 * The browser uploads / downloads / deletes directly against S3 — the Core
 * never touches the blob payload.
 */
export class AwsS3Provider implements IS3Provider {
  private _credentials: SigV4Credentials;
  private _region: string;
  private _endpoint?: string;
  private _forcePathStyle?: boolean;
  private _defaultExpires: number;
  private _controlPlaneTimeoutMs: number;

  constructor(options: AwsS3ProviderOptions = {}) {
    this._credentials = resolveCredentials(options);
    this._region = resolveRegion(options);
    this._endpoint = options.endpoint;
    this._forcePathStyle = options.forcePathStyle;
    this._defaultExpires = options.defaultExpiresInSeconds ?? 900; // 15 min
    // Default 30 s — matches the AWS SDK's default socket timeout and is
    // well above typical control-plane latency (p99 for CreateMultipartUpload
    // is under 1 s). 0 disables the timeout — test code uses this to avoid
    // racing with the mock server.
    this._controlPlaneTimeoutMs = options.controlPlaneTimeoutMs ?? 30000;
  }

  /**
   * Build a fetch init object with an AbortSignal bound to the configured
   * control-plane timeout, merging any caller-supplied signal. Used for
   * every control-plane call (delete, initiate/complete/abort multipart) so
   * a hanging S3 endpoint cannot wedge the server worker.
   *
   * Uses `AbortSignal.timeout(ms)` when available (modern browsers + Node
   * 17.3+). Falls back to a manually wired `AbortController` + `setTimeout`
   * when it is not — we target environments where `fetch` exists, but some
   * older embedded runtimes ship fetch without the static timeout helper.
   */
  private _withTimeout(init: RequestInit = {}): { init: RequestInit; cleanup: () => void } {
    if (this._controlPlaneTimeoutMs <= 0) {
      return { init, cleanup: () => {} };
    }
    if (typeof (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout === "function") {
      return {
        init: { ...init, signal: AbortSignal.timeout(this._controlPlaneTimeoutMs) },
        cleanup: () => {},
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._controlPlaneTimeoutMs);
    return {
      init: { ...init, signal: controller.signal },
      cleanup: () => clearTimeout(timer),
    };
  }

  private _resolveKey(key: string, prefix?: string): string {
    if (!key) raiseError("key is required.");
    const p = prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";
    const k = key.replace(/^\/+/, "");
    return p ? `${p}/${k}` : k;
  }

  async presignUpload(key: string, opts: S3RequestOptions): Promise<PresignedUpload> {
    const fullKey = this._resolveKey(key, opts.prefix);
    const result = await presignS3Url(this._credentials, {
      method: "PUT",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: opts.expiresInSeconds ?? this._defaultExpires,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
    });
    // Content-Type is intentionally NOT signed (UNSIGNED-PAYLOAD + host-only signed headers).
    // The browser may set it freely on the PUT; S3 records whatever is sent.
    const headers: Record<string, string> = {};
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    return {
      url: result.url,
      method: "PUT",
      headers,
      expiresAt: result.expiresAt,
    };
  }

  async presignDownload(key: string, opts: S3RequestOptions): Promise<PresignedDownload> {
    const fullKey = this._resolveKey(key, opts.prefix);
    const result = await presignS3Url(this._credentials, {
      method: "GET",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: opts.expiresInSeconds ?? this._defaultExpires,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
    });
    return { url: result.url, method: "GET", expiresAt: result.expiresAt };
  }

  async deleteObject(key: string, opts: S3RequestOptions): Promise<void> {
    const fullKey = this._resolveKey(key, opts.prefix);
    // Delete is performed server-side via a one-shot presigned URL. This keeps
    // the provider purely sign-based without an HTTP client of its own beyond fetch.
    const result = await presignS3Url(this._credentials, {
      method: "DELETE",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: 60,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
    });
    const { init, cleanup } = this._withTimeout({ method: "DELETE" });
    let res: Response;
    try {
      res = await globalThis.fetch(result.url, init);
    } finally {
      cleanup();
    }
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => "");
      raiseError(`delete failed (${res.status}): ${body}`);
    }
  }

  // --- Multipart upload ---

  async initiateMultipart(key: string, opts: S3RequestOptions): Promise<{ uploadId: string }> {
    const fullKey = this._resolveKey(key, opts.prefix);
    // S3 starts a multipart upload via POST <key>?uploads. The presigned URL
    // includes `uploads=` (empty value); our SigV4 signs it as part of the
    // canonical query string.
    const presigned = await presignS3Url(this._credentials, {
      method: "POST",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: 60,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
      extraQuery: { uploads: "" },
    });
    const headers: Record<string, string> = {};
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    const { init, cleanup } = this._withTimeout({ method: "POST", headers });
    let res: Response;
    try {
      res = await globalThis.fetch(presigned.url, init);
    } finally {
      cleanup();
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      raiseError(`initiateMultipart failed (${res.status}): ${body}`);
    }
    const xml = await res.text();
    const uploadId = extractTag(xml, "UploadId");
    if (!uploadId) raiseError(`initiateMultipart returned no UploadId: ${xml}`);
    return { uploadId };
  }

  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    opts: S3RequestOptions,
  ): Promise<PresignedUpload> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      raiseError(`partNumber must be an integer between 1 and 10000, got ${partNumber}.`);
    }
    if (!uploadId) raiseError("uploadId is required.");
    const fullKey = this._resolveKey(key, opts.prefix);
    const result = await presignS3Url(this._credentials, {
      method: "PUT",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: opts.expiresInSeconds ?? this._defaultExpires,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
      extraQuery: { partNumber: String(partNumber), uploadId },
    });
    return { url: result.url, method: "PUT", headers: {}, expiresAt: result.expiresAt };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
    opts: S3RequestOptions,
  ): Promise<{ etag: string }> {
    if (!parts.length) raiseError("completeMultipart requires at least one part.");
    const fullKey = this._resolveKey(key, opts.prefix);
    const presigned = await presignS3Url(this._credentials, {
      method: "POST",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: 300,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
      extraQuery: { uploadId },
    });
    const body = buildCompleteXml(parts);
    const { init, cleanup } = this._withTimeout({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
    });
    let res: Response;
    try {
      res = await globalThis.fetch(presigned.url, init);
    } finally {
      cleanup();
    }
    const xml = await res.text();
    if (!res.ok) raiseError(`completeMultipart failed (${res.status}): ${xml}`);
    // S3 can return a 200 with an Error body when finalize fails after the
    // upload has been "accepted" — detect by looking for an <Error> tag.
    if (/<Error>/.test(xml)) {
      const code = extractTag(xml, "Code") ?? "Unknown";
      const message = extractTag(xml, "Message") ?? "";
      raiseError(`completeMultipart S3 error: ${code} ${message}`);
    }
    const rawEtag = extractTag(xml, "ETag");
    if (rawEtag === null || rawEtag === "") {
      // The 200-without-<Error> path is the "success" path per the S3 spec,
      // but an S3-compatible implementation or a misbehaving proxy can
      // return a malformed body that neither signals an error nor contains
      // an ETag. Treating that as success (etag: "") lets the upload pass
      // completion, silently breaks any integrity check downstream, and
      // corrupts the metadata the registerPostProcess hook hands to the
      // database. Fail loudly instead; the caller can retry or abort.
      raiseError(`completeMultipart returned no ETag: ${xml}`);
    }
    const etag = rawEtag.replace(/^"|"$/g, "");
    return { etag };
  }

  async abortMultipart(key: string, uploadId: string, opts: S3RequestOptions): Promise<void> {
    if (!uploadId) raiseError("uploadId is required.");
    const fullKey = this._resolveKey(key, opts.prefix);
    const presigned = await presignS3Url(this._credentials, {
      method: "DELETE",
      region: this._region,
      bucket: opts.bucket,
      key: fullKey,
      expiresInSeconds: 60,
      endpoint: this._endpoint,
      forcePathStyle: this._forcePathStyle,
      extraQuery: { uploadId },
    });
    const { init, cleanup } = this._withTimeout({ method: "DELETE" });
    let res: Response;
    try {
      res = await globalThis.fetch(presigned.url, init);
    } finally {
      cleanup();
    }
    // S3 returns 204 on success; 404 means it was already aborted/expired —
    // treat as success so callers can safely "abort to clean up" without
    // worrying about races with auto-expiration.
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      const body = await res.text().catch(() => "");
      raiseError(`abortMultipart failed (${res.status}): ${body}`);
    }
  }
}
