import type { ClientTransport } from "@wc-bindable/remote";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import type { RemoteCoreProxy } from "@wc-bindable/remote";
import type { WcBindableDeclaration, UnbindFn } from "@wc-bindable/core";
import { bind } from "@wc-bindable/core";
import { config } from "../config.js";
import { ERROR_PREFIX, OWNERSHIP_ERROR_MARKER, isOwnershipError } from "../raiseError.js";
import { IWcBindable } from "../types.js";
import { getCoreDeclaration } from "../coreRegistry.js";
import type { Auth } from "./Auth.js";

/**
 * `<auth0-session>` — declarative remote session gate.
 *
 * Pairs with a `<auth0-gate>` (referenced by `target` ID) and collapses
 * the three-stage readiness sequence (authenticated → WebSocket connected
 * → initial sync complete) into a single declarative signal.
 *
 * Resolves the Core declaration by looking up `core` in the coreRegistry
 * (`registerCoreDeclaration(key, decl)`). When the target's
 * `authenticated` goes `true`, it:
 *   1. Calls `authEl.connect()` to open the authenticated WebSocket.
 *   2. Wraps the returned transport with `createRemoteCoreProxy()`.
 *   3. Subscribes via `bind()` and treats the first callback batch as
 *      "sync complete" — at that point `ready` flips to `true`.
 *
 * The resulting proxy is exposed as `.proxy` (JS-only, for applications
 * that want to bind to Core properties directly). The session's own
 * bindable surface is intentionally minimal — `ready`, `connecting`,
 * `error` — so `data-wcs` can gate UI on `ready` without the application
 * having to re-implement "first batch" detection.
 */
