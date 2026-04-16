import type { ClientTransport } from "@wc-bindable/remote";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import type { RemoteCoreProxy } from "@wc-bindable/remote";
import type { WcBindableDeclaration, UnbindFn } from "@wc-bindable/core";
import { bind } from "@wc-bindable/core";
import { config } from "../config.js";
import { IWcBindable } from "../types.js";
import { getCoreDeclaration } from "../coreRegistry.js";
import type { Auth } from "./Auth.js";

/**
 * `<hawc-auth0-session>` — declarative remote session gate.
 *
 * Pairs with a `<hawc-auth0>` (referenced by `target` ID) and collapses
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
      { name: "ready",      event: "hawc-auth0-session:ready-changed" },
      { name: "connecting", event: "hawc-auth0-session:connecting-changed" },
      { name: "error",      event: "hawc-auth0-session:error" },
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

  /** Optional URL override. Falls back to the target `<hawc-auth0>`'s `remote-url`. */
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

  /** The `RemoteCoreProxy` once built. Applications bind to this directly. */
  get proxy(): RemoteCoreProxy | null {
    return this._proxy;
  }

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
      // Defer so sibling elements (notably the target `<hawc-auth0>`) can
      // finish upgrading before we resolve them by ID.
      this._connectedCallbackPromise = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          this._startWatching().finally(resolve);
        });
      });
    }
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
    this._setError(null);

    // Capture generation AFTER teardown so this run is the active one.
    // A subsequent teardown / start() will move it forward and the
    // generation guards below abort this run cleanly.
    const myGen = this._generation;

    const auth = this._resolveAuth();
    if (!auth) {
      this._setError(new Error(`[@wc-bindable/hawc-auth0] <hawc-auth0-session>: target "${this.target}" not found.`));
      return;
    }
    this._authEl = auth;

    const coreKey = this.core;
    if (!coreKey) {
      this._setError(new Error("[@wc-bindable/hawc-auth0] <hawc-auth0-session>: `core` attribute is required."));
      return;
    }
    const decl = getCoreDeclaration(coreKey);
    if (!decl) {
      this._setError(new Error(`[@wc-bindable/hawc-auth0] <hawc-auth0-session>: core "${coreKey}" is not registered. Call registerCoreDeclaration("${coreKey}", decl) first.`));
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
    auth.addEventListener("hawc-auth0:authenticated-changed", listener);

    if (auth.authenticated) {
      await this._connect();
    }
  }

  private _unsubscribeAuth(): void {
    if (this._authEl && this._authListener) {
      this._authEl.removeEventListener("hawc-auth0:authenticated-changed", this._authListener);
    }
    this._authListener = null;
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
    if (auth.connected) {
      this._setError(new Error(
        "[@wc-bindable/hawc-auth0] <hawc-auth0-session>: target is already connected. " +
        "Use either <hawc-auth0-session> OR a manual authEl.connect() — not both. " +
        "See SPEC-REMOTE §3.7 (Connection Ownership).",
      ));
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
        "[@wc-bindable/hawc-auth0] <hawc-auth0-session>: no WebSocket URL configured. " +
        "Set the `url` attribute on <hawc-auth0-session> or `remote-url` on the target <hawc-auth0>.",
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

      // Race guard: a teardown (logout, element removal) fired during the
      // handshake. The freshly opened WebSocket is owned by AuthShell —
      // if the teardown was triggered by logout, AuthShell already closed
      // it; if the element was merely removed while the user stayed
      // logged in, the socket is still authEl's to keep. Either way the
      // session must NOT install a proxy or flip `ready`.
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
    this.dispatchEvent(new CustomEvent("hawc-auth0-session:ready-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setConnecting(value: boolean): void {
    if (this._connecting === value) return;
    this._connecting = value;
    this.dispatchEvent(new CustomEvent("hawc-auth0-session:connecting-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setError(value: Error | null): void {
    if (this._error === value) return;
    this._error = value;
    this.dispatchEvent(new CustomEvent("hawc-auth0-session:error", {
      detail: value,
      bubbles: true,
    }));
  }
}

