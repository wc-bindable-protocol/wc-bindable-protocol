import { bind } from "@wc-bindable/core";
import type { UnbindFn } from "@wc-bindable/core";
import type { RemoteCoreProxy } from "@wc-bindable/remote";
import { deepCloneAndFreeze } from "../freeze.js";
import type { FlagMap, IWcBindable } from "../types.js";

const EMPTY_FLAGS: FlagMap = Object.freeze({});

/**
 * Element structurally matching `<auth0-session>`'s public surface.
 * Any element exposing `.proxy`, `.ready`, and the
 * `auth0-session:ready-changed` event works as a target — we do
 * not take a hard dependency on `@wc-bindable/auth0` so tests
 * (and future non-Auth0 session elements) can stand in their own
 * session-shaped host.
 */
interface SessionLike extends HTMLElement {
  readonly proxy: RemoteCoreProxy | null;
  readonly ready: boolean;
}

/**
 * `<feature-flags>` — declarative feature-flag observation shell.
 *
 * Subscribes to the flag-shaped bindable surface of a session element
 * (typically `<auth0-session>`) and re-dispatches those property
 * changes on itself so `data-wcs` can bind to a named DOM element
 * instead of a JS-only proxy. No transport, no flag evaluation —
 * every decision runs inside the server-side {@link FlagsCore}.
 *
 *   <auth0-gate id="auth" ... />
 *   <auth0-session target="auth" core="flags-core" id="auth-session" />
 *   <feature-flags
 *     target="auth-session"
 *     data-wcs="flags: currentFlags; identified: flagsReady">
 *   </feature-flags>
 *
 * Consumers read individual flags via `values.currentFlags.<flagKey>` —
 * the flag map is schema-less on the wire (see README §Schema-less design).
 */