export class AuthSession extends HTMLElement {
  static hasConnectedCallbackPromise = true;

  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "ready",      event: "auth0-session:ready-changed" },
      { name: "connecting", event: "auth0-session:connecting-changed" },
      { name: "error",      event: "auth0-session:error" },
    ],
  };

  static get observedAttributes(): string[] {
    return ["target", "core", "url", "auto-connect"];
  }

  private _ready = false;
  private _connecting = false;
  private _error: Error | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _transport: ClientTransport | null = null;
  private _unbind: UnbindFn | null = null;
  private _authEl: Auth | null = null;
  private _coreDecl: WcBindableDeclaration | null = null;
  private _authListener: ((e: Event) => void) | null = null;
  private _connectedListener: ((e: Event) => void) | null = null;
  private _connectedCallbackPromise: Promise<void> = Promise.resolve();
  // Coalesce bursts of attribute changes (frameworks often stamp
  // target/core/url/auto-connect in quick succession) into a single
  // `_startWatching()` run.
  private _attrRestartScheduled = false;

  // Monotonic counter incremented on every teardown (logout listener or
  // disconnectedCallback). `_connect()` captures the value at entry and
  // discards its own work — including the just-opened transport and any
  // in-flight "first sync batch" microtask — if the counter has moved
  // forward by the time an `await` resolves. Without this, a handshake
  // that completes AFTER logout/remove would still install a live proxy
  // and flip `ready=true`.
  private _generation = 0;

  // --- Attributes -----------------------------------------------------------

  get target(): string {
    return this.getAttribute("target") || "";
  }

  set target(value: string) {
    this.setAttribute("target", value);
  }

  get core(): string {
    return this.getAttribute("core") || "";
  }

  set core(value: string) {
    this.setAttribute("core", value);
  }

  /** Optional URL override. Falls back to the target `<auth0-gate>`'s `remote-url`. */
  get url(): string {
    return this.getAttribute("url") || "";
  }

  set url(value: string) {
    this.setAttribute("url", value);
  }

  /** Whether to auto-connect when the target becomes authenticated (default true). */
  get autoConnect(): boolean {
    const v = this.getAttribute("auto-connect");
    return v === null ? true : v !== "false";
  }

  set autoConnect(value: boolean) {
    this.setAttribute("auto-connect", value ? "true" : "false");
  }

  // --- Output state (bindable) ---------------------------------------------

  /** `true` once the first post-sync batch of proxy values has been delivered. */
  get ready(): boolean {
    return this._ready;
  }

  /** `true` between `connect()` start and either `ready` or `error`. */
  get connecting(): boolean {
    return this._connecting;
  }

  get error(): Error | null {
    return this._error;
  }

  // --- JS-only accessors ---------------------------------------------------

  /**
   * The `RemoteCoreProxy` once built. Applications bind to this directly.
   *
   * Lifecycle:
   *   - `null` before the first successful `_connect()` completes.
   *   - Points at a live proxy once the WebSocket handshake resolves
   *     and `createRemoteCoreProxy` wires the transport. The switch
   *     happens BEFORE `ready` flips true (`ready` waits for the
   *     first sync batch; `proxy` becomes reachable as soon as the
   *     transport is installed).
   *   - Returns to `null` on teardown (logout, element removal,
   *     auth-revoked, transport close). A teardown that races a
   *     pending handshake yields `proxy === null` forever for that
   *     handshake — the generation guard drops the late arrival.
   */
  get proxy(): RemoteCoreProxy | null {
    return this._proxy;
  }

  /**
   * The `ClientTransport` underlying `proxy`, exposed for applications
   * that need direct access (e.g. sending raw commands alongside
   * proxy-bound state). Same lifecycle as `proxy` — the pair is
   * installed and cleared atomically.
   */
  get transport(): ClientTransport | null {
    return this._transport;
  }

  get connectedCallbackPromise(): Promise<void> {
    return this._connectedCallbackPromise;
  }

  // --- Lifecycle ------------------------------------------------------------

  connectedCallback(): void {
    this.style.display = "none";
    if (this.autoConnect) {
      // Defer so sibling elements (notably the target `<auth0-gate>`) can
      // finish upgrading before we resolve them by ID.
      this._connectedCallbackPromise = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          this._startWatching().finally(resolve);
        });
      });
    }
    // NB: when `autoConnect` is false, `_connectedCallbackPromise`
    // keeps the already-resolved initial value. Applications that
    // drive the session imperatively via `start()` observe the
    // watching lifecycle through the returned promise from that
    // call; `connectedCallbackPromise` deliberately does not block
    // on a session that may never be started.
  }

  disconnectedCallback(): void {
    this._teardown();
    this._unsubscribeAuth();
    this._authEl = null;
  }

  attributeChangedCallback(_name: string, _oldValue: string | null, _newValue: string | null): void {
    // Framework / declarative integrations that stamp target/core/url
    // AFTER the element is connected (or flip auto-connect from false to
    // true) would otherwise be stuck with whatever value `_startWatching`
    // saw on the very first pass. Restart only when it is safe —
    // i.e. no live transport or in-flight connect — and coalesce bursts
    // of attribute mutations into a single restart via microtask.
    if (!this.isConnected) return;
    if (!this.autoConnect) return;
    if (this._transport || this._connecting) return;
    if (this._attrRestartScheduled) return;
    this._attrRestartScheduled = true;
    queueMicrotask(() => {
      this._attrRestartScheduled = false;
      if (!this.isConnected) return;
      if (!this.autoConnect) return;
      if (this._transport || this._connecting) return;
      this._connectedCallbackPromise = this._startWatching();
    });
  }

  // --- Public imperative API ------------------------------------------------

  /**
   * Manually start a session. Useful when `auto-connect="false"` or when
   * the session needs to be (re)started after an error.
   */
  async start(): Promise<void> {
    return this._startWatching();
  }

  // --- Private --------------------------------------------------------------

  private async _startWatching(): Promise<void> {
    // Cancel any previous cycle (auto-connect that already ran, or an
    // earlier start() call). Without these resets a re-start would leak
    // the prior authenticated-changed listener — `disconnectedCallback`
    // can only remove the most recently stored one — and any in-flight
    // `_connect` from the previous cycle would race with the new one.
    this._unsubscribeAuth();
    this._teardown();
    // Preserve a standing Connection Ownership violation (SPEC-REMOTE
    // §3.7 "surfaces the mistake immediately") across auto-restarts
    // triggered by attributeChangedCallback's microtask coalescer.
    // Without this guard, a framework that re-stamps target / core /
    // url after the initial run would restart `_startWatching`, hit
    // `_setError(null)` here, and wipe the just-shown ownership
    // warning one microtask after it appeared — so the developer
    // never sees the mistake even though the underlying misconfig
    // is still present. If ownership later clears (owner disconnects,
    // config changes, etc.), `_connect` will either succeed or reset
    // to a different error via its own `_setError` calls.
    //
    // Uses the stable `_authOwnership` sentinel property via
    // `isOwnershipError()` rather than a message-substring match.
    // The message wording can drift across refactors; the sentinel
    // is the API contract the producers (`raiseOwnershipError()` in
    // AuthShell, the `_connect` construction below) explicitly opt
    // into.
    const standingOwnershipError = isOwnershipError(this._error) ? this._error : null;
    if (!standingOwnershipError) this._setError(null);

    // Capture generation AFTER teardown so this run is the active one.
    // A subsequent teardown / start() will move it forward and the
    // generation guards below abort this run cleanly.
    const myGen = this._generation;

    const auth = this._resolveAuth();
    if (!auth) {
      this._setError(new Error(`[@wc-bindable/auth0] <auth0-session>: target "${this.target}" not found.`));
      return;
    }
    this._authEl = auth;

    const coreKey = this.core;
    if (!coreKey) {
      this._setError(new Error("[@wc-bindable/auth0] <auth0-session>: `core` attribute is required."));
      return;
    }
    const decl = getCoreDeclaration(coreKey);
    if (!decl) {
      this._setError(new Error(`[@wc-bindable/auth0] <auth0-session>: core "${coreKey}" is not registered. Call registerCoreDeclaration("${coreKey}", decl) first.`));
      return;
    }
    this._coreDecl = decl;

    // Wait for the target to finish initialization (handleRedirectCallback,
    // isAuthenticated probe, etc.) so `auth.authenticated` is settled.
    await auth.connectedCallbackPromise;

    // A concurrent start() / teardown() may have superseded this run while
    // we awaited. Bail before installing a listener that the active run
    // will not be able to remove.
    if (this._generation !== myGen) return;

    // Subscribe to future authenticated-changed events before the current
    // check so we don't miss a near-simultaneous transition.
    const listener = (e: Event): void => {
      const next = (e as CustomEvent).detail;
      if (next === true) {
        void this._connect();
      } else {
        this._teardown();
      }
    };
    this._authListener = listener;
    auth.addEventListener("auth0-gate:authenticated-changed", listener);

    // Notice transport loss. The WebSocket can die independently of
    // Auth0 authentication — server-forced close at token expiry
    // (4401 "Session expired"), `sub` mismatch on refresh (4403),
    // server restart, transient network blip, or a post-upgrade 1008
    // (exp-parse-failure under "close" policy) — in which case
    // AuthShell dispatches `connected-changed: false` but the Auth0
    // SDK's `authenticated` stays true. Without this listener, `ready`
    // would linger at `true` pointing at a dead proxy whose next call
    // rejects with `_disposedError`.
    //
    // `_teardown()` (rather than a manual partial clear) is used so
    // that `_generation` is bumped. That bump is what lets an
    // in-flight `_connect()` — which may have ALREADY resolved its
    // `await auth.connect(...)` on `open` but not yet resumed — see
    // a generation mismatch on resume and skip installing its
    // (already-dead) transport. A manual clear without a generation
    // bump would silently let the resumed `_connect()` wire a
    // `RemoteCoreProxy` onto the closed socket, leaving a
    // half-dead session in `ready=true`.
    const connectedListener = (e: Event): void => {
      const next = (e as CustomEvent).detail;
      if (next === false && (this._transport || this._ready || this._connecting)) {
        this._teardown();
      }
    };
    this._connectedListener = connectedListener;
    auth.addEventListener("auth0-gate:connected-changed", connectedListener);

    if (auth.authenticated) {
      await this._connect();
    }
  }

  private _unsubscribeAuth(): void {
    if (this._authEl && this._authListener) {
      this._authEl.removeEventListener("auth0-gate:authenticated-changed", this._authListener);
    }
    if (this._authEl && this._connectedListener) {
      this._authEl.removeEventListener("auth0-gate:connected-changed", this._connectedListener);
    }
    this._authListener = null;
    this._connectedListener = null;
    // Note: `_authEl` is intentionally NOT cleared here so a subsequent
    // `_startWatching` can re-resolve to (typically) the same target via
    // `_resolveAuth()`. `disconnectedCallback` clears it.
  }

  private async _connect(): Promise<void> {
    if (this._transport || this._connecting) return;
    const auth = this._authEl;
    const decl = this._coreDecl;
    if (!auth || !decl) return;

    // Mutual-exclusion guard (SPEC-REMOTE §3.7). If the target already has
    // an open WebSocket, someone else — typically application code calling
    // authEl.connect() directly — owns the transport. We cannot bind a
    // proxy to a transport we did not create, and calling connect() again
    // would close theirs. Fail visibly instead of producing a silently
    // dead session.
    //
    // Tag the Error with `_authOwnership = true` so `_startWatching`'s
    // standing-error preservation recognises it on the stable sentinel
    // rather than a message-substring match. The sentinel is the same
    // one `raiseOwnershipError()` stamps on AuthShell-originated
    // ownership failures; both sources funnel into `isOwnershipError()`.
    if (auth.connected) {
      const ownershipErr = new Error(
        `${ERROR_PREFIX} <auth0-session>: target is already connected. ` +
        "Use either <auth0-session> OR a manual authEl.connect() — not both. " +
        "See SPEC-REMOTE §3.7 (Connection Ownership).",
      );
      (ownershipErr as unknown as Record<string, boolean>)[OWNERSHIP_ERROR_MARKER] = true;
      this._setError(ownershipErr);
      return;
    }

    // URL contract: either the session's own `url` attribute or the
    // target's `remote-url` must resolve to a non-empty string. Validating
    // here surfaces a friendly, contract-named error before any work is
    // done; without it the empty string flows into AuthShell.connect()
    // and ultimately to `new WebSocket("")`, which produces an opaque
    // SyntaxError that doesn't tell the integrator which attribute to set.
    const url = this.url || auth.remoteUrl;
    if (!url) {
      this._setError(new Error(
        "[@wc-bindable/auth0] <auth0-session>: no WebSocket URL configured. " +
        "Set the `url` attribute on <auth0-session> or `remote-url` on the target <auth0-gate>.",
      ));
      return;
    }

    this._setError(null);
    this._setConnecting(true);
    const myGen = this._generation;
    try {
      // Pass `failIfConnected: true` so AuthShell.connect() atomically
      // rejects when another owner claimed the transport during the
      // `await connectedCallbackPromise` microtask hop inside
      // Auth.connect(). Without this flag the outer `auth.connected`
      // fast-path check (above) has a TOCTOU: a concurrent caller
      // could open a socket between the check and this call, and the
      // subsequent AuthShell.connect() would `_closeWebSocket()` it,
      // violating the Connection Ownership contract (SPEC-REMOTE §3.7).
      const transport = await auth.connect(url, { failIfConnected: true });

      // Race guard: a teardown (logout, element removal, or a
      // `connected-changed: false` that fired AFTER `auth.connect`
      // resolved but BEFORE this microtask resumed) moved the
      // generation forward while we were awaiting. That covers both:
      //   (a) the explicit `_teardown()` paths (logout /
      //       disconnectedCallback / authenticated flipping false),
      //   (b) the server closing the freshly-opened socket with 1008
      //       between `open` and our resume — e.g. exp-parse-failure
      //       under "close" policy, or the defense-in-depth origin
      //       close in `wss.on("connection")` — where our
      //       `connected-changed` listener bumps the generation so
      //       this guard trips and we never wire a `RemoteCoreProxy`
      //       onto a dead socket.
      if (this._generation !== myGen) return;

      this._transport = transport;

      const proxy = createRemoteCoreProxy(decl, transport);
      this._proxy = proxy;

      // First bind callback = first event from the proxy's `sync` handler.
      // `queueMicrotask` defers the ready flip to after the whole batch of
      // initial property events has been dispatched — matching the pattern
      // in SPEC-REMOTE §11 and freeing applications from implementing it.
      // The generation check covers a teardown that lands between bind()
      // registration and the first dispatched event.
      let firstBatch = true;
      this._unbind = bind(proxy, (_name, _value) => {
        if (firstBatch) {
          firstBatch = false;
          queueMicrotask(() => {
            if (this._proxy === proxy && this._generation === myGen) {
              this._setReady(true);
            }
          });
        }
      });
    } catch (err) {
      // Swallow errors from a superseded attempt — reporting them would
      // clobber state the active teardown has already reset.
      if (this._generation !== myGen) return;
      this._setError(err instanceof Error ? err : new Error(String(err)));
      this._teardownProxy();
    } finally {
      // Only clear `connecting` if our generation is still active.
      // A teardown that fired during the await already flipped it to
      // false; stepping on that would produce a spurious false→true→false
      // transition for listeners.
      if (this._generation === myGen) this._setConnecting(false);
    }
  }

  private _teardown(): void {
    // Bumping the generation invalidates any in-flight `_connect()`:
    // the handshake it is awaiting may still resolve, but the race
    // guards in `_connect` will see a mismatched generation and drop
    // the work on the floor.
    this._generation++;
    this._teardownProxy();
    if (this._ready) this._setReady(false);
    if (this._connecting) this._setConnecting(false);
  }

  private _teardownProxy(): void {
    if (this._unbind) {
      this._unbind();
      this._unbind = null;
    }
    // NB: we do NOT close the transport here — the transport is owned by
    // AuthShell (via logout() or reconnect()). Dropping our reference is
    // enough; the underlying WebSocket is managed by the auth element.
    this._proxy = null;
    this._transport = null;
  }

  private _resolveAuth(): Auth | null {
    if (!this.target) return null;
    const el = document.getElementById(this.target);
    if (el && el.tagName.toLowerCase() === config.tagNames.auth) {
      return el as unknown as Auth;
    }
    return null;
  }

  private _setReady(value: boolean): void {
    if (this._ready === value) return;
    this._ready = value;
    this.dispatchEvent(new CustomEvent("auth0-session:ready-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setConnecting(value: boolean): void {
    if (this._connecting === value) return;
    this._connecting = value;
    this.dispatchEvent(new CustomEvent("auth0-session:connecting-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  /**
   * Update the session's error state and dispatch `error` when the
   * value actually changes. The comparison is reference equality —
   * deliberate, not a bug:
   *
   *   - The main caller pattern is `_setError(null)` at `_connect()`
   *     start, then `_setError(err)` on failure. Reference equality
   *     of `null === null` suppresses the redundant "clear" event
   *     when the session starts from an already-clear state,
   *     without ever suppressing a real error→error transition
   *     (two different Error instances, even with the same
   *     message, compare unequal).
   *   - Conversely, "same Error instance set twice" genuinely is
   *     idempotent — not a legitimate case in current callers, but
   *     coalescing it keeps `auth0-session:error` from firing
   *     spurious duplicate payloads.
   */
  private _setError(value: Error | null): void {
    if (this._error === value) return;
    this._error = value;
    this.dispatchEvent(new CustomEvent("auth0-session:error", {
      detail: value,
      bubbles: true,
    }));
  }
}

