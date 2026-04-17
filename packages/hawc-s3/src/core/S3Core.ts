import { raiseError } from "../raiseError.js";
import {
  IWcBindable, IS3Provider, S3RequestOptions, PresignedUpload, PresignedDownload,
  S3ObjectMetadata, S3Progress, PostProcessHook, PostProcessContext, S3Error,
  MultipartInit, MultipartPartUrl, MultipartPart,
} from "../types.js";

/** S3 minimum part size (5 MiB) — last part is exempt. */
const S3_MIN_PART_SIZE = 5 * 1024 * 1024;
/** AWS hard cap on parts per upload. */
const S3_MAX_PARTS = 10000;
/** Default part size: 8 MiB. Auto-scaled upward to fit S3_MAX_PARTS. */
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

/**
 * Compute a part size that:
 *   - meets S3's 5 MiB minimum (except the last part),
 *   - keeps the total part count <= 10000,
 *   - prefers the configured default for small/medium uploads.
 */
function computePartSize(totalSize: number, requested: number = DEFAULT_PART_SIZE): number {
  const requiredForCap = Math.ceil(totalSize / (S3_MAX_PARTS - 1));
  return Math.max(S3_MIN_PART_SIZE, requested, requiredForCap);
}

/**
 * Headless S3 blob-store core.
 *
 * Lives server-side. Holds AWS credentials (via the IS3Provider it owns),
 * issues presigned URLs, tracks per-upload progress reported back from the
 * browser, and runs registered post-process hooks once the browser confirms
 * the upload completed.
 *
 * The blob payload itself never crosses this Core — the browser PUTs the
 * bytes directly to S3 using the presigned URL.
 */
