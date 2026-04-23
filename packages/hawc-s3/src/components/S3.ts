import { _getInternalConfig, getRemoteCoreUrl } from "../config.js";
import {
  IWcBindable, S3Progress, S3ObjectMetadata, PresignedUpload,
  MultipartInit, MultipartPart, MultipartPartUrl,
} from "../types.js";
import type { WcsS3AnyError } from "../types.js";
import { S3Core } from "../core/S3Core.js";
import { retryWithBackoff, defaultPutRetryPolicy, PutHttpError } from "../retry.js";
import { normaliseError } from "../normaliseError.js";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
  type ClientTransport,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { doPutOnce, cancelXhrs } from "./xhrUploader.js";
import { validateRemoteCoreUrl } from "./remoteConnection.js";

type S3ElementError = WcsS3AnyError;

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
  private _errorState: S3ElementError = null;
  private _hasLocalError: boolean = false;
  /** Set true when abort() runs so part workers can short-circuit. */
  private _aborted: boolean = false;
  /** The currently-running upload(), if any. Used to serialize re-entry. */
  private _currentUpload: Promise<string | null> | null = null;
  /**
   * Monotonic counter bumped on every `upload()` start. The `.then(cleanup)`
   * guard uses this (in addition to Promise identity) to determine whether
   * the slot it is clearing is really its own — Promise-identity alone is
   * not enough when a failed upload's rejection can be dispatched AFTER a
   * newer upload has already overwritten `_currentUpload` but BEFORE the
   * new one resolves. Without the generation check, the older promise's
   * `clear` sees `this._currentUpload === promise` is false and correctly
   * skips; but the older promise's handler could still clobber the slot
   * in a contended re-entry scenario. The counter makes the ownership
   * check deterministic.
   */
  private _uploadGeneration: number = 0;
  /**
   * The `onFail` handler currently wired to the active WebSocket, if any.
   * We stash it here (instead of closing over a local `const` only) so
   * `_disposeRemote()` can detach it before calling `ws.close()` — without
   * this, the async `close` event fires after our teardown and re-enters
   * `onFail`, which then tries to set an error on a half-disposed instance
   * and re-dispatches a spurious `hawc-s3:error` event. The `{ once: true }`
   * listener flag also prevented re-entry, but only once per event kind;
   * `error` + `close` still cross-fired.
   */
  private _currentOnFail: (() => void) | null = null;

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
    // URL validation (empty, unparseable, wrong scheme) is extracted to a
    // helper in `./remoteConnection.ts` (C7-#2) so the element method below
    // stays focused on wiring up the WebSocket + proxy + bind chain. The
    // helper throws descriptive errors that `connectedCallback`'s try/catch
    // forwards through `_setErrorState`.
    validateRemoteCoreUrl(url);
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
    this._currentOnFail = onFail;
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
      // Detach the `onFail` listeners BEFORE closing. `ws.close()` dispatches
      // the `close` event asynchronously; if the listener is still attached
      // at dispatch time, it re-runs `_setErrorState`, `_resetRemoteBusyState`,
      // and the teardown recursion, which double-dispatches
      // `hawc-s3:error` to subscribers and transiently re-flips
      // loading/uploading. The `{ once: true }` flag is per-event-kind, so an
      // earlier `error` event does not stop the subsequent `close` handler
      // from firing. Explicit detachment is the only way to guarantee a
      // single failure dispatch per socket.
      const onFail = this._currentOnFail;
      if (onFail) {
        try { ws.removeEventListener("error", onFail); } catch { /* noop */ }
        try { ws.removeEventListener("close", onFail); } catch { /* noop */ }
      }
      this._currentOnFail = null;
      try { ws.close(); } catch { /* already closed */ }
    } else {
      this._currentOnFail = null;
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

  private _setErrorState(error: unknown): void {
    // Normalise to something that satisfies the typed error union. Non-Error
    // throws (strings, plain objects, nullish values) are re-wrapped by the
    // shared helper so consumers receive a stable interface regardless of
    // how the provider / remote transport phrased the rejection. Core uses
    // the same helper, so local and remote consumers observe identical shape.
    const normalised: S3ElementError = normaliseError(error);
    this._errorState = normalised;
    this._hasLocalError = true;
    this.dispatchEvent(new CustomEvent("hawc-s3:error", { detail: normalised, bubbles: true }));
  }

  private _clearErrorState(): void {
    if (!this._hasLocalError) return;
    this._hasLocalError = false;
    this._errorState = null;
    this.dispatchEvent(new CustomEvent("hawc-s3:error", { detail: this.error, bubbles: true }));
  }

  /** @internal — visible for testing */
  _connectRemote(transport: ClientTransport): void {
    // Defend against dual-attached state. If a caller (test, integration
    // harness, external mutator) has already wired a local Core via
    // `attachLocalCore`, the element would otherwise operate in an
    // undefined mix: `_isRemote` would return true because `_proxy` is
    // being installed, but attribute-sync and `upload()` dispatch also
    // consult `_core` — leading to inconsistent duplicated state changes
    // and duplicate S3 requests.
    if (this._core) {
      throw new Error("[@wc-bindable/hawc-s3] _connectRemote() called while a local Core is already attached. Call disconnectedCallback / detach first.");
    }
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
    // Mirror of `_connectRemote`'s guard. A Shell with `_proxy` set already
    // has a RemoteCoreProxy handling its method dispatch; installing a
    // second, local Core on top would duplicate every attribute-sync write
    // and every upload() side-effect between the two pipes.
    if (this._proxy) {
      throw new Error("[@wc-bindable/hawc-s3] attachLocalCore() called while a remote proxy is already attached. Call disconnectedCallback / detach first.");
    }
    this._core = core;
    if (this.bucket) this._core.bucket = this.bucket;
    if (this.prefix) this._core.prefix = this.prefix;
    if (this.contentType) this._core.contentType = this.contentType;
  }

  // --- Input attributes ---

  /**
   * DOM-reflected input attributes. The setter routes null/undefined through
   * `removeAttribute` instead of letting `setAttribute(name, null)` stringify
   * the value to the literal `"null"` — which would roundtrip through the
   * getter as the string "null" (a legitimate-looking bucket/prefix name
   * that AWS would then sign as-is). Matches DOMString reflection idioms:
   * `el.title = null` clears the attribute rather than setting `title="null"`.
   */
  get bucket(): string { return this.getAttribute("bucket") || ""; }
  set bucket(value: string | null | undefined) {
    if (value == null) this.removeAttribute("bucket");
    else this.setAttribute("bucket", value);
  }

  get prefix(): string { return this.getAttribute("prefix") || ""; }
  set prefix(value: string | null | undefined) {
    if (value == null) this.removeAttribute("prefix");
    else this.setAttribute("prefix", value);
  }

  get contentType(): string { return this.getAttribute("content-type") || ""; }
  set contentType(value: string | null | undefined) {
    if (value == null) this.removeAttribute("content-type");
    else this.setAttribute("content-type", value);
  }

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

  get error(): S3ElementError {
    if (this._isRemote) {
      if (this._hasLocalError) return this._errorState;
      // Has the remote Core ever published an `error` value on this
      // connection? `_remoteValues` is initialised as an empty object and
      // the `bind()` callback only writes keys for properties the server
      // has actually emitted — so the `in` check is our explicit sentinel
      // for "remote Core has delivered an error snapshot (including an
      // explicit null-clear), prefer it". When the remote side has never
      // spoken about errors, fall through to the local error state so
      // pre-remote failures (e.g. `_initRemote` itself threw) remain
      // visible. Using `in` rather than `!== undefined` guarantees the
      // behaviour survives future `_remoteValues` initialisation shape
      // changes that might default the slot to `undefined`.
      return "error" in this._remoteValues
        ? (this._remoteValues.error as S3ElementError)
        : this._errorState;
    }
    return this._core?.error ?? this._errorState;
  }

  // --- Trigger ---

  get trigger(): boolean { return this._trigger; }

  /**
   * Setter for the `trigger` edge-driven command.
   *
   * `trigger` is an edge-driven command, NOT a piece of synchronised state:
   * only the rising edge from `false` to `true` at a moment when no upload
   * is in flight starts a fresh upload. Assigning `true` in any of these
   * cases is a silent no-op — no state change, no `hawc-s3:trigger-changed`
   * event, no duplicate `upload()` call:
   *
   *   1. An upload is already in flight (`_currentUpload` is non-null).
   *   2. `trigger` is already `true` (flip from true→true).
   *
   * Assigning `false` is always a no-op for the command side (the falling
   * edge is reserved for the completion handler below to reset the flag).
   *
   * This asymmetry is deliberate: consumers binding `trigger` to a reactive
   * framework expect "please upload" idempotency, i.e. rapid repeated
   * `trigger=true` writes should not cancel the in-flight upload and start
   * a second one, and should not leak a second `hawc-s3:trigger-changed`
   * event pair. If you need "cancel the in-flight upload and start a new
   * one", call `abort()` + `upload()` explicitly (see `upload()`'s JSDoc
   * for the correct sequence); `trigger` does not offer that escape hatch.
   */
  set trigger(value: boolean) {
    const v = !!value;
    if (v) {
      // If an upload is already in flight, swallow the re-trigger rather than
      // firing a second upload() that would abort the first. The prior
      // behavior called upload() unconditionally, so a rapid `trigger=true;
      // trigger=true;` from a bound checkbox would race the first upload
      // into a cancel before it had a chance to make progress — even though
      // the consumer's intent was "please upload", which is already happening.
      // Fall-through remains: a trigger flip from true-to-true is a no-op,
      // and the falling edge does nothing (upload start happens on the
      // rising edge only).
      //
      // No `hawc-s3:trigger-changed` event is dispatched on the no-op path.
      // That event signals an observable state transition of the trigger
      // property; since the property value does not change (and no fresh
      // upload is started), emitting it would be misleading. This is
      // documented in the README's `<hawc-s3>` property table.
      if (this._currentUpload) return;
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

  /**
   * Unified local/remote async dispatcher. `local` is a function that runs
   * against the already-resolved local Core; `remoteName` is the Core-side
   * wc-bindable command name invoked through the proxy. Async commands
   * disable the proxy timeout (`timeoutMs: 0`) because long uploads routinely
   * outlive the 30s default — presign itself is fast but the surrounding
   * flow holds the proxy slot until the PUT + post-process finish.
   *
   * Collapses seven formerly-duplicated `if (this._isRemote) … else …`
   * templates into one call shape (C7-#8). The `local` arg is a thunk over
   * `this._core` so TypeScript can type-check the `Core.method(args…)` call
   * at each call site; the remote branch is typed as `Promise<unknown>` and
   * cast once at the return — matching the raw proxy API shape, which is
   * string-indexed RPC.
   */
  private async _dispatchAsync<T>(
    remoteName: string,
    remoteArgs: readonly unknown[],
    local: (core: S3Core) => Promise<T>,
  ): Promise<T> {
    if (this._isRemote) {
      return await this._proxy!.invokeWithOptions(remoteName, remoteArgs as unknown[], { timeoutMs: 0 }) as T;
    }
    if (!this._core) throw new Error("[@wc-bindable/hawc-s3] no core attached.");
    return await local(this._core);
  }

  /**
   * Fire-and-forget variant for commands whose return value the Shell does
   * not consume (progress reports, abortMultipart cleanup, and the abort()
   * RPC itself). Proxy errors are swallowed because the commands are
   * advisory — a transport hiccup on `reportProgress` is noise, and the
   * abort cleanup path has no recovery handler the caller could usefully
   * react to.
   *
   * IMPORTANT: the remote branch uses `proxy.invoke(name, ...args)` which is
   * *variadic*, not array-taking. Passing an array as a single argument would
   * arrive server-side as one array-typed value; `Core.reportProgress` /
   * `Core.abortMultipart` would then fail their `Number.isFinite` / `if
   * (!key || !uploadId)` guards and the bug would be silently swallowed by
   * the `.catch(() => {})` below. Spreading `...remoteArgs` preserves the
   * expected call shape.
   */
  private _dispatchFireAndForget(
    remoteName: string,
    remoteArgs: readonly unknown[],
    local: (core: S3Core) => void,
  ): void {
    if (this._isRemote) {
      this._proxy!.invoke(remoteName, ...remoteArgs).catch(() => {});
      return;
    }
    if (this._core) local(this._core);
  }

  private _requestUpload(key: string, size: number, contentType?: string): Promise<PresignedUpload> {
    return this._dispatchAsync(
      "requestUpload",
      [key, size, contentType],
      (core) => core.requestUpload(key, size, contentType),
    );
  }

  private _requestMultipart(key: string, size: number, contentType?: string): Promise<MultipartInit> {
    return this._dispatchAsync(
      "requestMultipartUpload",
      [key, size, contentType],
      (core) => core.requestMultipartUpload(key, size, contentType),
    );
  }

  private _reportProgress(loaded: number, total: number): void {
    this._dispatchFireAndForget(
      "reportProgress",
      [loaded, total],
      (core) => core.reportProgress(loaded, total),
    );
  }

  private _complete(key: string, etag?: string): Promise<string> {
    return this._dispatchAsync(
      "complete",
      [key, etag],
      (core) => core.complete(key, etag),
    );
  }

  private _completeMultipart(key: string, uploadId: string, parts: MultipartPart[]): Promise<string> {
    return this._dispatchAsync(
      "completeMultipart",
      [key, uploadId, parts],
      (core) => core.completeMultipart(key, uploadId, parts),
    );
  }

  /**
   * Number of seconds of remaining TTL below which we eagerly re-sign a part
   * URL before using it. The default 900 s presign window is shorter than a
   * single slow part can take on a thin link, so for upload runs that exceed
   * the initial window the tail parts would 403 at PUT time. 60 s is enough
   * margin for the PUT handshake + any clock skew between browser and S3.
   */
  private static readonly _PART_URL_REFRESH_MARGIN_MS = 60_000;

  private _signMultipartPart(key: string, uploadId: string, partNumber: number): Promise<PresignedUpload> {
    return this._dispatchAsync(
      "signMultipartPart",
      [key, uploadId, partNumber],
      (core) => core.signMultipartPart(key, uploadId, partNumber),
    );
  }

  private _abortMultipartFireAndForget(key: string, uploadId: string): void {
    this._dispatchFireAndForget(
      "abortMultipart",
      [key, uploadId],
      // Core.abortMultipart is async, but we ignore the returned promise —
      // the whole point of fire-and-forget is that the Shell does not wait
      // for S3's cleanup ack. Swallow the rejection to match the remote
      // branch's silent-drop behaviour.
      (core) => { core.abortMultipart(key, uploadId).catch(() => {}); },
    );
  }

  /**
   * Run the full upload flow. Routes through multipart automatically when
   * `file.size > multipartThreshold`. Resolves with the final download URL.
   *
   * Re-entry is no-op: if a previous upload() is still in flight when this
   * is called (e.g. a rapid double-trigger, or `trigger=true` firing twice
   * from a bound checkbox), we return the existing in-flight promise rather
   * than abort-and-replace. This matches the `trigger=true` setter's
   * semantics and prevents the two workers from sharing `_xhrs` /
   * `_multipartLoaded` state or leaking a half-initialised multipart
   * uploadId on S3 (Core's `_multipart` slot is single-valued).
   *
   * Consumers who genuinely want to cancel an in-flight upload and restart
   * with new inputs MUST await the in-flight promise's settlement before
   * calling `upload()` again — `abort()` does not synchronously null the
   * slot (see `abort()`'s JSDoc), so an immediate `upload()` right after
   * `abort()` would still observe the aborting promise and return it
   * instead of starting a fresh run. The correct pattern is:
   *
   * ```
   * const p = el.upload();
   * // …later…
   * el.abort();
   * await p.catch(() => {}); // let the prior run unwind & clear the slot
   * await el.upload();       // now starts fresh
   * ```
   *
   * Or, equivalently, capture the returned promise from `upload()` once and
   * reuse the `await … .catch(() => {})` pattern above before each fresh start.
   */
  async upload(): Promise<string | null> {
    if (this._currentUpload) {
      // Return the in-flight promise directly. The caller's expectation
      // "please upload" is already satisfied by the in-flight run; duplicate
      // re-entry should resolve to the same outcome, not blow away and
      // restart (which used to race `_xhrs` and leak multipart uploadIds).
      return this._currentUpload;
    }

    const file = this._file;
    if (!file) {
      const err = new Error("[@wc-bindable/hawc-s3] file is required. Set the .file property before triggering upload.");
      this._setErrorState(err);
      throw err;
    }
    this._aborted = false;
    const key = this._deriveKey(file);
    const contentType = this.contentType || file.type || undefined;

    // Capture this run's generation. The cleanup guard below re-checks it so
    // a reject from an older upload (fired after a newer upload has already
    // taken ownership of the slot) does not blow away the newer slot. Pure
    // Promise-identity comparison was nearly sufficient but relied on the
    // assumption that every reject path would race the overwrite correctly —
    // the generation counter makes the ownership test deterministic.
    const myGen = ++this._uploadGeneration;
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
      // Only clear the slot if it still points at us AND our generation is
      // still the active one. A re-entrant upload() may have already replaced
      // both; a stale reject should NOT clear the newer slot.
      if (this._currentUpload === promise && this._uploadGeneration === myGen) {
        this._currentUpload = null;
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  /**
   * Route a failure into the local error slot only when the Core has not
   * already published it through the `bind()` mirror. In remote mode, every
   * `_dispatchAsync` RPC (`_requestUpload`, `_complete`, `_requestMultipart`,
   * `_completeMultipart`, `_signMultipartPart`) that throws on the server
   * side has already triggered `S3Core._setError(...)` BEFORE the proxy's
   * rejection reaches us — the Core runs `_setError(e); throw e;` as a
   * single beat, and the bind subscription delivers the `error` property
   * update to `_remoteValues.error` + dispatches `hawc-s3:error` along with
   * (not after) the rpc-reject delivery. Calling `_setErrorState(e)` in the
   * RPC catch on top of that produced two `hawc-s3:error` events for the
   * same logical failure, which broke the "one failure, one event"
   * contract subscribers rely on for reactive UI state transitions.
   *
   * Local-failure paths (`_putBlob`, `_putPart`, the aborted-multipart
   * bookkeeping) are NOT routed through this helper — the Core has no way
   * to know an XHR failed on the client, so the Shell is the only source of
   * the error event for those and MUST dispatch directly.
   */
  private _setRpcErrorState(error: unknown): void {
    if (this._isRemote) return;
    this._setErrorState(error);
  }

  private async _doSingle(key: string, file: Blob, contentType: string | undefined): Promise<string | null> {
    let presigned: PresignedUpload;
    try {
      presigned = await this._requestUpload(key, file.size, contentType);
    } catch (e: unknown) {
      this._setRpcErrorState(e);
      throw e;
    }
    let etag = "";
    try {
      etag = await this._putBlob(presigned, file);
    } catch (e: unknown) {
      // Local XHR failure — the remote Core has no idea the PUT failed, so
      // the Shell is the only source of the error event here. Always set
      // local error state; no double-dispatch risk because the Core does
      // not publish one of its own for this path.
      this._setErrorState(e);
      // Notify the Core so it can drop uploading state. Best-effort.
      this._abortFireAndForget();
      throw e;
    }
    try {
      const downloadUrl = await this._complete(key, etag);
      this._clearErrorState();
      return downloadUrl;
    } catch (e: unknown) {
      this._setRpcErrorState(e);
      throw e;
    }
  }

  private async _doMultipart(key: string, file: Blob, contentType: string | undefined): Promise<string | null> {
    let init: MultipartInit;
    try {
      init = await this._requestMultipart(key, file.size, contentType);
    } catch (e: unknown) {
      this._setRpcErrorState(e);
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
        } catch (e: unknown) {
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
      //
      // In remote mode, if the failure originated from an RPC (typically
      // `_signMultipartPart` during a mid-stream re-sign), the server Core
      // has already published the error via `bind()` → `_remoteValues.error`
      // — dispatching locally on top of that produces a duplicate
      // `hawc-s3:error` event for one logical failure. Skip the local
      // dispatch when the remote slot is already populated; `error` getter
      // returns the remote value so subscribers still see the failure
      // through the already-delivered event. For local XHR failures
      // (network error / abort on the part PUT itself), the Core has no
      // signal, so `"error" in _remoteValues` is false and we fall through
      // to the local dispatch exactly as before.
      if (!this._hasLocalError && !(this._isRemote && "error" in this._remoteValues)) {
        this._setErrorState(err);
      }
      throw err;
    }

    try {
      const downloadUrl = await this._completeMultipart(key, init.uploadId, completed);
      this._clearErrorState();
      return downloadUrl;
    } catch (e: unknown) {
      this._setRpcErrorState(e);
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
      // Consume the "re-sign on 403" allowance here — we have already spent a
      // re-presign RTT for this attempt, so if the fresh URL still 403s it is
      // a genuine deny, not an expiry race. Without this flag, a near-expiry
      // refresh immediately followed by a 403 would trigger a second,
      // redundant presign RTT before surfacing the deny to the caller.
      refreshedOnce = true;
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
        } catch (e: unknown) {
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
   * Perform a single PUT attempt. Delegates to the extracted `doPutOnce`
   * helper (see `./xhrUploader.ts`) so the large XHR-plumbing block lives
   * outside the element class. The helper registers the XHR against the
   * Shell's `_xhrs` Set so `_cancelXhrs()` still reaches every in-flight
   * request.
   */
  private _doPutOnce(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Blob,
    onProgress?: (loaded: number, total: number) => void,
    onLoad?: () => void,
  ): Promise<string> {
    return doPutOnce(method, url, headers, body, this._xhrs, onProgress, onLoad);
  }

  private _cancelXhrs(): void {
    cancelXhrs(this._xhrs);
  }

  /**
   * Cancel any in-flight upload. Signals the worker pool via `_aborted`,
   * cancels every running XHR, and tells the active Core (local or remote)
   * to abort its own state machine.
   *
   * Note on `_currentUpload`: we intentionally do NOT null the slot here.
   * The underlying promise still needs to resolve/reject through the normal
   * error path so `.then(clear, clear)` can observe the outcome and perform
   * the final bookkeeping. A re-entrant `upload()` returns the existing
   * in-flight promise (it does not await-then-replace); the slot is cleared
   * by the `.then(clear, clear)` cleanup chain once the aborted promise
   * settles. Consumers who want a fresh run must await that settlement
   * themselves before calling `upload()` again — see `upload()`'s JSDoc for
   * the `abort(); await prior.catch(() => {}); await el.upload();` pattern.
   */
  abort(): void {
    this._aborted = true;
    this._cancelXhrs();
    this._abortFireAndForget();
  }

  /**
   * Dispatch `abort` against either the remote proxy or the local Core. The
   * remote branch returns a promise we deliberately ignore (and swallow any
   * rejection) — server-side abort handles both single and multipart cleanup
   * (multipart triggers an abortMultipart on the active uploadId), and the
   * caller has no recovery strategy for a dead proxy at abort time. The
   * local branch is sync and returns void, so the shapes unify cleanly.
   */
  private _abortFireAndForget(): void {
    this._dispatchFireAndForget(
      "abort",
      [],
      (core) => core.abort(),
    );
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
    if (_getInternalConfig().remote.enableRemote && !this._isRemote) {
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

  /**
   * Names of the mutable inputs we forward between the attribute layer and
   * the underlying Core. Keeping this tight (instead of letting any string
   * through) means a typo at the call site is a TS error, and no arbitrary
   * field on `this._core` can be reassigned via the attribute-sync path —
   * which previously relied on an `as any` cast.
   */
  private static readonly _SYNC_INPUTS = ["bucket", "prefix", "contentType"] as const;

  private _syncInput(name: typeof S3._SYNC_INPUTS[number], value: string): void {
    if (this._isRemote && this._proxy) {
      this._proxy.setWithAck(name, value).catch((e: unknown) => this._setErrorState(e));
    } else if (this._core) {
      // `_SYNC_INPUTS` members are literal keys of the relevant S3Core props
      // (all `string` typed). The `switch` lets TS narrow the assignment by
      // name, so no `as any` is needed.
      switch (name) {
        case "bucket":      this._core.bucket = value; break;
        case "prefix":      this._core.prefix = value; break;
        case "contentType": this._core.contentType = value; break;
      }
    }
  }

  disconnectedCallback(): void {
    this._aborted = true;
    this._cancelXhrs();
    if (this._isRemote) {
      // Fire-and-forget server abort before dropping the channel — after
      // `_disposeRemote()` the proxy is gone and the remote branch of the
      // dispatcher would no-op.
      this._abortFireAndForget();
      this._disposeRemote();
    } else if (this._core) {
      this._core.abort();
    }
  }
}