export class Flags extends HTMLElement {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "flags",      event: "feature-flags:flags-changed" },
      { name: "identified", event: "feature-flags:identified-changed" },
      { name: "loading",    event: "feature-flags:loading-changed" },
      { name: "error",      event: "feature-flags:error" },
    ],
    commands: [
      { name: "identify", async: true },
      { name: "reload",   async: true },
    ],
  };

  static get observedAttributes(): string[] {
    return ["target"];
  }

  // Cached bindable state — published to the wcBindable surface.
  private _flags: FlagMap = EMPTY_FLAGS;
  private _identified = false;
  private _loading = false;
  private _error: Error | null = null;

  private _sessionEl: SessionLike | null = null;
  private _readyListener: ((e: Event) => void) | null = null;
  private _unbindProxy: UnbindFn | null = null;

  // Monotonic guard. Bumped whenever the subscription is torn down —
  // any resumed microtask from a prior attach sees a mismatched
  // generation and drops its work. Mirrors AuthSession's pattern.
  private _generation = 0;

  // Coalesce bursts of target attribute changes into a single re-attach.
  private _attrRestartScheduled = false;

  // Observer that rescues the "target element not yet in the DOM"
  // case — see `_waitForTarget()` for the rationale. `null` when no
  // rescue is pending (target resolved, or element detached).
  private _pendingTargetObserver: MutationObserver | null = null;
  // Polling timer paired with `_pendingTargetObserver`. Catches the
  // case where the target *element* already exists but its `.proxy`
  // / `.ready` are assigned imperatively later — property writes
  // are invisible to MutationObserver.
  private _pendingTargetPollTimer: ReturnType<typeof setInterval> | null = null;
  // Hard cap on the rescue lifetime so a misconfigured `target`
  // (pointing at an id that never arrives) does not keep a 200 ms
  // interval alive forever — 30 s is generous for any plausible
  // framework / SSR hydration cycle, yet short enough to bound
  // wasted CPU/battery on long-lived pages with many mis-targeted
  // `<feature-flags>` elements. Paired with `_pendingTargetPollTimer`.
  private _pendingTargetTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Attributes -----------------------------------------------------------

  get target(): string {
    return this.getAttribute("target") || "";
  }

  set target(value: string) {
    this.setAttribute("target", value);
  }

  // --- Bindable properties --------------------------------------------------

  get flags(): FlagMap {
    return this._flags;
  }

  get identified(): boolean {
    return this._identified;
  }

  get loading(): boolean {
    return this._loading;
  }

  get error(): Error | null {
    return this._error;
  }

  // --- Public imperative API ------------------------------------------------

  /**
   * Re-identify on the server. Delegates to the session proxy's
   * `identify` command. Rejects if no session / proxy is attached.
   */
  async identify(userId: string, attrs?: Record<string, unknown>): Promise<void> {
    const proxy = this._sessionEl?.proxy;
    if (!proxy) {
      throw new Error(
        "[@wc-bindable/flags] <feature-flags>: identify() called before a session proxy is attached. Wait for the target session's ready=true.",
      );
    }
    await proxy.invoke("identify", userId, attrs);
  }

  /**
   * Force a reload of the server-side flag snapshot bypassing any
   * provider-side cache.
   */
  async reload(): Promise<void> {
    const proxy = this._sessionEl?.proxy;
    if (!proxy) {
      throw new Error(
        "[@wc-bindable/flags] <feature-flags>: reload() called before a session proxy is attached. Wait for the target session's ready=true.",
      );
    }
    await proxy.invoke("reload");
  }

  // --- Lifecycle ------------------------------------------------------------

  connectedCallback(): void {
    this.style.display = "none";
    // Defer one microtask so sibling elements (notably the target
    // session) can finish upgrading before we resolve them by ID.
    queueMicrotask(() => {
      if (!this.isConnected) return;
      this._attach();
    });
  }

  disconnectedCallback(): void {
    this._detach();
  }

  attributeChangedCallback(
    _name: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (!this.isConnected) return;
    if (oldValue === newValue) return;
    if (this._attrRestartScheduled) return;
    this._attrRestartScheduled = true;
    queueMicrotask(() => {
      this._attrRestartScheduled = false;
      if (!this.isConnected) return;
      this._detach();
      this._attach();
    });
  }

  // --- Private --------------------------------------------------------------

  private _attach(): void {
    this._detach();
    const myGen = this._generation;

    const session = this._resolveSession();
    if (!session) {
      this._setError(new Error(
        `[@wc-bindable/flags] <feature-flags>: target "${this.target}" did not resolve to a session element exposing \`.proxy\`.`,
      ));
      // Rescue path: target may be late-bound (SSR hydration, async
      // mount, framework-ordered insertion). Observe the DOM and
      // retry resolution whenever nodes are added, self-disconnecting
      // the moment the target shows up or this element is torn down.
      this._waitForTarget(myGen);
      return;
    }
    this._sessionEl = session;
    this._setError(null);

    // Subscribe to future ready transitions so we pick up the proxy
    // the moment it is built. `true` → bind to proxy; `false` → drop
    // subscription but keep the last known flag map (matches the
    // "initial value is not cleared on a dropped transport" contract).
    const listener = (e: Event): void => {
      /* v8 ignore start -- _detach removes this listener before bumping generation, so a stale myGen cannot be observed here */
      if (this._generation !== myGen) return;
      /* v8 ignore stop */
      const next = (e as CustomEvent).detail;
      if (next === true) {
        this._bindToProxy();
      } else if (next === false) {
        this._unbindFromProxy();
      }
    };
    this._readyListener = listener;
    session.addEventListener("auth0-session:ready-changed", listener);

    // Catch the case where the session was already ready by the time
    // we attached — no future `ready-changed: true` will fire.
    if (session.ready) {
      this._bindToProxy();
    }
  }

  private _bindToProxy(): void {
    const session = this._sessionEl;
    /* v8 ignore start -- defensive: _bindToProxy is only reached after _attach sets _sessionEl */
    if (!session) return;
    /* v8 ignore stop */
    const proxy = session.proxy;
    if (!proxy) return;

    // Already bound (e.g. a redundant ready→ready event). Avoid
    // double-subscribing, which would cause every proxy update to
    // fire twice on this element.
    if (this._unbindProxy) return;

    this._unbindProxy = bind(proxy, (name, value) => {
      switch (name) {
        case "flags":
          this._setFlags(_asFlagMap(value));
          break;
        case "identified":
          this._setIdentified(value === true);
          break;
        case "loading":
          this._setLoading(value === true);
          break;
        case "error":
          this._setError(_asErrorOrNull(value));
          break;
        default:
          // Silently ignore unknown properties — forward compatibility
          // for future FlagsCore surface extensions.
          break;
      }
    });
  }

  private _unbindFromProxy(): void {
    if (this._unbindProxy) {
      this._unbindProxy();
      this._unbindProxy = null;
    }
  }

  private _detach(): void {
    this._generation++;
    this._unbindFromProxy();
    if (this._sessionEl && this._readyListener) {
      this._sessionEl.removeEventListener("auth0-session:ready-changed", this._readyListener);
    }
    this._readyListener = null;
    this._sessionEl = null;
    this._stopWaitingForTarget();
  }

  private _stopWaitingForTarget(): void {
    if (this._pendingTargetObserver) {
      this._pendingTargetObserver.disconnect();
      this._pendingTargetObserver = null;
    }
    if (this._pendingTargetPollTimer) {
      clearInterval(this._pendingTargetPollTimer);
      this._pendingTargetPollTimer = null;
    }
    if (this._pendingTargetTimeoutTimer) {
      clearTimeout(this._pendingTargetTimeoutTimer);
      this._pendingTargetTimeoutTimer = null;
    }
  }

  /**
   * Rescue for target-resolution failures at attach time. Re-runs
   * {@link _resolveSession} on two complementary triggers:
   *
   * 1. **MutationObserver** (DOM tree changes). Catches element
   *    insertion and `id` attribute retargeting — fast and event-
   *    driven.
   * 2. **setInterval fallback** (property-level changes). Catches
   *    the case where the target element EXISTS in the DOM but its
   *    `.proxy` / `.ready` properties are assigned imperatively
   *    afterwards (custom-element upgrade firing a constructor that
   *    sets the getters, or an SDK that grafts the session surface
   *    onto a plain element). Property writes are invisible to
   *    MutationObserver, so only a timer can observe them.
   *
   * Both triggers share a single `_tryResolve` path and tear down in
   * one shot as soon as the target resolves, or — through
   * `_detach()` — when this element is detached, its target
   * attribute changes, or a later `_attach()` cycle supersedes this
   * one. Without this rescue, a framework that mounts `<feature-flags>`
   * before its session target (or before the session's property
   * upgrade) is fatal: the initial resolve failure sets `error` and
   * the element stays stuck at `flags={}` forever.
   */
  private _waitForTarget(myGen: number): void {
    // No DOM to observe — bail. This keeps SSR / Node usage (where
    // `document` exists under happy-dom but may not have a `body`)
    // from throwing. Consumers in a live browser always have body.
    const root = document.body;
    /* v8 ignore start -- happy-dom and real browsers always expose a <body> on a connected element; guard is defensive */
    if (!root) return;
    /* v8 ignore stop */

    const tryResolve = (): void => {
      /* v8 ignore start -- `_detach` tears down both triggers before bumping `_generation` or after `disconnectedCallback` fires; a stale callback can only land if a dispatch raced past the teardown, which is not deterministically reproducible in tests */
      if (this._generation !== myGen) {
        this._stopWaitingForTarget();
        return;
      }
      if (!this.isConnected) {
        this._stopWaitingForTarget();
        return;
      }
      /* v8 ignore stop */
      const session = this._resolveSession();
      if (!session) return;  // keep waiting
      this._stopWaitingForTarget();
      // Clear the "did not resolve" error before the re-attach so
      // consumers see `error: null` synchronously with the attach.
      this._setError(null);
      this._attach();
    };

    const observer = new MutationObserver(tryResolve);
    // `attributes` + filter on `id` catches the case where an
    // already-present element gains the matching id later (e.g. an
    // SDK bootstraps a container and only then brands it with the
    // expected id).
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["id"],
    });
    this._pendingTargetObserver = observer;

    // 200 ms poll covers property-level upgrades (assignments /
    // custom-element upgrades). Fast enough that a user's first
    // render tick catches the upgrade, low enough that an indefinite
    // miss is negligible cost. `.unref()` on platforms that support
    // it (Node) so a lingering rescue does not keep the process
    // alive past the intended exit.
    const poll = setInterval(tryResolve, 200);
    const t = poll as unknown as { unref?: () => void };
    /* v8 ignore start -- `unref` is a Node-only extension; happy-dom / real browsers do not expose it */
    if (typeof t.unref === "function") t.unref();
    /* v8 ignore stop */
    this._pendingTargetPollTimer = poll;

    // Hard cap the rescue: if `target` is pointed at an id that never
    // arrives, we refuse to keep polling forever. 30 s is well past
    // any plausible framework / SSR hydration cycle — a target that
    // hasn't shown up by then is a configuration error, not a timing
    // race. Tears down both triggers so CPU/battery stay bounded on
    // long-lived pages with many mis-targeted elements.
    const timeout = setTimeout(() => {
      /* v8 ignore start -- defensive: _stopWaitingForTarget clears this timer before generation can drift, so a stale myGen here is not deterministically reachable */
      if (this._generation !== myGen) return;
      /* v8 ignore stop */
      this._stopWaitingForTarget();
    }, 30_000);
    const tt = timeout as unknown as { unref?: () => void };
    /* v8 ignore start -- `unref` is a Node-only extension; happy-dom / real browsers do not expose it */
    if (typeof tt.unref === "function") tt.unref();
    /* v8 ignore stop */
    this._pendingTargetTimeoutTimer = timeout;
  }

  private _resolveSession(): SessionLike | null {
    const id = this.target;
    if (!id) return null;
    const el = document.getElementById(id);
    if (!el) return null;
    // Structural check: requires `.proxy` / `.ready`. We don't gate
    // on tag name so alternative session implementations can plug in.
    if (!("proxy" in el) || !("ready" in el)) return null;
    return el as SessionLike;
  }

  // --- State setters --------------------------------------------------------

  private _setFlags(next: FlagMap): void {
    // Flags are re-dispatched on every push from the proxy — NOT
    // deduped like `identified` / `loading`. Rationale:
    //   1. The upstream `FlagsCore` already dedupes via its own
    //      change-detection (providers only push when content
    //      actually differs), so the proxy does not deliver spurious
    //      duplicates in practice.
    //   2. Doing a content-level dedupe here would require stable
    //      serialization on the hot path — the cost dwarfs the
    //      (usually nil) saved downstream work.
    //   3. A missed dispatch is strictly worse than a redundant one:
    //      consumers binding through `data-wcs` tolerate a redundant
    //      assignment gracefully, but a silently dropped update is
    //      a bug that only surfaces in the rare case where two
    //      upstream snapshots happen to be ref-equal.
    this._flags = next;
    this.dispatchEvent(new CustomEvent("feature-flags:flags-changed", {
      detail: next,
      bubbles: true,
    }));
  }

  private _setIdentified(value: boolean): void {
    if (this._identified === value) return;
    this._identified = value;
    this.dispatchEvent(new CustomEvent("feature-flags:identified-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setLoading(value: boolean): void {
    if (this._loading === value) return;
    this._loading = value;
    this.dispatchEvent(new CustomEvent("feature-flags:loading-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setError(value: Error | null): void {
    // Dedupe only the null → null case. A non-null error is always
    // re-dispatched — a distinct failure must stay observable even
    // when it happens to === a prior by reference (the pathological
    // but test-asserted case).
    if (value === null && this._error === null) return;
    this._error = value;
    this.dispatchEvent(new CustomEvent("feature-flags:error", {
      detail: value,
      bubbles: true,
    }));
  }
}

function _asFlagMap(value: unknown): FlagMap {
  if (value && typeof value === "object") {
    // Deep-freeze so consumers cannot mutate nested flag values (e.g.
    // Flagsmith's `{ enabled, value }` objects) via `values.flags.x.enabled = true`.
    // Remote-mode delivers deserialized fresh objects, so cloning does
    // not contend with any upstream owner — the Core and the wire each
    // own their own copies.
    return deepCloneAndFreeze(value as FlagMap);
  }
  return EMPTY_FLAGS;
}

function _asErrorOrNull(value: unknown): Error | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Error) return value;
  // Remote errors are revived into plain `Error` by RemoteCoreProxy,
  // but a user-code provider might dispatch a non-Error value. Wrap
  // for a consistent observable contract.
  return new Error(typeof value === "string" ? value : String(value));
}
