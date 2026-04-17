import { config, getRemoteCoreUrl } from "../config.js";
import {
  IWcBindable, S3Progress, S3ObjectMetadata, PresignedUpload,
  MultipartInit, MultipartPart, MultipartPartUrl,
} from "../types.js";
import { S3Core } from "../core/S3Core.js";
import { retryWithBackoff, defaultPutRetryPolicy, PutHttpError, MissingEtagError } from "../retry.js";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
  type ClientTransport,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";

/**
 * Browser shell. Selects a file (via the `file` JS property) and uploads it
 * **directly** to S3 using a presigned URL obtained from the Core. The
 * payload never crosses the WebSocket — only signing requests, progress
 * reports, and completion notifications do.
 */
export class S3 extends HTMLElement {
  /**
   * wcBindable declaration for the Shell.
   *
   * Properties and inputs are forwarded from the Core: the Shell proxies
   * every observable output and every configurable input, so consumers that
   * read metadata can bind the same way as they would against the Core.
   *
   * Commands are DELIBERATELY NOT forwarded. Core's `requestUpload`,
   * `reportProgress`, `complete`, `completeMultipart`, `abortMultipart`, etc.
   * are internal coordination RPCs between Shell and Core — invoking them
   * from outside the Shell would bypass the XHR pipeline and leave state
   * inconsistent. At the element level we only expose the two high-level
   * orchestration methods that are actually implemented as public members:
   * `upload()` (which runs the full request→PUT→complete flow) and
   * `abort()`. A generic wc-bindable tool that introspects `wcBindable`
   * and calls `element[name](...)` must see exactly those two to avoid
   * runtime method-not-found failures. (Same pattern hawc-ai's `<hawc-ai>`
   * uses: declares `send` + `abort`, not the full Core command surface.)
   */
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      ...S3Core.wcBindable.properties,
      { name: "trigger", event: "hawc-s3:trigger-changed" },
    ],
    inputs: S3Core.wcBindable.inputs,
    commands: [
      { name: "upload", async: true },
      { name: "abort" },
    ],
  };
  static get observedAttributes(): string[] {
    return ["bucket", "prefix", "content-type", "multipart-threshold", "multipart-concurrency", "put-retries"];
  }

  /** Default cutoff between single PUT and multipart, in bytes. 8 MiB. */
  static DEFAULT_MULTIPART_THRESHOLD = 8 * 1024 * 1024;
  /** Default parallel part uploads. */
  static DEFAULT_MULTIPART_CONCURRENCY = 4;
  /** Default per-PUT retry budget (on top of the initial attempt). */
  static DEFAULT_PUT_RETRIES = 3;

  private _core: S3Core | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _remoteValues: Record<string, unknown> = {};
  private _unbind: (() => void) | null = null;
  private _ws: WebSocket | null = null;
  private _trigger: boolean = false;
  private _file: Blob | null = null;
  private _explicitKey: string = "";
  /** Active XHRs; multiple during multipart, single during direct PUT. */
  private _xhrs: Set<XMLHttpRequest> = new Set();
  /** Accumulated bytes across all in-flight parts for total progress. */
  private _multipartLoaded: Map<number, number> = new Map();
  private _errorState: any = null;
  private _hasLocalError: boolean = false;
  /** Set true when abort() runs so part workers can short-circuit. */
  private _aborted: boolean = false;
  /** The currently-running upload(), if any. Used to serialize re-entry. */
  private _currentUpload: Promise<string | null> | null = null;

  private get _isRemote(): boolean {
    return this._proxy !== null;
  }

  constructor() {
    super();
    // In remote mode the Core lives on the server. The browser only ever
    // talks to it through the proxy, so we never instantiate a local S3Core.
  }

  private _initRemote(): void {
    const url = getRemoteCoreUrl();
    if (!url) {
      throw new Error("[@wc-bindable/hawc-s3] remote.enableRemote is true but remoteCoreUrl is empty. Set remote.remoteCoreUrl or S3_REMOTE_CORE_URL.");
    }
    const ws = new WebSocket(url);
    this._ws = ws;
    let opened = false;
    let failed = false;
    ws.addEventListener("open", () => { opened = true; }, { once: true });
    const onFail = () => {
      if (failed) return;
      failed = true;
      if (this._ws !== ws) return;
      // Hard-stop any in-flight upload: mark aborted so the worker pool's
      // !_aborted guard exits the loop, and cancel every running XHR.
      // Without this, a WS drop mid-multipart leaves the browser PUTting
      // parts to S3 over a dead control channel — the bandwidth waste is bad
      // enough, but the real problem is that completeMultipart() eventually
      // fails and we cannot signal abortMultipart through the dead proxy,
      // so S3 keeps the orphan parts. Server-side cleanup (Core.abort on
      // ws.close — see README) does the actual S3 cancellation; this path
      // just stops the client from making it worse.
      this._aborted = true;
      this._cancelXhrs();
      this._setErrorState(new Error(
        `[@wc-bindable/hawc-s3] WebSocket connection ${opened ? "lost" : "failed"}: ${url}`
      ));
      this._resetRemoteBusyState();
      // Tear the remote machinery down in place. Without this, `_proxy`
      // stays non-null — so `_isRemote` stays true, subsequent upload() calls
      // route to the dead proxy with `timeoutMs: 0`, and the caller waits
      // forever for an ack that will never come. Disposing here flips the
      // element into a well-defined "remote unavailable" state; the next
      // upload() throws immediately ("no core attached"), and a
      // disconnect/reconnect DOM cycle cleanly re-enters `_initRemote()`.
      this._disposeRemote();
    };
    ws.addEventListener("error", onFail, { once: true });
    ws.addEventListener("close", onFail, { once: true });
    const transport = new WebSocketClientTransport(ws);
    this._connectRemote(transport);
  }

  /**
   * Tear down the remote proxy + bind subscription + WebSocket so `_isRemote`
   * flips back to false. Safe to call when nothing is attached (no-op).
   * Reached from both the failure handler (`onFail`) and the normal DOM
   * teardown (`disconnectedCallback`).
   */
  private _disposeRemote(): void {
    if (this._unbind) {
      this._unbind();
      this._unbind = null;
    }
    if (this._proxy) {
      try { this._proxy.dispose(); } catch { /* already disposed */ }
      this._proxy = null;
    }
    this._remoteValues = {};
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  private _resetRemoteBusyState(): void {
    if (this._remoteValues.loading) {
      this._remoteValues.loading = false;
      this.dispatchEvent(new CustomEvent("hawc-s3:loading-changed", { detail: false, bubbles: true }));
    }
    if (this._remoteValues.uploading) {
      this._remoteValues.uploading = false;
      this.dispatchEvent(new CustomEvent("hawc-s3:uploading-changed", { detail: false, bubbles: true }));
    }
  }

  private _setErrorState(error: any): void {
    this._errorState = error;
    this._hasLocalError = true;
    this.dispatchEvent(new CustomEvent("hawc-s3:error", { detail: error, bubbles: true }));
  }

  private _clearErrorState(): void {
    if (!this._hasLocalError) return;
    this._hasLocalError = false;
    this._errorState = null;
    this.dispatchEvent(new CustomEvent("hawc-s3:error", { detail: this.error, bubbles: true }));
  }

  /** @internal — visible for testing */
  _connectRemote(transport: ClientTransport): void {
    this._proxy = createRemoteCoreProxy(S3Core.wcBindable, transport);
    this._unbind = bind(this._proxy, (name, value) => {
      this._remoteValues[name] = value;
      const prop = S3.wcBindable.properties.find(p => p.name === name);
      /* v8 ignore start -- bind callback names always come from declared wcBindable properties */
      if (prop) {
        this.dispatchEvent(new CustomEvent(prop.event, { detail: value, bubbles: true }));
      }
      /* v8 ignore stop */
    });
    // Push attribute-derived inputs to the server so the Core knows which
    // bucket/prefix/contentType to sign against.
    //
    // Sync is gated on `hasAttribute`, NOT on the value being truthy. An
    // explicit `prefix=""` is a legitimate way to override a server-side
    // default (e.g. Core.prefix pre-seeded to "user/123/") back to empty,
    // and silently skipping it would let the server's seeded prefix leak
    // through after the client connects. `attributeChangedCallback` fires
    // before `_proxy` exists (during upgrade), so the empty-string sync
    // must happen here or not at all.
    if (this.hasAttribute("bucket")) {
      this._proxy!.setWithAck("bucket", this.bucket).catch((e: unknown) => this._setErrorState(e));
    }
    if (this.hasAttribute("prefix")) {
      this._proxy!.setWithAck("prefix", this.prefix).catch((e: unknown) => this._setErrorState(e));
    }
    if (this.hasAttribute("content-type")) {
      this._proxy!.setWithAck("contentType", this.contentType).catch((e: unknown) => this._setErrorState(e));
    }
  }

  /** @internal — used by tests / advanced setups to inject a local Core */
  attachLocalCore(core: S3Core): void {
    this._core = core;
    if (this.bucket) this._core.bucket = this.bucket;
    if (this.prefix) this._core.prefix = this.prefix;
    if (this.contentType) this._core.contentType = this.contentType;
  }

  // --- Input attributes ---

  get bucket(): string { return this.getAttribute("bucket") || ""; }
  set bucket(value: string) { this.setAttribute("bucket", value); }

  get prefix(): string { return this.getAttribute("prefix") || ""; }
  set prefix(value: string) { this.setAttribute("prefix", value); }

  get contentType(): string { return this.getAttribute("content-type") || ""; }
  set contentType(value: string) { this.setAttribute("content-type", value); }

  /** Bytes; uploads larger than this go through multipart. */
  get multipartThreshold(): number {
    const v = this.getAttribute("multipart-threshold");
    const n = v != null ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : S3.DEFAULT_MULTIPART_THRESHOLD;
  }
  set multipartThreshold(value: number) {
    this.setAttribute("multipart-threshold", String(value));
  }

  /** Parallel part uploads when in multipart mode. */
  get multipartConcurrency(): number {
    const v = this.getAttribute("multipart-concurrency");
    const n = v != null ? Number(v) : NaN;
    return Number.isInteger(n) && n > 0 ? n : S3.DEFAULT_MULTIPART_CONCURRENCY;
  }
  set multipartConcurrency(value: number) {
    this.setAttribute("multipart-concurrency", String(value));
  }

  /** Retries per PUT (single or part) on top of the initial attempt. 0 disables retry. */
  get putRetries(): number {
    const v = this.getAttribute("put-retries");
    if (v == null) return S3.DEFAULT_PUT_RETRIES;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : S3.DEFAULT_PUT_RETRIES;
  }
  set putRetries(value: number) {
    this.setAttribute("put-retries", String(value));
  }

  // --- JS-only properties ---

  get file(): Blob | null { return this._file; }
  set file(value: Blob | null) { this._file = value; }

  private _requestedKey(): string {
    return this._explicitKey || this.getAttribute("key") || "";
  }

  /**
   * Optional explicit object key. When unset, we derive one from the file
   * name (if available) or fall back to a timestamp-based key.
   */
  get key(): string {
    if (this._isRemote) {
      const resolved = this._remoteValues.key;
      if (typeof resolved === "string" && resolved) return resolved;
    } else {
      const resolved = this._core?.key;
      if (resolved) return resolved;
    }
    return this._requestedKey();
  }
  set key(value: string) { this._explicitKey = value || ""; }

  // --- Output state ---

  get url(): string {
    if (this._isRemote) return (this._remoteValues.url as string) ?? "";
    return this._core?.url ?? "";
  }

  get etag(): string {
    if (this._isRemote) return (this._remoteValues.etag as string) ?? "";
    return this._core?.etag ?? "";
  }

  get progress(): S3Progress {
    if (this._isRemote) {
      return (this._remoteValues.progress as S3Progress) ?? { loaded: 0, total: 0, phase: "idle" };
    }
    return this._core?.progress ?? { loaded: 0, total: 0, phase: "idle" };
  }

  get loading(): boolean {
    if (this._isRemote) return (this._remoteValues.loading as boolean) ?? false;
    return this._core?.loading ?? false;
  }

  get uploading(): boolean {
    if (this._isRemote) return (this._remoteValues.uploading as boolean) ?? false;
    return this._core?.uploading ?? false;
  }

  get completed(): boolean {
    if (this._isRemote) return (this._remoteValues.completed as boolean) ?? false;
    return this._core?.completed ?? false;
  }

  get metadata(): S3ObjectMetadata | null {
    if (this._isRemote) return (this._remoteValues.metadata as S3ObjectMetadata | null) ?? null;
    return this._core?.metadata ?? null;
  }

  get error(): any {
    if (this._isRemote) {
      if (this._hasLocalError) return this._errorState;
      return "error" in this._remoteValues ? this._remoteValues.error : this._errorState;
    }
    return this._core?.error ?? this._errorState;
  }

  // --- Trigger ---

  get trigger(): boolean { return this._trigger; }

  set trigger(value: boolean) {
    const v = !!value;
    if (v) {
      this._trigger = true;
      this.dispatchEvent(new CustomEvent("hawc-s3:trigger-changed", { detail: true, bubbles: true }));
      this.upload().catch(() => {}).finally(() => {
        this._trigger = false;
        this.dispatchEvent(new CustomEvent("hawc-s3:trigger-changed", { detail: false, bubbles: true }));
      });
    }
  }

  // --- Methods ---

  private _deriveKey(file: Blob): string {
    const requested = this._requestedKey();
    if (requested) return requested;
    const name = (file as File).name;
    if (name) return name;
    return `upload-${Date.now()}`;
  }

  private async _requestUpload(key: string, size: number, contentType?: string): Promise<PresignedUpload> {
    if (this._isRemote) {
      // Long uploads are common — disable the 30s default timeout on the sign call too,
      // since presign itself is fast but the surrounding flow ties up the proxy.
      return await this._proxy!.invokeWithOptions("requestUpload", [key, size, contentType], { timeoutMs: 0 }) as PresignedUpload;
    }
    if (!this._core) throw new Error("[@wc-bindable/hawc-s3] no core attached.");
    return await this._core.requestUpload(key, size, contentType);
  }

  private async _requestMultipart(key: string, size: number, contentType?: string): Promise<MultipartInit> {
    if (this._isRemote) {
      return await this._proxy!.invokeWithOptions("requestMultipartUpload", [key, size, contentType], { timeoutMs: 0 }) as MultipartInit;
    }
    if (!this._core) throw new Error("[@wc-bindable/hawc-s3] no core attached.");
    return await this._core.requestMultipartUpload(key, size, contentType);
  }

  private _reportProgress(loaded: number, total: number): void {
    if (this._isRemote) {
      // `invoke(name, ...args)` is variadic — spread the args rather than
      // wrapping them in an array. The array form would arrive server-side
      // as a single array-typed argument, fail `Number.isFinite(loaded)`,
      // and be silently dropped (reportProgress has no ack).
      // Fire-and-forget: progress reports are advisory and rAF-coalesced
      // server-side, so dropping the occasional one on a transport hiccup is fine.
      this._proxy!.invoke("reportProgress", loaded, total).catch(() => {});
      return;
    }
    this._core?.reportProgress(loaded, total);
  }

  private async _complete(key: string, etag?: string): Promise<string> {
    if (this._isRemote) {
      return await this._proxy!.invokeWithOptions("complete", [key, etag], { timeoutMs: 0 }) as string;
    }
    if (!this._core) throw new Error("[@wc-bindable/hawc-s3] no core attached.");
    return await this._core.complete(key, etag);
  }

  private async _completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<string> {
    if (this._isRemote) {
      return await this._proxy!.invokeWithOptions("completeMultipart", [key, uploadId, parts], { timeoutMs: 0 }) as string;
    }
    if (!this._core) throw new Error("[@wc-bindable/hawc-s3] no core attached.");
    return await this._core.completeMultipart(key, uploadId, parts);
  }

  /**
   * Number of seconds of remaining TTL below which we eagerly re-sign a part
   * URL before using it. The default 900 s presign window is shorter than a
   * single slow part can take on a thin link, so for upload runs that exceed
   * the initial window the tail parts would 403 at PUT time. 60 s is enough
   * margin for the PUT handshake + any clock skew between browser and S3.
   */
  private static readonly _PART_URL_REFRESH_MARGIN_MS = 60_000;

  private async _signMultipartPart(key: string, uploadId: string, partNumber: number): Promise<PresignedUpload> {
    if (this._isRemote) {
      return await this._proxy!.invokeWithOptions(
        "signMultipartPart",
        [key, uploadId, partNumber],
        { timeoutMs: 0 },
      ) as PresignedUpload;
    }
    if (!this._core) throw new Error("[@wc-bindable/hawc-s3] no core attached.");
    return await this._core.signMultipartPart(key, uploadId, partNumber);
  }

  private _abortMultipartFireAndForget(key: string, uploadId: string): void {
    if (this._isRemote) {
      // `invoke(name, ...args)` is variadic; passing `[key, uploadId]` as a
      // single array arg arrives server-side as one array-typed argument and
      // Core.abortMultipart rejects on `if (!key || !uploadId)` — the bug is
      // then silently swallowed by our `.catch(() => {})` and S3 keeps the
      // orphan multipart. Spread the args to fix the call shape.
      this._proxy!.invoke("abortMultipart", key, uploadId).catch(() => {});
    } else {
      this._core?.abortMultipart(key, uploadId).catch(() => {});
    }
  }

  /**
   * Run the full upload flow. Routes through multipart automatically when
   * `file.size > multipartThreshold`. Resolves with the final download URL.
   *
   * Re-entry is serialized: if a previous upload() is still in flight when
   * this is called (e.g. a rapid double-trigger from a button), we abort the
   * prior upload and wait for it to fully unwind before starting the new one.
   * Without this, the two workers would share `_xhrs` and `_multipartLoaded`,
   * and the prior multipart's uploadId would leak on S3 because the Core's
   * `_multipart` slot is single-valued.
   */
  async upload(): Promise<string | null> {
    if (this._currentUpload) {
      this.abort();
      // The aborted upload's workers reject through their normal error paths,
      // so awaiting here lets `_xhrs`, `_multipartLoaded`, and the Core's
      // multipart slot drain to a clean state before we start fresh.
      await this._currentUpload.catch(() => {});
    }

    const file = this._file;
    if (!file) {
      const err = new Error("[@wc-bindable/hawc-s3] file is required. Set the .file property before triggering upload.");
      this._setErrorState(err);
      throw err;
    }
    this._aborted = false;
    const key = this._deriveKey(file);
    const contentType = this.contentType || (file as any).type || undefined;

    const promise = (file.size > this.multipartThreshold)
      ? this._doMultipart(key, file, contentType)
      : this._doSingle(key, file, contentType);
    this._currentUpload = promise;
    // Use .then(cleanup, cleanup) — NOT .finally() — for the bookkeeping
    // chain. promise.finally(cb) returns a *new* promise that mirrors the
    // original's rejection; since we discard that promise, every failed
    // upload would otherwise surface as an unhandledrejection. The two-arg
    // .then form runs cleanup on both branches and returns a promise that
    // resolves with undefined regardless of the original outcome.
    const clear = (): void => {
      // Only clear the slot if it still points at us — a re-entrant upload()
      // may have already replaced it.
      if (this._currentUpload === promise) this._currentUpload = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async _doSingle(key: string, file: Blob, contentType: string | undefined): Promise<string | null> {
    let presigned: PresignedUpload;
    try {
      presigned = await this._requestUpload(key, file.size, contentType);
    } catch (e: any) {
      this._setErrorState(e);
      throw e;
    }
    let etag = "";
    try {
      etag = await this._putBlob(presigned, file);
    } catch (e: any) {
      this._setErrorState(e);
      // Notify the Core so it can drop uploading state. Best-effort.
      if (this._isRemote) {
        this._proxy!.invoke("abort").catch(() => {});
      } else {
        this._core?.abort();
      }
      throw e;
    }
    try {
      const downloadUrl = await this._complete(key, etag);
      this._clearErrorState();
      return downloadUrl;
    } catch (e: any) {
      this._setErrorState(e);
      throw e;
    }
  }

  private async _doMultipart(key: string, file: Blob, contentType: string | undefined): Promise<string | null> {
    let init: MultipartInit;
    try {
      init = await this._requestMultipart(key, file.size, contentType);
    } catch (e: any) {
      this._setErrorState(e);
      throw e;
    }
    const totalSize = file.size;
    this._multipartLoaded.clear();

    // Worker pool: pull part indices from a shared cursor. Limits in-flight
    // XHRs to `multipartConcurrency` regardless of part count.
    const completed: MultipartPart[] = new Array(init.parts.length);
    const concurrency = Math.min(this.multipartConcurrency, init.parts.length);
    let cursor = 0;
    let firstError: Error | null = null;

    const worker = async (): Promise<void> => {
      while (!firstError && !this._aborted) {
        const idx = cursor++;
        if (idx >= init.parts.length) return;
        const part = init.parts[idx];
        try {
          const blobSlice = file.slice(part.range[0], part.range[1]);
          const etag = await this._putPart(init.uploadId, init.key, part, blobSlice, totalSize);
          completed[idx] = { partNumber: part.partNumber, etag };
        } catch (e: any) {
          if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
          return;
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    if (this._aborted || firstError) {
      // Cancel any still-running XHRs (rare race) and tell the server to clean up.
      this._cancelXhrs();
      this._abortMultipartFireAndForget(key, init.uploadId);
      const err = firstError ?? new Error("[@wc-bindable/hawc-s3] upload aborted.");
      // Preserve a more specific error already surfaced by the transport-failure
      // handler — overwriting it with a generic "upload aborted" hides the real
      // cause from the consumer. We still throw so the upload promise rejects.
      if (!this._hasLocalError) this._setErrorState(err);
      throw err;
    }

    try {
      const downloadUrl = await this._completeMultipart(key, init.uploadId, completed);
      this._clearErrorState();
      return downloadUrl;
    } catch (e: any) {
      this._setErrorState(e);
      throw e;
    }
  }

  /** Single-PUT path. Returns the ETag with quotes stripped. */
  private async _putBlob(presigned: PresignedUpload, file: Blob): Promise<string> {
    const raw = await retryWithBackoff(
      () => this._doPutOnce(presigned.method, presigned.url, presigned.headers ?? {}, file,
        (loaded, total) => this._reportProgress(loaded, total)),
      {
        maxRetries: this.putRetries,
        isRetriable: defaultPutRetryPolicy,
        isAborted: () => this._aborted,
      },
    );
    return raw.replace(/^"|"$/g, "");
  }

  /** One part PUT. Returns the raw quoted ETag (S3 needs it quoted in the Complete XML). */
  private async _putPart(
    uploadId: string,
    key: string,
    part: MultipartPartUrl,
    blob: Blob,
    totalSize: number,
  ): Promise<string> {
    // Mutable copy of the URL + expiry + headers for this part. Refreshed
    // lazily when its remaining TTL drops below the margin, or on a 403 from
    // S3 (which is the only signal we get that the signature expired
    // mid-flight — AWS returns 403 AccessDenied, not 401, for expired
    // presigns). Headers are kept in lockstep with url/expiresAt because
    // some providers rotate signed headers (e.g. SSE-C key material) on
    // each presign call; reusing stale headers against a fresh URL would
    // fail signature validation even though the URL itself is valid.
    let url = part.url;
    let expiresAt = part.expiresAt;
    let headers = part.headers ?? {};
    // Set once per outer retry attempt when we've already consumed our single
    // "re-sign on 403" allowance. If the refreshed URL 403s again, it is a
    // real deny — stop retrying and surface the error to the caller.
    let refreshedOnce = false;

    const refreshIfNearExpiry = async (): Promise<void> => {
      const remaining = expiresAt - Date.now();
      if (remaining > S3._PART_URL_REFRESH_MARGIN_MS) return;
      const refreshed = await this._signMultipartPart(key, uploadId, part.partNumber);
      url = refreshed.url;
      expiresAt = refreshed.expiresAt;
      headers = refreshed.headers ?? {};
    };

    const attemptOnce = (): Promise<string> =>
      this._doPutOnce("PUT", url, headers, blob, (loaded) => {
        this._multipartLoaded.set(part.partNumber, loaded);
        let total = 0;
        for (const v of this._multipartLoaded.values()) total += v;
        this._reportProgress(total, totalSize);
      }, () => {
        // On success, force the per-part tally to the full slice size in
        // case the browser batched the final progress event with `load`.
        this._multipartLoaded.set(part.partNumber, blob.size);
        let total = 0;
        for (const v of this._multipartLoaded.values()) total += v;
        this._reportProgress(total, totalSize);
      });

    return await retryWithBackoff(
      async (attempt) => {
        // On retry, reset our tally for this part so progress does not double-count
        // bytes from the failed attempt. Fixes a UI glitch where the bar would
        // briefly show >100% during retry.
        if (attempt > 0) this._multipartLoaded.set(part.partNumber, 0);
        refreshedOnce = false;
        await refreshIfNearExpiry();
        try {
          return await attemptOnce();
        } catch (e: any) {
          // 403 can mean either "signature expired" or "genuinely denied".
          // defaultPutRetryPolicy does not retry 4xx (won't fix itself),
          // so we handle the expiry case inline: re-sign once and retry
          // immediately. Second 403 falls through to the retry policy,
          // which correctly classifies it as terminal.
          if (
            e instanceof PutHttpError && e.status === 403
            && !refreshedOnce && !this._aborted
          ) {
            refreshedOnce = true;
            const refreshed = await this._signMultipartPart(key, uploadId, part.partNumber);
            url = refreshed.url;
            expiresAt = refreshed.expiresAt;
            headers = refreshed.headers ?? {};
            this._multipartLoaded.set(part.partNumber, 0);
            return await attemptOnce();
          }
          throw e;
        }
      },
      {
        maxRetries: this.putRetries,
        isRetriable: defaultPutRetryPolicy,
        isAborted: () => this._aborted,
      },
    );
  }

  /**
   * Perform a single PUT attempt. Throws PutHttpError on non-2xx (so the
   * retry policy can inspect the status) or a plain Error on network failure
   * / abort (always retried unless aborted).
   */
  private _doPutOnce(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Blob,
    onProgress?: (loaded: number, total: number) => void,
    onLoad?: () => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this._xhrs.add(xhr);
      xhr.open(method, url, true);
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
      if (onProgress) {
        xhr.upload.addEventListener("progress", (ev: ProgressEvent) => {
          if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
        });
      }
      xhr.addEventListener("load", () => {
        this._xhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader("ETag");
          if (!etag) {
            // 2xx with no ETag is a silent-data-corruption trap: we would
            // resolve with "" and let `_complete()` / `completeMultipart()`
            // stamp an empty etag into the post-process context and the
            // download presign. The two realistic causes — missing
            // `ExposeHeaders: ["ETag"]` on the bucket CORS, and an
            // S3-compatible server that does not emit ETag at all — are
            // both configuration issues that will not self-heal, so the
            // retry policy also classifies this as non-retriable.
            reject(new MissingEtagError(
              `[@wc-bindable/hawc-s3] PUT succeeded (${xhr.status}) but response has no ETag header. Check bucket CORS 'ExposeHeaders: [\"ETag\"]' or verify the S3-compatible server emits ETag.`
            ));
            return;
          }
          if (onLoad) onLoad();
          resolve(etag);
        } else {
          reject(new PutHttpError(
            `[@wc-bindable/hawc-s3] PUT failed (${xhr.status}).`,
            xhr.status,
            xhr.responseText || xhr.statusText || "",
          ));
        }
      });
      xhr.addEventListener("error", () => {
        this._xhrs.delete(xhr);
        reject(new Error("[@wc-bindable/hawc-s3] network error during PUT."));
      });
      xhr.addEventListener("abort", () => {
        this._xhrs.delete(xhr);
        // Marked non-retriable by the retry policy via the abort signal check
        // — defaultPutRetryPolicy still returns true for plain Errors, but
        // retryWithBackoff polls isAborted() before sleeping and after waking,
        // so the loop bails out without another attempt.
        reject(new Error("[@wc-bindable/hawc-s3] upload aborted."));
      });
      xhr.send(body);
    });
  }

  private _cancelXhrs(): void {
    for (const xhr of this._xhrs) {
      try { xhr.abort(); } catch { /* already done */ }
    }
    this._xhrs.clear();
  }

  abort(): void {
    this._aborted = true;
    this._cancelXhrs();
    if (this._isRemote) {
      // Server-side abort handles both single and multipart cleanup
      // (multipart triggers an abortMultipart on the active uploadId).
      this._proxy!.invoke("abort").catch(() => {});
    } else {
      this._core?.abort();
    }
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
    if (config.remote.enableRemote && !this._isRemote) {
      try {
        this._initRemote();
        // Clear any local error left over from a prior failed session. Just
        // zeroing `_errorState` here (the previous behavior) left
        // `_hasLocalError === true`, so the error getter's remote branch
        // short-circuited to the (now null) local slot forever and hid real
        // server-side errors. `_clearErrorState()` resets both flags and
        // dispatches `hawc-s3:error` so subscribers see the transition to
        // the clean state. It is a no-op on the very first connect (when no
        // prior error has ever been set), so we do not spuriously dispatch.
        this._clearErrorState();
      } catch (error) {
        this._setErrorState(error);
      }
    }
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    // Mirror DOM-driven input changes into the active Core (local or remote).
    if (name === "bucket" || name === "prefix") {
      this._syncInput(name, newValue || "");
    } else if (name === "content-type") {
      this._syncInput("contentType", newValue || "");
    }
  }

  private _syncInput(name: string, value: string): void {
    if (this._isRemote && this._proxy) {
      this._proxy.setWithAck(name, value).catch((e: unknown) => this._setErrorState(e));
    } else if (this._core) {
      (this._core as any)[name] = value;
    }
  }

  disconnectedCallback(): void {
    this._aborted = true;
    this._cancelXhrs();
    if (this._isRemote) {
      // Fire-and-forget server abort before dropping the channel — after
      // `_disposeRemote()` the proxy is gone and this call is impossible.
      this._proxy!.invoke("abort").catch(() => {});
      this._disposeRemote();
    } else if (this._core) {
      this._core.abort();
    }
  }
}