export class S3Core extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "url", event: "hawc-s3:url-changed" },
      { name: "key", event: "hawc-s3:key-changed" },
      { name: "etag", event: "hawc-s3:etag-changed" },
      { name: "progress", event: "hawc-s3:progress-changed" },
      { name: "loading", event: "hawc-s3:loading-changed" },
      { name: "uploading", event: "hawc-s3:uploading-changed" },
      { name: "completed", event: "hawc-s3:completed-changed" },
      { name: "metadata", event: "hawc-s3:metadata-changed" },
      { name: "error", event: "hawc-s3:error" },
    ],
    inputs: [
      { name: "bucket" },
      { name: "prefix" },
      { name: "contentType" },
    ],
    commands: [
      { name: "requestUpload", async: true },
      { name: "reportProgress" },
      { name: "complete", async: true },
      { name: "requestDownload", async: true },
      { name: "deleteObject", async: true },
      { name: "abort" },
      { name: "requestMultipartUpload", async: true },
      { name: "signMultipartPart", async: true },
      { name: "completeMultipart", async: true },
      { name: "abortMultipart", async: true },
    ],
  };

  private _target: EventTarget;
  private _provider: IS3Provider;
  private _bucket: string = "";
  private _prefix: string = "";
  private _contentType: string = "";

  private _url: string = "";
  private _key: string = "";
  private _etag: string = "";
  private _progress: S3Progress = { loaded: 0, total: 0, phase: "idle" };
  private _loading: boolean = false;
  private _uploading: boolean = false;
  private _completed: boolean = false;
  private _metadata: S3ObjectMetadata | null = null;
  private _error: S3Error | Error | null = null;

  private _flushScheduled: boolean = false;
  private _rafId: any = 0;
  /** Monotonically incremented per requestUpload. Stale reports are dropped. */
  private _generation: number = 0;
  private _postProcessHooks: PostProcessHook[] = [];
  /**
   * Active multipart upload state. Captures both `key` AND the full
   * S3RequestOptions snapshot taken at init time, so cleanup / complete
   * always target the bucket/prefix the upload was actually started against
   * — even if `this.bucket` or `this.prefix` were mutated afterward.
   */
  private _multipart: {
    uploadId: string;
    gen: number;
    key: string;
    options: S3RequestOptions;
    /**
     * size / contentType are snapshotted here (not just read from
     * `this._metadata` at completion time) because `deleteObject()` clears
     * `_metadata` when its key matches — and there is no reason to couple
     * the post-process context to that side channel. Keeping the values on
     * the snapshot means a mid-upload delete, a racing Shell reset, or a
     * future mutation of `_metadata` cannot silently corrupt what the
     * registerPostProcess hook sees.
     */
    size: number;
    contentType?: string;
  } | null = null;
  /**
   * Active single-PUT upload state. Same snapshot rationale as `_multipart`:
   * `complete()` consults this so the post-process hook sees the bucket the
   * bytes actually live in, and the GET presign points to the right path.
   * `key` is captured here (not just read from the mutable `this._key` slot)
   * because `requestDownload` also calls `_setKey()` and can clobber
   * `this._key` mid-upload — letting a valid `complete(originalKey, ...)`
   * fail with a spurious "key mismatch". `size` / `contentType` are
   * captured for the same reason `_multipart` captures them: `deleteObject`
   * clears `this._metadata` on key match, which would otherwise leak
   * `undefined` into the post-process ctx even though the upload itself
   * completed successfully. There is no S3-side cleanup needed for single
   * PUTs (no orphan equivalent of UploadId), so this is purely a snapshot
   * used for validation and post-process routing.
   */
  private _singleUpload: {
    key: string;
    options: S3RequestOptions;
    size?: number;
    contentType?: string;
  } | null = null;

  constructor(provider: IS3Provider, target?: EventTarget) {
    super();
    if (!provider) raiseError("provider is required.");
    this._provider = provider;
    this._target = target ?? this;
  }

  // --- Inputs ---

  get bucket(): string { return this._bucket; }
  set bucket(value: string) { this._bucket = value || ""; }

  get prefix(): string { return this._prefix; }
  set prefix(value: string) { this._prefix = value || ""; }

  get contentType(): string { return this._contentType; }
  set contentType(value: string) { this._contentType = value || ""; }

  // --- Output state ---

  get url(): string { return this._url; }
  get key(): string { return this._key; }
  get etag(): string { return this._etag; }
  get progress(): S3Progress { return { ...this._progress }; }
  get loading(): boolean { return this._loading; }
  get uploading(): boolean { return this._uploading; }
  get completed(): boolean { return this._completed; }
  get metadata(): S3ObjectMetadata | null {
    return this._metadata ? { ...this._metadata } : null;
  }
  get error(): S3Error | Error | null { return this._error; }

  // --- Post-process hook registration (server-side only API) ---

  /**
   * Register a server-side hook that runs after the browser confirms upload
   * completion. Returns a disposer.
   */
  registerPostProcess(hook: PostProcessHook): () => void {
    if (typeof hook !== "function") raiseError("hook must be a function.");
    this._postProcessHooks.push(hook);
    return () => {
      const idx = this._postProcessHooks.indexOf(hook);
      if (idx >= 0) this._postProcessHooks.splice(idx, 1);
    };
  }

  // --- Setters / dispatch ---

  private _setUrl(url: string): void {
    this._url = url;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:url-changed", { detail: url, bubbles: true }));
  }

  private _setKey(key: string): void {
    this._key = key;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:key-changed", { detail: key, bubbles: true }));
  }

  private _setEtag(etag: string): void {
    this._etag = etag;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:etag-changed", { detail: etag, bubbles: true }));
  }

  private _setProgress(progress: S3Progress): void {
    this._progress = progress;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:progress-changed", { detail: { ...progress }, bubbles: true }));
  }

  private _setLoading(v: boolean): void {
    this._loading = v;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:loading-changed", { detail: v, bubbles: true }));
  }

  private _setUploading(v: boolean): void {
    this._uploading = v;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:uploading-changed", { detail: v, bubbles: true }));
  }

  private _setCompleted(v: boolean): void {
    this._completed = v;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:completed-changed", { detail: v, bubbles: true }));
  }

  private _setMetadata(m: S3ObjectMetadata | null): void {
    this._metadata = m;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:metadata-changed", { detail: m ? { ...m } : null, bubbles: true }));
  }

  private _setError(err: any): void {
    if (err instanceof Error && typeof (err as any).toJSON !== "function") {
      (err as any).toJSON = () => ({
        name: err.name,
        message: err.message,
        ...(err.stack ? { stack: err.stack } : {}),
      });
    }
    this._error = err;
    this._target.dispatchEvent(new CustomEvent("hawc-s3:error", { detail: this._error, bubbles: true }));
  }

  // --- rAF batching for progress events ---

  private _scheduleProgressFlush(): void {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    const raf = globalThis.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(cb, 16));
    this._rafId = raf(() => {
      this._flushScheduled = false;
      this._rafId = 0;
      this._setProgress(this._progress);
    });
  }

  private _cancelFlush(): void {
    if (this._rafId) {
      const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
      cancel(this._rafId);
      this._rafId = 0;
      this._flushScheduled = false;
    }
  }

  private _resolveBucket(): string {
    if (!this._bucket) raiseError("bucket is required. Set the 'bucket' input before calling commands.");
    return this._bucket;
  }

  private _baseRequestOptions(extra?: Partial<S3RequestOptions>): S3RequestOptions {
    return {
      bucket: this._resolveBucket(),
      prefix: this._prefix || undefined,
      contentType: this._contentType || undefined,
      ...extra,
    };
  }

  /**
   * If a multipart from a prior request is still tracked, fire-and-forget the
   * abortMultipart so S3 does not bill for orphaned parts. Called at the
   * start of every request* command — defends against direct re-entry into
   * Core (rapid double trigger, raw proxy calls, misuse) without relying on
   * the caller to invoke abort() first.
   *
   * Uses the snapshot captured when the multipart was started — both `key`
   * AND `options` (bucket/prefix). Otherwise mutating `this.prefix` between
   * the two requests would route the abort to the new prefix and S3 would
   * keep the orphan parts under the old one.
   */
  private _abortPriorMultipart(): void {
    const mp = this._multipart;
    if (!mp) return;
    this._multipart = null;
    this._provider.abortMultipart(mp.key, mp.uploadId, mp.options)
      .catch(() => { /* best-effort */ });
  }

  // --- Commands ---

  /**
   * Issue a presigned PUT URL for the browser to upload directly to S3.
   * Resets any previous completion state and starts a new "generation" so
   * stale progress reports from a previous upload are ignored.
   */
  async requestUpload(key: string, size?: number, contentType?: string): Promise<PresignedUpload> {
    if (!key) raiseError("key is required.");
    if (size !== undefined && (!Number.isFinite(size) || size < 0)) {
      raiseError(`size must be a non-negative number, got ${size}.`);
    }
    // Cancel any leftover multipart from a previous request before bumping
    // the generation — otherwise the orphan uploadId becomes unreachable.
    this._abortPriorMultipart();
    // Drop any prior single-upload snapshot. There is nothing to clean up on
    // S3 (single PUTs have no orphan), but the slot must not point at a
    // session that has been superseded.
    this._singleUpload = null;
    this._generation++;
    this._setError(null);
    this._setLoading(true);
    this._setUploading(false);
    this._setCompleted(false);
    this._setEtag("");
    this._setKey(key);
    this._setMetadata({ size, contentType: contentType || this._contentType || undefined });
    this._setProgress({ loaded: 0, total: size ?? 0, phase: "signing" });

    const opts = this._baseRequestOptions({
      contentType: contentType || this._contentType || undefined,
    });
    try {
      const presigned = await this._provider.presignUpload(key, opts);
      // Capture the snapshot only after presign succeeds, so a failed presign
      // does not leave a stale slot that complete() would later consume.
      // Stash the key so completion can validate against the upload's
      // original key rather than `this._key`, which requestDownload() can
      // overwrite mid-flight. size/contentType are also snapshotted so a
      // mid-upload `deleteObject()` that nulls `this._metadata` does not
      // leak undefined into the post-process ctx.
      this._singleUpload = {
        key,
        options: opts,
        size,
        contentType: contentType || this._contentType || undefined,
      };
      // Intentionally do NOT publish presigned.url through `this.url`. The
      // public `url` property is documented as the post-completion GET URL
      // (see README) — surfacing the write-capable PUT URL here would both
      // violate that contract and broadcast a credential-bearing token to
      // every binding/logger subscribed to `hawc-s3:url-changed`. The Shell
      // receives the URL it needs through the return value of this command.
      // Multipart never published its part URLs for the same reason.
      this._setUploading(true);
      this._setProgress({ loaded: 0, total: size ?? 0, phase: "uploading" });
      return presigned;
    } catch (e: any) {
      this._setError(e);
      this._setLoading(false);
      this._setUploading(false);
      throw e;
    }
  }

  /**
   * Browser-reported XHR progress. Coalesced via rAF so we do not flood the
   * remote transport with one event per byte chunk.
   */
  reportProgress(loaded: number, total: number): void {
    if (!this._uploading) return;
    if (!Number.isFinite(loaded) || !Number.isFinite(total)) return;
    if (loaded < 0 || total < 0) return;
    this._progress = { loaded, total, phase: "uploading" };
    this._scheduleProgressFlush();
  }

  /**
   * Browser confirms upload completion. Runs server-side post-process hooks
   * (DB inserts, virus scans, thumbnailing, etc.) and then exposes a
   * download URL via the `url` property.
   */
  async complete(key: string, etag?: string): Promise<string> {
    const gen = this._generation;
    if (!this._uploading) raiseError("complete() called without an active upload.");
    // Refuse when a multipart is in flight. `complete()` is the single-PUT
    // finalizer; it does not merge parts on S3, and its options fallback
    // (`this._baseRequestOptions()` when `_singleUpload` is null) would use
    // whatever bucket/prefix the inputs hold NOW — not the snapshot the
    // multipart was initiated against. That silently misroutes the
    // post-process ctx.bucket and the download GET presign. The remedy is
    // not to "route through the multipart snapshot here" (that would
    // conflate two different finalization protocols), but to surface the
    // misuse so the caller switches to completeMultipart(). Symmetric with
    // completeMultipart()'s own `if (!this._multipart)` guard.
    if (this._multipart) raiseError("complete() called while a multipart upload is active — use completeMultipart() to finalize multipart uploads.");
    // Validate against the snapshot, not the mutable `this._key` slot.
    // `requestDownload()` (a legal public command) also calls `_setKey()` and
    // can clobber `this._key` between requestUpload and complete — which
    // would make a correct `complete(uploadKey, ...)` throw a spurious key
    // mismatch. The snapshot is the source of truth for "what key is this
    // upload targeting". Fall back to `this._key` only for the unusual case
    // where a caller drove `_uploading=true` without going through
    // requestUpload (test setups) and therefore has no snapshot.
    const snapshot = this._singleUpload;
    const expectedKey = snapshot ? snapshot.key : this._key;
    if (key !== expectedKey) raiseError(`complete() key mismatch: expected ${expectedKey}, got ${key}.`);
    // Use the snapshot taken at requestUpload time so the post-process hook
    // and download presign target the bucket/prefix the bytes actually live
    // at, even if `this.bucket`/`this.prefix` were mutated mid-flight.
    const opts = snapshot?.options ?? this._baseRequestOptions();
    this._cancelFlush();
    this._setProgress({
      loaded: this._metadata?.size ?? this._progress.loaded,
      total: this._metadata?.size ?? this._progress.total,
      phase: "completing",
    });
    if (etag) this._setEtag(etag);

    const ctx: PostProcessContext = {
      bucket: opts.bucket,
      key,
      etag,
      // Read from the snapshot, not `this._metadata`. `deleteObject(key)`
      // clears `_metadata` when its key matches — so an in-flight upload
      // racing a same-key delete would otherwise hand `undefined` to the
      // post-process hook even though the upload itself succeeded.
      size: snapshot?.size ?? this._metadata?.size,
      contentType: snapshot?.contentType ?? this._metadata?.contentType,
    };

    try {
      // Hooks run sequentially; a single failure aborts the rest so the caller
      // sees the first error rather than a Promise.all aggregate.
      for (const hook of this._postProcessHooks) {
        await hook(ctx);
      }
      // Stale completion (e.g. user kicked off a new upload mid-hook).
      if (gen !== this._generation) return "";
      const download = await this._provider.presignDownload(key, opts);
      this._setUrl(download.url);
      this._setProgress({ loaded: ctx.size ?? 0, total: ctx.size ?? 0, phase: "done" });
      this._setUploading(false);
      this._setCompleted(true);
      this._setLoading(false);
      this._singleUpload = null;
      return download.url;
    } catch (e: any) {
      if (gen === this._generation) {
        this._setError(e);
        this._setUploading(false);
        this._setLoading(false);
      }
      this._singleUpload = null;
      throw e;
    }
  }

  async requestDownload(key: string): Promise<PresignedDownload> {
    if (!key) raiseError("key is required.");
    this._setError(null);
    try {
      const result = await this._provider.presignDownload(key, this._baseRequestOptions());
      this._setKey(key);
      this._setUrl(result.url);
      return result;
    } catch (e: any) {
      this._setError(e);
      throw e;
    }
  }

  async deleteObject(key: string): Promise<void> {
    if (!key) raiseError("key is required.");
    this._setError(null);
    this._setLoading(true);
    try {
      await this._provider.deleteObject(key, this._baseRequestOptions());
      // Clear url/etag if the deleted key matches the current state.
      if (this._key === key) {
        this._setUrl("");
        this._setEtag("");
        this._setCompleted(false);
        this._setMetadata(null);
      }
    } catch (e: any) {
      this._setError(e);
      throw e;
    } finally {
      this._setLoading(false);
    }
  }

  /**
   * Cancel any in-flight upload tracking. Bumps the generation counter so
   * any in-flight progress / completion reports are silently dropped.
   * Does not actually cancel the browser's XHR — that is the Shell's job.
   *
   * If a multipart upload is in flight, fire-and-forget the abortMultipart
   * call so S3 does not retain orphaned parts (and bill for them).
   */
  abort(): void {
    const mp = this._multipart;
    this._generation++;
    this._multipart = null;
    this._singleUpload = null;
    this._cancelFlush();
    if (this._uploading) this._setUploading(false);
    if (this._loading) this._setLoading(false);
    this._setProgress({ loaded: 0, total: 0, phase: "idle" });
    if (mp) {
      // Use the captured key + options, not the current ones — the caller may
      // have already mutated `this.bucket`/`this.prefix` since init.
      this._provider.abortMultipart(mp.key, mp.uploadId, mp.options)
        .catch(() => { /* best-effort cleanup */ });
    }
  }

  // --- Multipart upload commands ---

  /**
   * Initiate an S3 multipart upload and pre-sign every PUT URL the browser
   * will need. Resolves with the uploadId, partSize, and the array of
   * presigned part URLs (with their byte ranges into the source blob).
   *
   * The Shell uses this in place of `requestUpload` when the file is larger
   * than its multipart-threshold.
   */
  async requestMultipartUpload(
    key: string,
    size: number,
    contentType?: string,
    partSize?: number,
  ): Promise<MultipartInit> {
    if (!key) raiseError("key is required.");
    if (!Number.isFinite(size) || size <= 0) raiseError(`size must be a positive number, got ${size}.`);
    // Same prior-multipart cleanup as requestUpload.
    this._abortPriorMultipart();
    // And drop any stale single-PUT snapshot — we are switching upload modes.
    this._singleUpload = null;
    this._generation++;
    const gen = this._generation;
    this._setError(null);
    this._setLoading(true);
    this._setUploading(false);
    this._setCompleted(false);
    this._setEtag("");
    this._setKey(key);
    this._setMetadata({ size, contentType: contentType || this._contentType || undefined });
    this._setProgress({ loaded: 0, total: size, phase: "signing" });

    const opts = this._baseRequestOptions({
      contentType: contentType || this._contentType || undefined,
    });
    const effectivePartSize = computePartSize(size, partSize);
    const partCount = Math.ceil(size / effectivePartSize);
    if (partCount > S3_MAX_PARTS) {
      // computePartSize already guards this, but defend against integer overflow
      // or callers passing a wildly oversized requested partSize.
      const e = new Error(`[@wc-bindable/hawc-s3] computed part count ${partCount} exceeds S3 max ${S3_MAX_PARTS}.`);
      this._setError(e);
      this._setLoading(false);
      throw e;
    }

    let uploadId: string;
    try {
      ({ uploadId } = await this._provider.initiateMultipart(key, opts));
    } catch (e: any) {
      if (gen === this._generation) {
        this._setError(e);
        this._setLoading(false);
      }
      throw e;
    }

    // A newer requestUpload may have superseded us mid-init. Best-effort clean
    // up the orphaned multipart so we do not leak storage.
    if (gen !== this._generation) {
      this._provider.abortMultipart(key, uploadId, opts).catch(() => {});
      throw new Error("[@wc-bindable/hawc-s3] requestMultipartUpload superseded.");
    }

    const parts: MultipartPartUrl[] = [];
    try {
      for (let i = 0; i < partCount; i++) {
        const partNumber = i + 1;
        const start = i * effectivePartSize;
        const end = Math.min(start + effectivePartSize, size);
        const presigned = await this._provider.presignPart(key, uploadId, partNumber, opts);
        parts.push({
          partNumber,
          url: presigned.url,
          range: [start, end],
          // Pass the per-part expiry through to the Shell so it can refresh
          // URLs for late parts before the PUT fires. For a large multipart
          // over a slow link, the last parts can reach their turn well after
          // the 900 s default window — without an expiresAt the Shell has no
          // way to know whether to re-sign.
          expiresAt: presigned.expiresAt,
          // Forward provider-supplied per-part headers (SSE-C, custom auth,
          // etc.). Symmetrical with single-PUT, which already threads
          // `PresignedUpload.headers` through to the XHR. Dropping them here
          // would silently break any non-default IS3Provider that requires
          // extra headers on part PUTs.
          ...(presigned.headers && Object.keys(presigned.headers).length > 0
            ? { headers: presigned.headers }
            : {}),
        });
      }
    } catch (e: any) {
      // Roll back the just-initiated multipart so we do not leak.
      this._provider.abortMultipart(key, uploadId, opts).catch(() => {});
      if (gen === this._generation) {
        this._setError(e);
        this._setLoading(false);
      }
      throw e;
    }

    // Snapshot the options used for this multipart. completeMultipart, abort,
    // and the prior-cleanup path all consult this snapshot rather than the
    // current `this._bucket`/`this._prefix`, so mutating the inputs mid-flight
    // does not misroute the cleanup or the download presign. size /
    // contentType are carried on the snapshot for the same reason — a
    // mid-upload `deleteObject()` nulls `this._metadata`, and completeMultipart
    // must still feed accurate values into the post-process ctx.
    this._multipart = {
      uploadId,
      gen,
      key,
      options: opts,
      size,
      contentType: contentType || this._contentType || undefined,
    };
    this._setUploading(true);
    this._setProgress({ loaded: 0, total: size, phase: "uploading" });
    return { uploadId, partSize: effectivePartSize, parts, key };
  }

  /**
   * Re-presign a single part URL for an already-initiated multipart upload.
   * Used by the Shell to refresh near-expiry part URLs during long uploads,
   * so a large file that runs past the initial presign window (default 900 s)
   * does not fail the tail parts with 403. Uses the snapshotted options from
   * init time, so the re-signed URL targets the same bucket/prefix as the
   * original — mutating `this.bucket` / `this.prefix` between init and
   * re-sign does not misroute the PUT.
   */
  async signMultipartPart(key: string, uploadId: string, partNumber: number): Promise<PresignedUpload> {
    if (!key) raiseError("key is required.");
    if (!uploadId) raiseError("uploadId is required.");
    const mp = this._multipart;
    if (!mp) raiseError("signMultipartPart() called without an active multipart upload.");
    if (mp.uploadId !== uploadId) raiseError("signMultipartPart() uploadId mismatch.");
    if (mp.key !== key) raiseError(`signMultipartPart() key mismatch: expected ${mp.key}, got ${key}.`);
    return await this._provider.presignPart(key, uploadId, partNumber, mp.options);
  }

  /**
   * Finalize a multipart upload after the browser confirms every part landed.
   * Runs the registered post-process hooks once S3 acknowledges the merge.
   */
  async completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<string> {
    const gen = this._generation;
    if (!this._multipart) raiseError("completeMultipart() called without an active multipart upload.");
    if (this._multipart.uploadId !== uploadId) raiseError("completeMultipart() uploadId mismatch.");
    // Validate against the snapshot's captured key, not `this._key`.
    // `requestDownload()` also calls `_setKey()`, so a correct completion
    // of the original multipart would otherwise throw a spurious mismatch
    // if a download was issued mid-upload. Symmetric with signMultipartPart
    // above, which already uses the snapshot.
    if (key !== this._multipart.key) raiseError(`completeMultipart() key mismatch: expected ${this._multipart.key}, got ${key}.`);
    if (!Array.isArray(parts) || parts.length === 0) raiseError("parts must be a non-empty array.");
    // Structural validation before handing off to S3. Previously we deferred
    // everything below "is it an array" to the server, which meant a mis-
    // shaped parts array (negative partNumber, duplicate entries, empty
    // etag) only surfaced as an S3 InvalidPart / 400 after a network
    // round-trip — harder to diagnose and opaque to the caller. Catching
    // here produces a deterministic local error with the offending index.
    const seen = new Set<number>();
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || typeof p !== "object") raiseError(`parts[${i}] is not an object.`);
      if (!Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > 10000) {
        raiseError(`parts[${i}].partNumber must be an integer in [1, 10000], got ${p.partNumber}.`);
      }
      if (seen.has(p.partNumber)) {
        raiseError(`parts contains duplicate partNumber ${p.partNumber}.`);
      }
      seen.add(p.partNumber);
      // An empty etag here would propagate into the CompleteMultipartUpload
      // XML body as `<ETag></ETag>` and S3 rejects with InvalidPart — but
      // an S3-compatible server might not. The single-PUT path already
      // rejects missing ETags at the XHR layer (MissingEtagError); this
      // is the symmetric check for multipart at the Core boundary.
      if (typeof p.etag !== "string" || p.etag.length === 0) {
        raiseError(`parts[${i}].etag must be a non-empty string.`);
      }
    }
    // Capture the snapshot before the await — this._multipart is null'd out
    // partway through, and we still need bucket/prefix for the GET presign at
    // the end. Using `this._baseRequestOptions()` here would silently switch
    // to whatever bucket/prefix the inputs hold *now*. size / contentType
    // are captured for the same reason we snapshot bucket/prefix: a mid-
    // upload `deleteObject()` on this key would null `this._metadata`, so
    // the post-process ctx built below must not depend on it.
    const mpOptions = this._multipart.options;
    const mpSize = this._multipart.size;
    const mpContentType = this._multipart.contentType;
    this._cancelFlush();
    this._setProgress({
      loaded: this._metadata?.size ?? this._progress.loaded,
      total: this._metadata?.size ?? this._progress.total,
      phase: "completing",
    });

    let etag = "";
    try {
      ({ etag } = await this._provider.completeMultipart(key, uploadId, parts, mpOptions));
    } catch (e: any) {
      if (gen === this._generation) {
        this._setError(e);
        this._setUploading(false);
        this._setLoading(false);
      }
      // Best-effort: if S3 rejected the merge, abort to free the parts.
      this._provider.abortMultipart(key, uploadId, mpOptions).catch(() => {});
      this._multipart = null;
      throw e;
    }
    if (etag) this._setEtag(etag);
    this._multipart = null;

    const ctx: PostProcessContext = {
      // bucket reflects the upload's true destination, not the current input.
      bucket: mpOptions.bucket,
      key,
      etag,
      // Read from the snapshot for the same reason `bucket` does: a mid-
      // upload `deleteObject(key)` clears `this._metadata`, and we want the
      // post-process ctx to always reflect the upload that actually happened.
      size: mpSize,
      contentType: mpContentType,
    };

    try {
      for (const hook of this._postProcessHooks) {
        await hook(ctx);
      }
      if (gen !== this._generation) return "";
      // The download must point at the path the bytes actually live at.
      const download = await this._provider.presignDownload(key, mpOptions);
      this._setUrl(download.url);
      this._setProgress({ loaded: ctx.size ?? 0, total: ctx.size ?? 0, phase: "done" });
      this._setUploading(false);
      this._setCompleted(true);
      this._setLoading(false);
      return download.url;
    } catch (e: any) {
      if (gen === this._generation) {
        this._setError(e);
        this._setUploading(false);
        this._setLoading(false);
      }
      throw e;
    }
  }

  /**
   * Explicitly abort a known multipart upload. Used by the Shell when its
   * own part PUTs fail and it has a uploadId to clean up. The general `abort()`
   * handles the implicit case (current in-flight upload).
   */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    if (!key || !uploadId) raiseError("key and uploadId are required.");
    // Drop tracking for the current upload if it matches; do this before the
    // network call so a slow abort does not block subsequent commands.
    // Capture the snapshot so the abort hits the bucket/prefix the upload
    // was started against, even if the inputs changed in the meantime.
    let opts: S3RequestOptions;
    if (this._multipart?.uploadId === uploadId) {
      // Symmetric with `signMultipartPart` and `completeMultipart`: when we
      // are identifying a tracked upload by its uploadId, the caller's key
      // must match the snapshot. Without this check, a caller passing the
      // wrong key (stale reference, copy/paste error, racing worker) causes
      // us to drop internal tracking AND ask S3 to abort a different
      // object path — so the real multipart survives and keeps billing.
      // Checked BEFORE any state mutation so a mismatched call leaves the
      // Core in a recoverable state rather than half-torn-down.
      if (this._multipart.key !== key) {
        raiseError(`abortMultipart() key mismatch: expected ${this._multipart.key}, got ${key}.`);
      }
      opts = this._multipart.options;
      this._multipart = null;
      this._generation++;
      this._cancelFlush();
      if (this._uploading) this._setUploading(false);
      if (this._loading) this._setLoading(false);
      this._setProgress({ loaded: 0, total: 0, phase: "idle" });
    } else {
      // The caller is aborting an upload we do not track (e.g. recovered
      // from external state, or a different uploadId against the same key
      // that the Core never saw). We have no snapshot, so use current
      // inputs — it is the caller's responsibility to have the right
      // bucket/prefix configured before invoking this case.
      opts = this._baseRequestOptions();
    }
    await this._provider.abortMultipart(key, uploadId, opts);
  }
}
