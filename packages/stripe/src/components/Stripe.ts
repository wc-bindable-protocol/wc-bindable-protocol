import { getConfig, getRemoteCoreUrl } from "../config.js";
import {
  IWcBindable, StripeStatus, StripeAmount, StripePaymentMethod, StripeError,
  StripeMode, IntentCreationResult, ConfirmationReport, IntentRequestHint,
  UnknownStatusDetail,
} from "../types.js";
// `StripeCore` itself is a node-only module (imports `node:crypto`). We only
// need the TYPE here — `_core: StripeCore | null`, `attachLocalCore(core:
// StripeCore)` — so `import type` keeps the Shell's browser module graph
// from transitively pulling `StripeCore.ts` at module-evaluation time.
// Runtime references go through `STRIPE_CORE_WC_BINDABLE` imported below.
import type { StripeCore } from "../core/StripeCore.js";
import { STRIPE_CORE_WC_BINDABLE } from "../core/wcBindable.js";
import { extractCardPaymentMethod } from "../internal/paymentMethodShape.js";
import { raiseError } from "../raiseError.js";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
  type ClientTransport,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";

/**
 * Minimal structural subset of `@stripe/stripe-js`'s `Stripe` / `Elements`
 * surface. Typed here rather than imported so `@stripe/stripe-js` stays a
 * truly-optional peer dependency and tests can inject a mock loader.
 */
export interface StripeJsLike {
  elements(opts: { clientSecret: string; appearance?: Record<string, unknown> }): StripeElementsLike;
  confirmPayment(opts: {
    elements: StripeElementsLike;
    clientSecret?: string;
    confirmParams?: { return_url?: string };
    redirect?: "always" | "if_required";
  }): Promise<{ paymentIntent?: Record<string, unknown>; error?: Record<string, unknown> }>;
  confirmSetup(opts: {
    elements: StripeElementsLike;
    clientSecret?: string;
    confirmParams?: { return_url?: string };
    redirect?: "always" | "if_required";
  }): Promise<{ setupIntent?: Record<string, unknown>; error?: Record<string, unknown> }>;
  retrievePaymentIntent(clientSecret: string): Promise<{ paymentIntent?: Record<string, unknown>; error?: Record<string, unknown> }>;
  retrieveSetupIntent(clientSecret: string): Promise<{ setupIntent?: Record<string, unknown>; error?: Record<string, unknown> }>;
}

export interface StripeElementsLike {
  create(type: "payment", opts?: Record<string, unknown>): StripePaymentElementLike;
  getElement(type: "payment"): StripePaymentElementLike | null;
}

export interface StripePaymentElementLike {
  mount(target: HTMLElement | string): void;
  unmount(): void;
  destroy(): void;
  on(event: "ready" | "change", cb: (ev: Record<string, unknown>) => void): void;
}

/**
 * Loader signature — implementations take the publishable key and return
 * a Stripe.js instance. The default loader lazy-imports `@stripe/stripe-js`
 * but apps (and tests) can inject their own via `Stripe.setLoader`.
 */
export type StripeJsLoader = (publishableKey: string) => Promise<StripeJsLike>;

/**
 * Node-safe `HTMLElement` base. The `<stripe-checkout>` Shell is a browser
 * component — under a browser (and under jsdom in tests) this resolves to
 * the real `HTMLElement` constructor and behavior is unchanged. In plain
 * Node (SSR frameworks, test pre-scanners, tooling that walks module graphs
 * through the browser barrel), `HTMLElement` is undefined and the raw
 * `class X extends HTMLElement` form crashes at module-evaluation time with
 * `ReferenceError: HTMLElement is not defined`. Swapping in an empty class
 * on that path lets the module evaluate without error; `customElements` is
 * also absent in plain Node, so the class still cannot actually be used as
 * a DOM custom element — the fallback only keeps `import` from exploding,
 * it does not pretend the component works on the server. The `/server`
 * subpath remains the supported Node-side entry.
 */
const HTMLElementCtor: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

/**
 * Browser shell for `<stripe-checkout>`. Mounts Stripe's Payment Element in a
 * slot inside this component, drives the confirmation flow, and reports
 * outcomes back to the Core over the wc-bindable wire.
 *
 * The card payload never crosses this component's JS. Elements renders an
 * iframe that talks directly to Stripe — our code handles only the
 * clientSecret (in memory, never observable) and the non-sensitive result
 * (paymentMethod id + brand + last4).
 */
export class Stripe extends HTMLElementCtor {
  /**
   * Upper bound on the sanitized `message` length that reaches the DOM.
   * Mirrors `StripeCore._MAX_ERROR_MESSAGE_LENGTH` so a
   * Stripe.js-originated error and a Core-sanitized error cannot diverge
   * in permitted size on the Shell surface.
   */
  private static readonly _MAX_ERROR_MESSAGE_LENGTH: number = 512;

  /**
   * Default Stripe.js loader. Captured as a frozen reference so
   * `resetLoader()` can restore it after a `setLoader()` override without
   * the caller having to cache the original themselves.
   */
  private static readonly _DEFAULT_LOADER: StripeJsLoader = async (key: string) => {
    // @ts-ignore — @stripe/stripe-js is an optional peer dep.
    const mod = await import("@stripe/stripe-js");
    const loadStripe = (mod as { loadStripe?: (k: string) => Promise<unknown> }).loadStripe;
    if (!loadStripe) {
      raiseError("@stripe/stripe-js has no loadStripe export.");
    }
    const s = await loadStripe(key);
    if (!s) {
      raiseError("loadStripe returned null (blocked / offline / invalid key).");
    }
    return s as StripeJsLike;
  };

  /**
   * Shared Stripe.js loader. Swapped in tests via `Stripe.setLoader(mock)`.
   * Default path lazy-imports `@stripe/stripe-js` so the peer dep only
   * resolves at first use — apps that never hit the browser Shell (server-
   * only consumers) never need it installed.
   */
  private static _loader: StripeJsLoader = Stripe._DEFAULT_LOADER;

  /**
   * Override the Stripe.js loader. Primary use: tests inject a mock that
   * never actually hits Stripe. Also a fallback for apps bundling their own
   * `@stripe/stripe-js` under an alias.
   *
   * Global static state: the override applies to EVERY `<stripe-checkout>`
   * element in the same module realm. Test suites that run side-by-side
   * (vitest file-isolation boundaries, parallel describe blocks) MUST
   * call `resetLoader()` in `afterEach` / teardown to prevent cross-test
   * leakage — a mock installed by test A can otherwise be observed by
   * test B's `<stripe-checkout>` if B forgot to override.
   */
  static setLoader(loader: StripeJsLoader): void {
    Stripe._loader = loader;
  }

  /**
   * Restore the default Stripe.js loader. Intended for test teardown;
   * apps in production rarely need to call this. Complements `setLoader`.
   *
   * Returning to the default is idempotent — calling `resetLoader()`
   * twice is a no-op.
   */
  static resetLoader(): void {
    Stripe._loader = Stripe._DEFAULT_LOADER;
  }

  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    // Deep-copy each descriptor object (not just the outer array) so a caller
    // that mutates `Stripe.wcBindable.properties[0].event = "x"` via an `as
    // any` cast cannot also mutate `STRIPE_CORE_WC_BINDABLE.properties[0]`
    // and thereby rewrite the Core's event contract for every consumer. The
    // array-level spread alone kept element identity shared, leaving that
    // hole open; the element-level spread closes it. TypeScript `readonly`
    // is only a compile-time guard.
    properties: [
      ...STRIPE_CORE_WC_BINDABLE.properties.map(p => ({ ...p })),
      { name: "trigger", event: "stripe-checkout:trigger-changed" },
    ],
    // Same rationale as `properties` above — copy each input descriptor so
    // field-level mutation on `Stripe.wcBindable.inputs[i]` does not leak
    // through to the Core's descriptor. Array spread alone (the old shape)
    // only guarded against push/splice on the container.
    inputs: STRIPE_CORE_WC_BINDABLE.inputs
      ? STRIPE_CORE_WC_BINDABLE.inputs.map(i => ({ ...i }))
      : undefined,
    // Deliberately NOT forwarding the Core's full command surface. Only the
    // four orchestration methods the Shell itself implements publicly:
    // `prepare()` (create intent + mount Elements), `submit()` (confirm),
    // `reset()`, `abort()`. The Core's internal RPCs (`requestIntent`,
    // `reportConfirmation`, `cancelIntent`, `resumeIntent`) must not be
    // invoked from outside the Shell — doing so bypasses the Elements
    // lifecycle and leaves observable state inconsistent. Same pattern
    // s3-uploader and ai-agent use.
    commands: [
      { name: "prepare", async: true },
      { name: "submit", async: true },
      { name: "reset" },
      { name: "abort", async: true },
    ],
  };

  static get observedAttributes(): string[] {
    // `return-url` intentionally absent — it is read inside `submit()`
    // (`this.returnUrl`), never synced to Core or cached on change, so
    // observing it would just pay the mutation-tick cost for a no-op
    // branch.
    return ["mode", "amount-value", "amount-currency", "customer-id", "publishable-key"];
  }

  private _core: StripeCore | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _remoteValues: Record<string, unknown> = {};
  private _unbind: (() => void) | null = null;
  private _ws: WebSocket | null = null;
  private _trigger: boolean = false;
  private _errorState: StripeError | null = null;
  private _hasLocalError: boolean = false;
  /**
   * Monotonic counter for `error` updates received over the remote wire.
   * Pairs with `_localErrorSeqSync` so `_setErrorStateFromUnknown` can tell
   * "the Core just published this same failure as a richer error update"
   * (seq advanced) from "there is a stale remote error, but my current
   * rejection is unrelated and proxy-side" (seq unchanged).
   */
  private _remoteErrorSeq: number = 0;
  private _localErrorSeqSync: number = 0;

  /**
   * Stripe.js instance + the Elements group scoped to the active intent.
   * Re-created on every `requestIntent` success because Elements needs the
   * fresh clientSecret baked in at `stripe.elements({ clientSecret })` time.
   */
  private _stripeJs: StripeJsLike | null = null;
  /**
   * Publishable key the cached `_stripeJs` was initialized with. Tracked
   * so `publishable-key` attribute changes can invalidate a stale cache —
   * a `pk_A`-bound Stripe.js instance must NEVER be reused once the
   * element is reconfigured to `pk_B`, since the two keys likely point
   * at different Stripe accounts/environments and reuse would route
   * payment method submissions to the wrong account.
   */
  private _stripeJsKey: string = "";
  private _elements: StripeElementsLike | null = null;
  private _paymentElement: StripePaymentElementLike | null = null;
  /**
   * The clientSecret for the active intent. Stored on the Shell instance
   * only — never surfaced through `this.clientSecret`, never reflected to an
   * attribute, never included in any dispatched CustomEvent detail. The
   * only sinks are: `stripe.elements({ clientSecret })` at mount time and
   * `stripe.retrievePaymentIntent(clientSecret)` after the 3DS redirect
   * return (SPEC §5.2 non-exposure invariant).
   */
  private _clientSecret: string = "";
  /** Appearance API payload (SetonProperty only; no attribute mirror). */
  private _appearance: Record<string, unknown> | undefined = undefined;
  /** Slot host element the payment Element mounts into. */
  private _mountHost: HTMLDivElement | null = null;
  /**
   * In-flight `prepare()` promise. Returned to concurrent callers so the
   * intent-create + Elements-mount pipeline runs exactly once even when
   * `submit()`, an auto-prepare hook, and a manual `prepare()` race on
   * connect. Cleared whether the promise fulfills or rejects — a failed
   * prepare should not wedge the element; the next call retries.
   */
  private _preparePromise: Promise<void> | null = null;
  /**
   * Dedupe guard for `submit()`. A double-click (or two sources calling
   * submit back-to-back) must not fire two `confirmPayment` calls for
   * the same intent — doing so lets the later result overwrite the
   * earlier one even though the Core only accepts one decisive outcome
   * per intent generation. Subsequent calls while a submit is in flight
   * return the same promise.
   */
  private _submitPromise: Promise<void> | null = null;
  /**
   * Monotonic counter bumped by any invalidation path that must stop an
   * in-flight `prepare()` — `_invalidateForKeyChange`, `reset()`,
   * `abort()`, `disconnectedCallback()`. Each `prepare()` snapshots it
   * at start and checks after every await — if the value advanced
   * mid-flight, the prepare has been superseded and must not proceed
   * to mount Elements / commit `_preparedMode`.
   */
  private _prepareGeneration: number = 0;
  /**
   * Classifies the most recent `_prepareGeneration` bump.
   *
   * - `false`: caused by `_invalidateForKeyChange`. The config changed
   *   but the element is still supposed to render — the prepare cleanup
   *   auto-retries so the new config converges.
   * - `true`:  caused by `reset()` / `abort()` / `disconnectedCallback()`.
   *   The user asked for terminal idle (or the element was removed) —
   *   auto-retry would silently undo that request. Cleanup MUST NOT
   *   re-fire `_maybeAutoPrepare`.
   *
   * Only read inside the prepare cleanup. Each invalidation sets the
   * flag fresh, so stickiness between unrelated supersedes is harmless.
   */
  private _supersedeIsUserAbort: boolean = false;
  /**
   * Set true while `_resumeFromRedirect` is running. Prevents the auto-
   * prepare path from racing against resume and creating a second intent
   * alongside the one Stripe already charged on the prior page load.
   */
  private _resuming: boolean = false;
  /**
   * Set once a resume has run to terminal (successful `_coreResume` OR a
   * swallowed error) on this element instance. Prevents re-resume when
   * `attachLocalCore` is called after `_connectRemote` or vice versa.
   */
  private _resumed: boolean = false;
  /**
   * Mode ("payment" | "setup") captured at prepare() success. submit()
   * uses this — NOT `this.mode` — to pick confirmPayment vs confirmSetup.
   * This keeps the confirm call aligned with the intent that was actually
   * created server-side, even if the `mode` attribute is flipped between
   * prepare() and submit(). A mode switch after prepare is a user error
   * that requires an explicit `reset()` + re-prepare, surfaced via the
   * `stripe-checkout:stale-config` event.
   */
  private _preparedMode: StripeMode | null = null;
  /** Intent id returned by the prepare-time requestIntent call. */
  private _preparedIntentId: string | null = null;
  /**
   * Latched flag so the `stripe-checkout:missing-return-url-warning` event
   * fires at most once per prepare lifecycle (cleared in
   * `_teardownElements`). Prevents a click-heavy checkout flow from
   * drowning listeners in repeat warnings.
   */
  private _warnedMissingReturnUrl: boolean = false;

  private get _isRemote(): boolean {
    return this._proxy !== null;
  }

  constructor() {
    super();
  }

  // --- Remote wiring ---

  private _initRemote(): void {
    const url = getRemoteCoreUrl();
    if (!url) {
      raiseError("remote.enableRemote is true but remoteCoreUrl is empty. Set remote.remoteCoreUrl or STRIPE_REMOTE_CORE_URL.");
    }
    const ws = new WebSocket(url);
    this._ws = ws;
    let opened = false;
    let failed = false;
    ws.addEventListener("open", () => { opened = true; }, { once: true });
    const onFail = (): void => {
      if (failed) return;
      failed = true;
      if (this._ws !== ws) return;
      this._setErrorState({
        code: "transport_unavailable",
        message: `WebSocket connection ${opened ? "lost" : "failed"}: ${url}`,
      });
      this._resetRemoteBusyState();
      this._disposeRemote();
    };
    ws.addEventListener("error", onFail, { once: true });
    ws.addEventListener("close", onFail, { once: true });
    const transport = new WebSocketClientTransport(ws);
    this._connectRemote(transport);
  }

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
    // Reset the remote-error seq pairing so a subsequent `_connectRemote`
    // does not carry a stale delta from the prior session.
    this._remoteErrorSeq = 0;
    this._localErrorSeqSync = 0;
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Graceful teardown for a remote-bound session.
   *
   * Order matters:
   * 1) capture current handles,
   * 2) synchronously detach instance fields so rapid re-connect can boot
   *    a fresh session,
   * 3) asynchronously wait any in-flight prepare, then issue reset,
   *    unbind, dispose, close.
   *
   * Known trade-off: if disconnect happens while requestIntent is in
   * flight and the intent is created before reset lands, the intent may
   * survive as `requires_payment_method` until Stripe natural expiry.
   * This has no financial impact because nothing was confirmed. Apps that
   * require deterministic cancel should prefer `await el.abort()` before
   * removing the element.
   */
  private _disposeRemoteWithBestEffortReset(): void {
    const unbind = this._unbind;
    const proxy = this._proxy;
    const ws = this._ws;
    const preparePromise = this._preparePromise;
    const orphanIdAtEntry = typeof this._remoteValues.intentId === "string"
      ? this._remoteValues.intentId
      : undefined;

    // Detach local state immediately so a rapid re-connect can establish
    // a fresh remote session without waiting on network teardown.
    this._unbind = null;
    this._proxy = null;
    this._remoteValues = {};
    this._remoteErrorSeq = 0;
    this._localErrorSeqSync = 0;
    this._ws = null;

    // Observability helper. The element is about to be DOM-detached, so
    // dispatching on `this` only reaches listeners that were attached
    // directly via `el.addEventListener(...)` — but that is exactly the
    // surface a debugger / test can grab, which is what this event is
    // for. Silent failures in this cleanup block are otherwise invisible.
    const reportFailure = (phase: string, error: unknown): void => {
      this.dispatchEvent(new CustomEvent("stripe-checkout:dispose-warning", {
        detail: { phase, error },
        bubbles: true,
      }));
    };

    void (async () => {
      if (preparePromise) {
        await preparePromise.catch(() => { /* supersede / prior failure */ });
      }

      // Best-effort orphan cleanup for the disconnect path where an
      // already-known intent id exists at teardown entry.
      if (orphanIdAtEntry && proxy) {
        await proxy.invokeWithOptions("cancelIntent", [orphanIdAtEntry], { timeoutMs: 0 })
          .catch((e: unknown) => { reportFailure("cancelIntent", e); });
      }

      await proxy?.invoke("reset").catch((e: unknown) => { reportFailure("reset", e); });
      if (unbind) {
        try { unbind(); } catch (e) { reportFailure("unbind", e); }
      }
      if (proxy) {
        try { proxy.dispose(); } catch (e) { reportFailure("proxy.dispose", e); }
      }
      if (ws) {
        try { ws.close(); } catch (e) { reportFailure("ws.close", e); }
      }
    })();
  }

  private _resetRemoteBusyState(): void {
    if (this._remoteValues.loading) {
      this._remoteValues.loading = false;
      this.dispatchEvent(new CustomEvent("stripe-checkout:loading-changed", { detail: false, bubbles: true }));
    }
    if (this._remoteValues.status && this._remoteValues.status !== "idle") {
      this._remoteValues.status = "idle";
      this.dispatchEvent(new CustomEvent("stripe-checkout:status-changed", { detail: "idle", bubbles: true }));
    }
    // Also transition the card / amount / intent surface to null and
    // notify subscribers. The getters already report null once
    // `_disposeRemote` empties `_remoteValues`, but UIs wired on
    // `-changed` events need an explicit null dispatch — otherwise
    // "last card" / "last total" stays painted after disconnect and
    // can be confused for a current charge.
    if (this._remoteValues.intentId != null) {
      this._remoteValues.intentId = null;
      this.dispatchEvent(new CustomEvent("stripe-checkout:intentId-changed", { detail: null, bubbles: true }));
    }
    if (this._remoteValues.amount != null) {
      this._remoteValues.amount = null;
      this.dispatchEvent(new CustomEvent("stripe-checkout:amount-changed", { detail: null, bubbles: true }));
    }
    if (this._remoteValues.paymentMethod != null) {
      this._remoteValues.paymentMethod = null;
      this.dispatchEvent(new CustomEvent("stripe-checkout:paymentMethod-changed", { detail: null, bubbles: true }));
    }
  }

  private _setErrorState(err: StripeError): void {
    this._errorState = err;
    this._hasLocalError = true;
    // Snapshot the remote error-update counter at the moment we take
    // ownership locally. A subsequent remote `error` update will bump
    // `_remoteErrorSeq` past this snapshot; the delta is how
    // `_setErrorStateFromUnknown` decides whether a truthy
    // `_remoteValues.error` is fresh-enough to defer to or stale from a
    // prior unrelated failure.
    this._localErrorSeqSync = this._remoteErrorSeq;
    this.dispatchEvent(new CustomEvent("stripe-checkout:error", { detail: err, bubbles: true }));
  }

  private _clearErrorState(): void {
    if (!this._hasLocalError) return;
    this._hasLocalError = false;
    this._errorState = null;
    // `detail` uses `this.error` (not `null`) intentionally. In remote
    // mode, clearing the LOCAL error layer may still leave a Core-
    // authoritative `error` on `_remoteValues.error`; dispatching `null`
    // here would mislead listeners into thinking the Core has gone clean
    // when it has not. Other `-changed` setters dispatch the new value
    // directly because they own the single source of truth; this setter
    // is asymmetric because error has two layers (local / remote).
    this.dispatchEvent(new CustomEvent("stripe-checkout:error", { detail: this.error, bubbles: true }));
  }

  /** @internal — visible for testing */
  _connectRemote(transport: ClientTransport): void {
    this._proxy = createRemoteCoreProxy(STRIPE_CORE_WC_BINDABLE, transport);
    this._unbind = bind(this._proxy, (name, value) => {
      this._remoteValues[name] = value;
      if (name === "error") {
        // Bump on every error update (even null) so
        // `_setErrorStateFromUnknown` can pair a subsequent cmd-throw
        // with its Core-originated publish.
        this._remoteErrorSeq++;
        // A truthy remote error supersedes any stale local state — the
        // Core has asserted authority. A null publish leaves local
        // alone so a pre-connect transport-level error (set before the
        // first sync arrived) is not silently cleared by an initial
        // `error: null` sync.
        if (value) {
          this._hasLocalError = false;
          this._errorState = null;
        }
      }
      const prop = Stripe.wcBindable.properties.find(p => p.name === name);
      if (prop) {
        this.dispatchEvent(new CustomEvent(prop.event, { detail: value, bubbles: true }));
      }
    });
    // Sync declarative inputs up to the Core. Same gating as s3-uploader:
    // `hasAttribute` (not truthiness) so an explicit empty string
    // overrides any server-seeded default.
    if (this.hasAttribute("mode")) {
      this._proxy!.setWithAck("mode", this.mode).catch((e: unknown) => this._setErrorStateFromUnknown(e));
    }
    if (this.hasAttribute("amount-value")) {
      const v = this.amountValue;
      this._proxy!.setWithAck("amountValue", v).catch((e: unknown) => this._setErrorStateFromUnknown(e));
    }
    if (this.hasAttribute("amount-currency")) {
      this._proxy!.setWithAck("amountCurrency", this.amountCurrency).catch((e: unknown) => this._setErrorStateFromUnknown(e));
    }
    if (this.hasAttribute("customer-id")) {
      this._proxy!.setWithAck("customerId", this.customerId).catch((e: unknown) => this._setErrorStateFromUnknown(e));
    }
    // Symmetric with `attachLocalCore`: the Core (via proxy) is now
    // available, so a post-redirect resume that was deferred in
    // connectedCallback can run.
    void this._resumeFromRedirect();
    this._maybeAutoPrepare();
  }

  private _setErrorStateFromUnknown(e: unknown): void {
    // In remote mode, a cmd/setWithAck rejection typically travels
    // alongside an `error` property update the Core dispatches before
    // (re-)throwing. The update carries the full sanitized `StripeError`
    // (`code`, `declineCode`, `type`, `message`) while the cmd-throw is
    // serialized through RemoteCoreProxy's error serializer which only
    // preserves `name`/`message`/`stack`. Overwriting with the sparse
    // local copy would mask the richer Core-authoritative error.
    //
    // Defer ONLY when the truthy remote error is for *this same failure*
    // — i.e. `_remoteErrorSeq` has advanced since the last local set.
    // Otherwise the rejection is a pure proxy-side failure (transport
    // send throw, invoke timeout) whose error never reached the Core, and
    // the existing `_remoteValues.error` is stale from an earlier
    // unrelated Core rejection. In that case fall through to the local
    // path so the user sees the current failure.
    if (this._isRemote) {
      const remote = this._remoteValues.error as StripeError | null | undefined;
      if (remote && this._remoteErrorSeq > this._localErrorSeqSync) {
        // Consume the freshness so a follow-up proxy-side failure with
        // no new remote publish surfaces locally instead of deferring
        // to this now-stale value.
        this._localErrorSeqSync = this._remoteErrorSeq;
        return;
      }
    }
    if (e && typeof e === "object") {
      const rec = e as Record<string, unknown>;
      // Dual-name check is intentional: rejections reaching this path can
      // come from two sources with different casing conventions.
      //   1. Wire-originated (RemoteCoreProxy): the Core emits `StripeError`
      //      with camelCase `declineCode` (already sanitized from
      //      `decline_code`). Prefer that shape first.
      //   2. Stripe.js-originated (rare — most Stripe.js errors flow through
      //      `_sanitizeStripeJsError` at the confirm path, not here):
      //      Stripe.js uses snake_case `decline_code`. Fall back to that
      //      when the camelCase slot is empty.
      // `_sanitizeStripeJsError` only checks `decline_code` because its
      // input is known to be a Stripe.js shape; this function handles the
      // union of both origins and therefore must check both names.
      const declineCode = typeof rec.declineCode === "string"
        ? rec.declineCode
        : (typeof rec.decline_code === "string" ? rec.decline_code : undefined);
      const rawMessage = typeof rec.message === "string" ? rec.message : "Unknown error.";
      this._setErrorState({
        code: typeof rec.code === "string" ? rec.code : undefined,
        declineCode,
        type: typeof rec.type === "string" ? rec.type : undefined,
        // Length-cap the message here too so a proxy-serialized error that
        // bypasses `_sanitizeStripeJsError` / Core's `_sanitizeError` still
        // hits the DOM under the same bound. Mirrors the policy in both
        // the Shell and Core sanitizers.
        message: rawMessage.length > Stripe._MAX_ERROR_MESSAGE_LENGTH
          ? rawMessage.slice(0, Stripe._MAX_ERROR_MESSAGE_LENGTH - 1) + "…"
          : rawMessage,
      });
    } else {
      const raw = String(e);
      this._setErrorState({
        message: raw.length > Stripe._MAX_ERROR_MESSAGE_LENGTH
          ? raw.slice(0, Stripe._MAX_ERROR_MESSAGE_LENGTH - 1) + "…"
          : raw,
      });
    }
  }

  /** @internal — tests / advanced setups to inject a local Core */
  attachLocalCore(core: StripeCore): void {
    // Re-attaching to the SAME core is a harmless no-op (tests / HMR).
    // Swapping to a DIFFERENT core silently strands the prior one:
    // registered webhook handlers on the old Core keep firing, but this
    // Shell no longer observes any of them, and in-flight intents on the
    // old Core are invisible. Either reset the prior Core first or pass
    // the same instance — both require an explicit user action.
    if (this._core && this._core !== core) {
      raiseError(
        "attachLocalCore called with a different core instance; reset() the prior core and detach before re-attaching.",
      );
    }
    this._core = core;
    if (this.hasAttribute("mode")) core.mode = this.mode;
    if (this.hasAttribute("amount-value")) core.amountValue = this.amountValue;
    if (this.hasAttribute("amount-currency")) core.amountCurrency = this.amountCurrency;
    if (this.hasAttribute("customer-id")) core.customerId = this.customerId;
    // Post-redirect resume may have been skipped in connectedCallback
    // because no Core was attached yet. Retry now that one is available.
    // `_maybeAutoPrepare` guards against racing with resume.
    void this._resumeFromRedirect();
    this._maybeAutoPrepare();
  }

  // --- Input attributes / properties ---

  get mode(): StripeMode {
    const raw = this.getAttribute("mode");
    return raw === "setup" ? "setup" : "payment";
  }
  set mode(value: StripeMode) {
    this.setAttribute("mode", value);
  }

  get amountValue(): number | null {
    const v = this.getAttribute("amount-value");
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  set amountValue(value: number | null) {
    if (value == null) this.removeAttribute("amount-value");
    else this.setAttribute("amount-value", String(value));
  }

  get amountCurrency(): string | null { return this.getAttribute("amount-currency"); }
  set amountCurrency(value: string | null) {
    if (value == null) this.removeAttribute("amount-currency");
    else this.setAttribute("amount-currency", value);
  }

  get customerId(): string | null { return this.getAttribute("customer-id"); }
  set customerId(value: string | null) {
    if (value == null) this.removeAttribute("customer-id");
    else this.setAttribute("customer-id", value);
  }

  get publishableKey(): string { return this.getAttribute("publishable-key") || ""; }
  set publishableKey(value: string) { this.setAttribute("publishable-key", value); }

  get returnUrl(): string { return this.getAttribute("return-url") || ""; }
  set returnUrl(value: string) { this.setAttribute("return-url", value); }

  /** Stripe Elements Appearance API payload. JS-only — not attribute-reflected. */
  get appearance(): Record<string, unknown> | undefined { return this._appearance; }
  set appearance(value: Record<string, unknown> | undefined) {
    // Hot-swap if Elements is already mounted. `elements.update({ appearance })`
    // is the documented path — but it only exists on the Elements group, not
    // the loader. Skip if we have no active Elements (user sets appearance
    // before requestIntent); it will be picked up on the next mount.
    // Also skip when clearing (`undefined`): Stripe.js's reaction to
    // `elements.update({ appearance: undefined })` is unspecified and has
    // no "unset" semantics — a fresh mount is the supported path to
    // revert to defaults.
    if (value === undefined) {
      this._appearance = value;
      return;
    }
    const el = this._elements as unknown as { update?: (opts: Record<string, unknown>) => void } | null;
    if (el && typeof el.update === "function") {
      // Assign AFTER update succeeds so a throwing appearance is not
      // latched on `this._appearance` and re-applied at the next mount
      // (which would repeat the same error in a loop until the caller
      // happens to overwrite with a valid value).
      try {
        el.update({ appearance: value });
        this._appearance = value;
      } catch (error: unknown) {
        this.dispatchEvent(new CustomEvent("stripe-checkout:appearance-warning", {
          detail: {
            message: "Failed to apply appearance via elements.update(); previous appearance retained.",
            error,
          },
          bubbles: true,
        }));
      }
    } else {
      // No mounted Elements yet — store for next mount. No update call
      // to fail, so no risk of latching a broken value.
      this._appearance = value;
    }
  }

  // --- Output state (routed to local Core or remote proxy) ---

  get status(): StripeStatus {
    if (this._isRemote) return (this._remoteValues.status as StripeStatus) ?? "idle";
    return this._core?.status ?? "idle";
  }

  get loading(): boolean {
    if (this._isRemote) return (this._remoteValues.loading as boolean) ?? false;
    return this._core?.loading ?? false;
  }

  get amount(): StripeAmount | null {
    if (this._isRemote) return (this._remoteValues.amount as StripeAmount | null) ?? null;
    return this._core?.amount ?? null;
  }

  get paymentMethod(): StripePaymentMethod | null {
    if (this._isRemote) return (this._remoteValues.paymentMethod as StripePaymentMethod | null) ?? null;
    return this._core?.paymentMethod ?? null;
  }

  get intentId(): string | null {
    if (this._isRemote) return (this._remoteValues.intentId as string | null) ?? null;
    return this._core?.intentId ?? null;
  }

  get error(): StripeError | null {
    if (this._isRemote) {
      // Local layer wins when set: a transport-only rejection (cmd-send
      // throw, proxy timeout) never reached the Core and is only visible
      // locally. Covers the case where the Core-authoritative `error`
      // update is stale from a prior unrelated failure.
      if (this._hasLocalError) return this._errorState;
      // The `"error" in _remoteValues` discriminator distinguishes three
      // states:
      //   - not present: no remote sync has delivered an `error` frame
      //     yet on this session. Fall back to the local slot so a
      //     transport error set BEFORE the first sync stays observable.
      //   - present + non-null: Core published an error — return it.
      //   - present + null: Core published `error = null` (cleared). The
      //     ternary returns null, which is the intended authoritative
      //     "no error" signal.
      // `_disposeRemote` resets `_remoteValues = {}`, returning this
      // getter to the "not present" branch — correct because after
      // dispose there is no authoritative remote state any more.
      return "error" in this._remoteValues ? (this._remoteValues.error as StripeError | null) : this._errorState;
    }
    return this._core?.error ?? this._errorState;
  }

  // --- Trigger (reactive boolean → submit()) ---

  get trigger(): boolean { return this._trigger; }
  set trigger(value: boolean) {
    const v = !!value;
    // Edge-triggered on the false→true transition only. Controlled-prop
    // frameworks (React, Vue) re-run assignments on every render, and a
    // non-edge-guarded setter would re-dispatch `trigger-changed` on
    // every pass — noisy for listeners and harder to reason about.
    // Submit itself has its own `_submitPromise` dedup so a redundant
    // true-on-true write is still a no-op for the network, but
    // suppressing the duplicate event here keeps the public surface
    // clean.
    if (v && !this._trigger) {
      this._trigger = true;
      this.dispatchEvent(new CustomEvent("stripe-checkout:trigger-changed", { detail: true, bubbles: true }));
      // Fire-and-forget by design: trigger is a declarative pulse, not an
      // imperative API surface. Rejections are surfaced through `error`
      // state / `stripe-checkout:error`; this setter only toggles the pulse.
      this.submit().catch(() => {}).finally(() => {
        this._trigger = false;
        this.dispatchEvent(new CustomEvent("stripe-checkout:trigger-changed", { detail: false, bubbles: true }));
      });
    } else if (!v && this._trigger) {
      // Keep read-back aligned with the written value so frameworks that
      // assign `el.trigger = false` observe the update. Does NOT cancel
      // a pending submit() 窶・reset()/abort() are the cancellation APIs.
      this._trigger = false;
      this.dispatchEvent(new CustomEvent("stripe-checkout:trigger-changed", { detail: false, bubbles: true }));
    }
  }

  // --- Core RPC wrappers ---

  private async _requestIntent(hint: IntentRequestHint): Promise<IntentCreationResult> {
    const request = { mode: this.mode, hint };
    if (this._isRemote) {
      return await this._proxy!.invokeWithOptions("requestIntent", [request], { timeoutMs: 0 }) as IntentCreationResult;
    }
    if (!this._core) raiseError("no core attached.");
    return await this._core.requestIntent(request);
  }

  private async _reportConfirmation(report: ConfirmationReport): Promise<void> {
    if (this._isRemote) {
      await this._proxy!.invokeWithOptions("reportConfirmation", [report], { timeoutMs: 0 });
      return;
    }
    if (!this._core) raiseError("no core attached.");
    await this._core.reportConfirmation(report);
  }

  private async _cancelIntent(intentId: string): Promise<void> {
    if (this._isRemote) {
      await this._proxy!.invokeWithOptions("cancelIntent", [intentId], { timeoutMs: 0 });
      return;
    }
    if (!this._core) raiseError("no core attached.");
    await this._core.cancelIntent(intentId);
  }

  private async _coreReset(): Promise<void> {
    if (this._isRemote) {
      await this._proxy!.invoke("reset").catch(() => {});
      return;
    }
    this._core?.reset();
  }

  private async _coreResume(intentId: string, mode: StripeMode, clientSecret: string): Promise<void> {
    if (this._isRemote) {
      await this._proxy!.invokeWithOptions("resumeIntent", [intentId, mode, clientSecret], { timeoutMs: 0 });
      return;
    }
    if (!this._core) raiseError("no core attached.");
    await this._core.resumeIntent(intentId, mode, clientSecret);
  }

  /**
   * True when the URL looks like a Stripe 3DS redirect return — i.e. it
   * has both the intent id AND the matching client_secret. Either alone
   * is NOT treated as a resume trigger: the Core's resume path refuses
   * to hydrate state without the secret (default-secure), so kicking off
   * resume with a bare id would just surface as a failed resume while
   * also blocking the auto-prepare path. Requiring both keeps the auto-
   * prepare path open when someone hand-crafts a URL with only `?payment_intent=...`.
   */
  private _isPostRedirect(): boolean {
    // Once a resume has already completed on this instance (success OR
    // failure), treat the URL as "consumed". Otherwise, a URL whose
    // redirect params survived `history.replaceState` — e.g. because the
    // page is in a sandbox that blocked it, or the app strips them in a
    // router navigation we did not observe — would indefinitely block
    // `prepare()` and `_maybeAutoPrepare`, breaking retry-on-same-page
    // and consecutive-payment flows. `_resumed` flips the gate off as
    // soon as resume has had its one shot.
    if (this._resumed) return false;
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const hasPayment = !!params.get("payment_intent") && !!params.get("payment_intent_client_secret");
    const hasSetup = !!params.get("setup_intent") && !!params.get("setup_intent_client_secret");
    // Malformed URLs that carry both tuples are treated as post-redirect;
    // `_resumeFromRedirect()` applies deterministic payment-first precedence.
    return hasPayment || hasSetup;
  }

  /**
   * Remove Stripe's 3DS-return query parameters from `location` after the
   * resume has folded their content into observable state. Serves two
   * purposes:
   *
   * 1. A browser reload, share, or back-button on the completion page
   *    must not re-trigger resume — once the state is hydrated, the URL
   *    should look like an ordinary app route.
   * 2. Clears `_isPostRedirect()`'s URL-based branch so later `prepare()`
   *    calls (retry buttons, consecutive payments on the same page) can
   *    proceed without the element getting permanently wedged.
   *
   * Uses `history.replaceState` so no history entry is pushed. Silently
   * no-ops in environments where `history` is absent or sandbox-blocked
   * — the `_resumed` flag in `_isPostRedirect()` is the backup guarantee.
   */
  private _stripRedirectParamsFromUrl(): void {
    const loc = globalThis.location;
    const hist = globalThis.history;
    if (!loc || !hist || typeof hist.replaceState !== "function") return;
    let url: URL;
    try { url = new URL(loc.href); } catch { return; }
    const strip = [
      "payment_intent",
      "payment_intent_client_secret",
      "setup_intent",
      "setup_intent_client_secret",
      "redirect_status",
    ];
    let changed = false;
    for (const k of strip) {
      if (url.searchParams.has(k)) {
        url.searchParams.delete(k);
        changed = true;
      }
    }
    if (!changed) return;
    const next = url.pathname + (url.search ? url.search : "") + url.hash;
    try { hist.replaceState(hist.state, "", next); }
    catch { /* sandbox blocked — _resumed is the fallback gate */ }
  }

  /**
   * Mark any in-flight `prepare()` as superseded. Paths that bump the
   * generation go through this helper so the reason (user abort vs config
   * change) is always recorded in lockstep with the counter.
   */
  private _markSupersede(userAbort: boolean): void {
    this._prepareGeneration++;
    this._supersedeIsUserAbort = userAbort;
  }

  /**
   * Fire an auto-prepare if all prerequisites are met. Idempotent: no-op if
   * already prepared, preparing, or in a post-3DS-redirect resume where
   * `_resumeFromRedirect` is the authoritative state rebuild path.
   *
   * Called from `connectedCallback`, `attachLocalCore`, and `_connectRemote`
   * — each of those can be the last prerequisite to arrive, so each is a
   * potential trigger point. Running more often than needed is fine because
   * of the guards below.
   */
  private _maybeAutoPrepare(): void {
    if (!this.isConnected) return;
    if (!this.publishableKey) return;
    if (!this._core && !this._isRemote) return;
    if (this._paymentElement || this._preparePromise) return;
    if (this._resuming || this._isPostRedirect()) return;
    this.prepare().catch(() => {
      // Errors are already surfaced via `_setErrorState` inside prepare();
      // swallow here so the auto path does not log unhandled rejections.
    });
  }

  // --- Elements lifecycle ---

  private async _ensureStripeJs(): Promise<StripeJsLike> {
    const key = this.publishableKey;
    if (!key) {
      raiseError("publishable-key is required before prepare().");
    }
    // Self-consistency: if the cached instance was built for a different
    // key, drop it. `attributeChangedCallback` proactively invalidates on
    // key change, but this keeps `_ensureStripeJs` robust on its own — a
    // future refactor that routes keys through a different channel would
    // otherwise regress silently.
    if (this._stripeJs && this._stripeJsKey !== key) {
      this._stripeJs = null;
      this._stripeJsKey = "";
    }
    if (this._stripeJs) return this._stripeJs;
    const loaded = await Stripe._loader(key);
    // Loader is async. If `publishable-key` flipped between the dispatch
    // and resolution of this loader call, the `loaded` instance is bound
    // to the OLD key's Stripe account — returning it would let the caller
    // mount Elements / submit payment methods against the wrong account.
    // Fail loud; the outer prepare()'s supersede guard catches this and
    // `_maybeAutoPrepare` re-fires with the new key afterward.
    if (this.publishableKey !== key) {
      raiseError("publishable-key changed during Stripe.js load — aborting prepare().");
    }
    this._stripeJs = loaded;
    this._stripeJsKey = key;
    return loaded;
  }

  private _ensureMountHost(): HTMLDivElement {
    if (this._mountHost && this._mountHost.isConnected) return this._mountHost;
    const host = this.ownerDocument.createElement("div");
    host.dataset.stripeCheckoutMount = "";
    this.appendChild(host);
    this._mountHost = host;
    return host;
  }

  private _teardownElements(): void {
    if (this._paymentElement) {
      try { this._paymentElement.destroy(); } catch { /* already detached */ }
      this._paymentElement = null;
    }
    this._elements = null;
    // Do NOT null out `_stripeJs` — it is keyed to the publishable key, not
    // the intent, so the same instance is reusable across intents.
    if (this._mountHost) {
      try { this._mountHost.remove(); } catch { /* already removed */ }
      this._mountHost = null;
    }
    // Clear the clientSecret slot on teardown. A stale clientSecret kept
    // past its intent is never useful (Stripe binds it to that single
    // intent) and a test or future refactor that accidentally references
    // it should fail fast, not succeed with a half-stale value.
    this._clientSecret = "";
    // `_preparedMode` is scoped to the mounted Elements lifetime — same
    // as clientSecret. A fresh prepare() reassigns it.
    this._preparedMode = null;
    this._preparedIntentId = null;
    // Re-arm the return-url warning so the next prepare lifecycle can
    // fire it again if the caller has still not set a return-url.
    this._warnedMissingReturnUrl = false;
  }

  private async _mountElements(clientSecret: string): Promise<void> {
    const stripeJs = await this._ensureStripeJs();
    const elements = stripeJs.elements({ clientSecret, appearance: this._appearance });
    const paymentElement = elements.create("payment", {});
    const host = this._ensureMountHost();
    paymentElement.mount(host);
    paymentElement.on("ready", () => {
      this.dispatchEvent(new CustomEvent("stripe-checkout:element-ready", { bubbles: true }));
    });
    paymentElement.on("change", (ev: Record<string, unknown>) => {
      // Surface only the completeness flag — Stripe ships the full element
      // value here which can include sensitive hints; leaking them via a
      // CustomEvent detail would violate our PCI scope claim.
      this.dispatchEvent(new CustomEvent("stripe-checkout:element-change", {
        detail: { complete: !!ev.complete },
        bubbles: true,
      }));
    });
    this._elements = elements;
    this._paymentElement = paymentElement;
  }

  // --- Public commands ---

  /**
   * Create the intent on the Core and mount Stripe Elements into this
   * element. Idempotent — concurrent callers share one in-flight promise
   * and a second call after success is a no-op until `reset()` / `abort()`.
   *
   * Normally auto-fires from `connectedCallback` / `attachLocalCore` /
   * `_connectRemote` (whichever is the last prerequisite to land), so that
   * a `<stripe-checkout publishable-key="..." mode="payment">` tag renders
   * Elements without any imperative setup. Callers that prefer explicit
   * control can turn off the auto path by setting the required attributes
   * AFTER `connectedCallback` (unsupported in v1 — prepare() manually) or
   * just call `prepare()` directly.
   *
   * Failure is stored on `this.error` and the promise rejects. A failed
   * prepare does NOT wedge the element: the next call re-attempts from
   * scratch (the rolled-back intent is cancelled on the server).
   */
  async prepare(): Promise<void> {
    if (this._paymentElement && this._elements && this._clientSecret) return;
    if (this._preparePromise) return this._preparePromise;
    if (this._resuming || this._isPostRedirect()) {
      // `_resumeFromRedirect` is the authoritative state rebuild on this
      // page load — creating another intent now would double-charge.
      return;
    }
    if (!this.publishableKey) {
      raiseError("publishable-key is required before prepare().");
    }
    // Early format check. Stripe publishable keys always have the `pk_`
    // prefix (`pk_live_...` / `pk_test_...` / future `pk_*_...` variants).
    // Without this, a mispasted secret key (`sk_live_...`) gets all the
    // way to Stripe.js before failing with an opaque "Invalid API Key"
    // message — the local fail-loud here turns a DX cliff into an
    // `[@wc-bindable/stripe]`-prefixed diagnostic.
    if (!this.publishableKey.startsWith("pk_")) {
      raiseError('publishable-key must be a Stripe publishable key (starts with "pk_").');
    }

    // Snapshot the mode at the top of prepare so that an attribute flip
    // after this point cannot desync the confirm path.
    const preparedMode: StripeMode = this.mode;
    // Supersede marker. Captured before any await so every await boundary
    // below can verify the prepare still represents the current config.
    // `_invalidateForKeyChange` bumps `_prepareGeneration`, which causes
    // the checks below to abort the rest of this prepare.
    const gen = this._prepareGeneration;
    const promise = (async () => {
      this._clearErrorState();
      let creation: IntentCreationResult;
      try {
        creation = await this._requestIntent({
          amountValue: this.amountValue ?? undefined,
          amountCurrency: this.amountCurrency ?? undefined,
          customerId: this.customerId ?? undefined,
        });
      } catch (e: unknown) {
        // If a supersede already ran (reset / abort / disconnect / key
        // change), the Core's own cancellation path throws a
        // "requestIntent superseded" error that should NOT reach
        // observable state — the user-visible truth is that this prepare
        // was explicitly aborted. Matches the gen-check in the mount
        // catch below.
        if (gen === this._prepareGeneration) {
          this._setErrorStateFromUnknown(e);
        }
        throw e;
      }
      // Config superseded during _requestIntent. The intent we just
      // created (or the Core's cancel path created and cancelled) is
      // orphaned under the old configuration — best-effort cancel it
      // before aborting so the prior account does not retain a
      // requires_payment_method row forever. The cleanup handler decides
      // whether to auto-retry based on the supersede reason.
      if (gen !== this._prepareGeneration) {
        this._cancelIntent(creation.intentId).catch(() => {});
        raiseError("prepare() superseded.");
      }
      this._clientSecret = creation.clientSecret;
      try {
        await this._mountElements(creation.clientSecret);
      } catch (e: unknown) {
        // Elements mount failed — roll back the intent on the server so it
        // does not sit in requires_payment_method forever billing nothing
        // but leaking a row. cancelIntent is a no-op for SetupIntents.
        this._cancelIntent(creation.intentId).catch(() => {});
        this._clientSecret = "";
        // Do not record the supersede-abort as an observable error: it is
        // a normal consequence of user action (key swap / reset / abort /
        // disconnect), not a failure mode.
        if (gen === this._prepareGeneration) {
          this._setErrorStateFromUnknown(e);
        }
        throw e;
      }
      // Config superseded during _mountElements (loader race inside
      // _ensureStripeJs, or user action). Tear down and cancel.
      if (gen !== this._prepareGeneration) {
        this._teardownElements();
        this._cancelIntent(creation.intentId).catch(() => {});
        raiseError("prepare() superseded.");
      }
      this._preparedMode = preparedMode;
      this._preparedIntentId = creation.intentId;
    })();
    this._preparePromise = promise;
    // Clear the slot on both branches so a rejected prepare does not
    // permanently latch the element into "preparing forever". On a
    // supersede caused by CONFIG change (key-change), re-fire auto-prepare
    // so the new config converges. On a USER abort (reset / abort /
    // disconnect), do NOT retry — the user asked for idle and retrying
    // would silently undo that request.
    const cleanup = (): void => {
      if (this._preparePromise === promise) this._preparePromise = null;
      if (gen !== this._prepareGeneration && !this._supersedeIsUserAbort) {
        this._maybeAutoPrepare();
      }
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  /**
   * Confirm the active intent. Requires `prepare()` to have already
   * mounted Elements — if not, `submit()` waits for an in-flight prepare
   * or kicks one off, then fails with "not prepared" if Elements still
   * isn't mounted by then (e.g. missing publishable-key).
   *
   * Legal outcomes:
   *   - succeeded / processing / requires_action / failed → `reportConfirmation`
   *   - 3DS redirect → `confirmPayment` redirects away; the next page load's
   *     `connectedCallback` handles `_resumeFromRedirect`.
   */
  submit(): Promise<void> {
    // Dedupe concurrent submits. A double-click must yield ONE confirm,
    // not two that race on reportConfirmation — the Core only
    // distinguishes by intentId + generation, so a second confirm for
    // the same intent would overwrite the first's outcome.
    //
    // Return the in-flight promise directly (not an `async` wrapper
    // around it) so repeat callers share identity and can observe a
    // unified resolution rather than racing on separately-allocated
    // wrappers around the same underlying work.
    if (this._submitPromise) return this._submitPromise;
    const promise = this._submitImpl();
    this._submitPromise = promise;
    const cleanup = (): void => {
      if (this._submitPromise === promise) this._submitPromise = null;
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  private async _submitImpl(): Promise<void> {
    this._clearErrorState();

    if (this._preparePromise) {
      // Propagate the prior prepare's rejection instead of swallowing it.
      // The old behavior — swallow + fall through to a second `prepare()`
      // call below — would create a second PaymentIntent while the first
      // prepare's best-effort `_cancelIntent(creation.intentId)` is still
      // in flight, leaving the app with one canceled + one live intent
      // and the original failure hidden from the caller.
      await this._preparePromise;
    }
    if (!this._paymentElement || !this._elements || !this._clientSecret) {
      // Auto-prepare as an ergonomic fallback. Only reachable when no
      // prior `prepare()` was in flight (the await above already either
      // succeeded or threw). Users who set attrs before appendChild get
      // auto-prepare for free in connectedCallback; this branch covers
      // the path where attrs arrive later and the user then calls
      // `submit()` directly without an explicit `prepare()`.
      await this.prepare();
    }
    if (!this._paymentElement || !this._elements || !this._clientSecret) {
      const err = new Error("[@wc-bindable/stripe] Elements not mounted — prepare() did not complete.");
      this._setErrorState({ message: err.message });
      throw err;
    }

    const stripeJs = this._stripeJs!;
    const returnUrl = this.returnUrl;
    // DX warning: `redirect: "if_required"` + no return_url is a valid
    // combination for strictly inline flows, but if Stripe.js decides
    // a redirect IS required at confirm time it throws with an opaque
    // "Invalid confirmParams" message. Dispatch a single observability
    // event when this configuration is reached in payment mode so apps
    // can listen and surface the risk — listen to nothing and the flow
    // still behaves exactly as before.
    //
    // Scoped to `payment` mode for now: SetupIntent flows CAN also redirect
    // (iDEAL / Bancontact mandates), but forgotten `return-url` on setup is
    // empirically rare and Stripe.js's error there is clearer. Broaden if
    // that assumption changes.
    if (!returnUrl && (this._preparedMode ?? this.mode) === "payment" && !this._warnedMissingReturnUrl) {
      this._warnedMissingReturnUrl = true;
      this.dispatchEvent(new CustomEvent("stripe-checkout:missing-return-url-warning", {
        detail: {
          // Cover the full class of affected payment methods: 3DS cards
          // AND non-card redirect-based PMs (Konbini, Alipay, WeChat Pay,
          // Klarna, PayPay, …) that `automatic_payment_methods: { enabled: true }`
          // can present. Naming only 3DS would misroute the reader into
          // thinking card-only accounts are immune.
          message: "submit() reached without a return-url. Redirect-required payment methods (3DS cards, Konbini, wallets, Klarna, etc.) will fail at confirm time with an opaque error. Set return-url if any payment method in the account may require a redirect.",
        },
        bubbles: true,
      }));
    }
    const common = {
      elements: this._elements!,
      clientSecret: this._clientSecret,
      confirmParams: returnUrl ? { return_url: returnUrl } : {},
      // `redirect: "if_required"` lets confirmPayment resolve inline for
      // non-redirect PaymentMethods (cards without 3DS challenge) and only
      // redirect when Stripe's next_action requires it. Without this the
      // SPA-style inline-succeed path would never be reachable.
      redirect: "if_required" as const,
    };

    // Dispatch on the mode captured at prepare() — NOT `this.mode`. If the
    // consumer flipped the attribute between prepare and submit, the
    // mounted Elements and clientSecret are still bound to preparedMode,
    // so calling the other confirm API would throw inside Stripe.js with
    // an opaque "clientSecret does not match the intent type" error. We
    // already emitted `stripe-checkout:stale-config` when the attribute
    // changed; silent mis-dispatch on top of that would be worse.
    // Snapshot the supersede counter BEFORE confirm. `reset()` / `abort()` /
    // `disconnectedCallback()` all call `_markSupersede(true)` which bumps
    // `_prepareGeneration`. A late confirm result (success, decline, or
    // network throw) arriving after the user has asked to discard the
    // attempt must NOT leak back into observable state — the Core already
    // drops the stale `reportConfirmation` via its `_activeIntent == null`
    // guard, but the Shell's own `_setErrorState` / error-event dispatch
    // runs before that RPC and would otherwise paint `this.error` with
    // `card_declined` (or similar) after `reset()` cleared it. Mirrors the
    // same supersede discipline prepare() already uses around its awaits.
    const submitGen = this._prepareGeneration;
    const confirmMode = this._preparedMode ?? this.mode;
    let result: { paymentIntent?: Record<string, unknown>; setupIntent?: Record<string, unknown>; error?: Record<string, unknown> };
    const intentIdForReport = this._preparedIntentId ?? this.intentId ?? "";
    // Defense: by this point we have passed the `!_paymentElement` gate
    // above, so `_preparedIntentId` is expected to be set. If some future
    // refactor ever lets an empty id slip through, downstream
    // `_applyIntentOutcome` would unconditionally call `_setErrorState`
    // in the `requires_payment_method` / `canceled` branches even though
    // Core drops the report for an unmatched id — leaving a ghost error
    // observable on `this.error`. Fail loud here before that happens.
    if (!intentIdForReport) {
      raiseError("submit() reached confirm with no intent id — prepare() invariant violated.");
    }
    try {
      result = confirmMode === "payment"
        ? await stripeJs.confirmPayment(common)
        : await stripeJs.confirmSetup(common);
    } catch (e: unknown) {
      // Superseded mid-confirm (abort / reset / disconnect). The user-
      // visible truth is their terminate request — swallow the confirm
      // throw entirely rather than surface it through `this.error` or a
      // `stripe-checkout:error` event, and skip the Core report (Core will
      // drop it anyway; calling it on a null `_activeIntent` would still
      // add a no-op round-trip across the remote transport).
      if (submitGen !== this._prepareGeneration) return;
      this._setErrorStateFromUnknown(e);
      await this._reportConfirmation({
        intentId: intentIdForReport,
        outcome: "failed",
        error: { message: e instanceof Error ? e.message : "confirm threw." },
      }).catch(() => {});
      throw e;
    }

    if (submitGen !== this._prepareGeneration) return;

    if (result.error) {
      const err = this._sanitizeStripeJsError(result.error);
      this._setErrorState(err);
      await this._reportConfirmation({
        intentId: intentIdForReport,
        outcome: "failed",
        error: err,
      }).catch(() => {});
      return;
    }

    const intent = (result.paymentIntent ?? result.setupIntent) as Record<string, unknown> | undefined;
    if (!intent) {
      // Stripe.js is contracted to return one of {paymentIntent, setupIntent, error};
      // reaching this branch means a malformed result slipped through. Do
      // not leave the UI wedged on `processing` / `loading=true`. Surface
      // the anomaly for observability and fall back to a processing
      // report so the webhook path can still reconcile terminal state.
      this.dispatchEvent(new CustomEvent<UnknownStatusDetail>("stripe-checkout:unknown-status", {
        detail: {
          source: "shell-malformed",
          intentId: intentIdForReport,
          mode: this._preparedMode ?? this.mode,
          status: "",
          reason: "stripe.confirm returned no intent and no error",
        },
        bubbles: true,
      }));
      await this._reportConfirmation({
        intentId: intentIdForReport,
        outcome: "processing",
      }).catch(() => {});
      return;
    }
    await this._applyIntentOutcome(intent, intentIdForReport);
  }

  /**
   * Tear down Elements + return the Core to idle. Does NOT call the Stripe
   * API to cancel the intent — use `abort()` for that. `reset()` is the
   * cheap "user navigated away / UI wants a clean slate" path.
   */
  reset(): void {
    // Supersede any in-flight prepare() BEFORE teardown, so a prepare
    // parked on `_requestIntent` / `_mountElements` does not resume and
    // silently re-mount / re-seed state after reset returned. User-abort
    // semantics — cleanup must NOT auto-retry.
    this._markSupersede(true);
    this._teardownElements();
    this._clearErrorState();
    this._coreReset().catch(() => {});
  }

  /**
   * Cancel the in-flight intent on the server and tear down Elements.
   * Safe to call when there is no active intent (no-op).
   */
  async abort(): Promise<void> {
    // Same rationale as `reset()`: stop any in-flight prepare before the
    // teardown + cancel sequence so a parked prepare cannot resume and
    // undo the abort afterward.
    this._markSupersede(true);
    // In remote mode, `this.intentId` reads from `_remoteValues.intentId`
    // — populated asynchronously by `update` frames from the Core. If a
    // prepare is still in flight (Core may already have created the
    // intent and queued updates + return, but the client has not
    // processed them yet), reading intentId right now returns null and
    // we would fall through to `_coreReset`. Core's reset then clears
    // `_activeIntent` BEFORE the prepare's own supersede cleanup can
    // call `_cancelIntent(creation.intentId)` — whose Core-side check
    // `if (!active) return;` now no-ops, leaving the PaymentIntent
    // orphaned at Stripe.
    //
    // Await the in-flight prepare first so one of two stable outcomes
    // holds by the time we read intentId:
    //   1. Prepare resolved → intentId is synced and `_cancelIntent`
    //      below cancels it.
    //   2. Prepare was superseded by the `_markSupersede(true)` above
    //      → its own cleanup already called `_cancelIntent(pi_X)` on
    //      a still-active `_activeIntent` — pi_X is canceled at Stripe,
    //      intentId has since gone to null, and `_coreReset` below
    //      becomes a no-op.
    const preparePromise = this._preparePromise;
    if (preparePromise) {
      // Deliberate asymmetry with `_submitImpl`'s `await this._preparePromise`
      // (which propagates). `abort()` is a best-effort teardown path — the
      // caller has already said "discard the attempt" and wants a clean
      // element state regardless of prepare's outcome. Propagating prepare's
      // reject would skip the `_teardownElements` + cancel-or-reset cleanup
      // below and leave the element in whatever half-mounted state prepare
      // died in. Swallow and continue; any lingering error is already on
      // `this.error` via prepare's own `_setErrorState`.
      await preparePromise.catch(() => { /* supersede / prior failure */ });
    }
    const id = this.intentId;
    this._teardownElements();
    if (id) {
      try {
        await this._cancelIntent(id);
      } catch { /* best-effort */ }
    } else {
      await this._coreReset();
    }
  }

  // --- Confirmation result helpers ---

  /**
   * Sanitize Stripe.js-originated errors before putting them into Shell state
   * and sending `reportConfirmation` to Core.
   *
   * Unlike Core's `_sanitizeError` (which handles arbitrary server-side
   * throwables), this path only receives objects produced by Stripe.js
   * confirm/retrieve flows in the browser. We therefore trust Stripe.js's own
   * client-side sanitization contract for `message` and keep it when present.
   *
   * `message` is still length-capped — Stripe.js errors are empirically short,
   * but a bundler's global error handler / extension proxy could theoretically
   * splice large strings into the object before we reach it. The cap matches
   * Core's `_sanitizeError` bound so DOM sinks see a consistent upper bound
   * regardless of which side produced the error.
   *
   * If this function is ever reused for non-Stripe.js inputs, DO NOT keep this
   * policy: align with Core's stricter allowlist-gated message forwarding.
   */
  private _sanitizeStripeJsError(err: Record<string, unknown>): StripeError {
    const rawMessage = typeof err.message === "string" ? err.message : "Payment failed.";
    const message = rawMessage.length > Stripe._MAX_ERROR_MESSAGE_LENGTH
      ? rawMessage.slice(0, Stripe._MAX_ERROR_MESSAGE_LENGTH - 1) + "…"
      : rawMessage;
    return {
      code: typeof err.code === "string" ? err.code : undefined,
      declineCode: typeof err.decline_code === "string" ? err.decline_code : undefined,
      type: typeof err.type === "string" ? err.type : undefined,
      message,
    };
  }

  /**
   * Map Stripe.js confirm/retrieve intent status strings onto Core
   * `reportConfirmation` outcomes.
   *
   * Unknown statuses are treated as `processing` (not `failed`) and emit
   * `stripe-checkout:unknown-status` for observability. This keeps the flow on
   * the webhook-authoritative path so newly introduced Stripe statuses can
   * converge to a terminal result without false-failure retries.
   *
   * In environments where webhooks are disabled/misconfigured, an unknown
   * status can therefore remain `processing`/loading until app policy times
   * out. Subscribe to `stripe-checkout:unknown-status` and apply an app-level
   * timeout/escalation policy.
   */
  private async _applyIntentOutcome(intent: Record<string, unknown>, intentId: string): Promise<void> {
    const status = typeof intent.status === "string" ? intent.status : "";
    const pm = extractCardPaymentMethod(intent);

    switch (status) {
      case "succeeded":
        await this._reportConfirmation({
          intentId,
          outcome: "succeeded",
          paymentMethod: pm,
        }).catch(() => {});
        break;
      case "requires_action":
      case "requires_confirmation":
        await this._reportConfirmation({
          intentId,
          outcome: "requires_action",
        }).catch(() => {});
        break;
      case "processing":
        await this._reportConfirmation({
          intentId,
          outcome: "processing",
        }).catch(() => {});
        break;
      case "requires_payment_method":
      case "canceled": {
        const lastErr = intent.last_payment_error ?? intent.last_setup_error;
        const err = lastErr && typeof lastErr === "object"
          ? this._sanitizeStripeJsError(lastErr as Record<string, unknown>)
          : { message: "Payment failed." };
        this._setErrorState(err);
        await this._reportConfirmation({
          intentId,
          outcome: "failed",
          error: err,
        }).catch(() => {});
        break;
      }
      default: {
        this.dispatchEvent(new CustomEvent<UnknownStatusDetail>("stripe-checkout:unknown-status", {
          detail: {
            source: "shell-confirm",
            intentId,
            mode: this._preparedMode ?? this.mode,
            status,
          },
          bubbles: true,
        }));
        await this._reportConfirmation({
          intentId,
          outcome: "processing",
        }).catch(() => {});
        break;
      }
    }
  }


  // --- 3DS redirect return ---

  /**
   * On connect, check whether we are in the post-3DS page load. Stripe
   * redirects to `return_url` with `payment_intent=pi_xxx` (or
   * `setup_intent=seti_xxx`) in the query string. When present, hand the
   * intent id off to the Core's `resumeIntent` RPC — the Core performs a
   * server-side `retrieveIntent` (authoritative, expanded
   * `payment_method`) and rebuilds `_activeIntent` + observable state.
   *
   * Reviewer caught the earlier bug: the old code routed the Stripe.js
   * client-side `retrievePaymentIntent` result through
   * `reportConfirmation`, which drops the report when `_activeIntent`
   * is null — and after a page reload, the fresh Core instance has no
   * active intent, so the entire resume was a silent no-op. The new path
   * goes through `resumeIntent`, which explicitly sets `_activeIntent`
   * before folding state, so the resumed session can receive subsequent
   * webhook updates and `cancelIntent` calls normally.
   */
  private async _resumeFromRedirect(): Promise<void> {
    if (this._resumed || this._resuming) return;
    // No Core attached yet. Leave the call to the next trigger point
    // (`attachLocalCore` / `_connectRemote`); the URL params are still
    // readable then and the resume can fire for real.
    if (!this._core && !this._isRemote) return;

    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const paymentIntentId = params.get("payment_intent");
    const paymentSecret = params.get("payment_intent_client_secret");
    const setupIntentId = params.get("setup_intent");
    const setupSecret = params.get("setup_intent_client_secret");

    // Require BOTH the intent id and the Stripe-issued client_secret.
    // Stripe's redirect always includes both; a URL with only one (id or
    // secret) is either hand-crafted or tampered, and the Core's resume
    // path would reject it anyway. Bailing here keeps the auto-prepare
    // path open for such URLs rather than surfacing a pointless
    // "resume_client_secret_mismatch" error on the element.
    let intentId: string | null = null;
    let clientSecret: string | null = null;
    let mode: StripeMode | null = null;
    // Deterministic tie-break for malformed URLs containing both tuples:
    // prefer payment so behavior is stable across runs.
    if (paymentIntentId && paymentSecret) {
      intentId = paymentIntentId;
      clientSecret = paymentSecret;
      mode = "payment";
    } else if (setupIntentId && setupSecret) {
      intentId = setupIntentId;
      clientSecret = setupSecret;
      mode = "setup";
    }
    if (!intentId || !clientSecret || !mode) return;

    this._resuming = true;
    // Only mark the URL "consumed" when the Core gave a definitive answer
    // (success or a Core-originated rejection) for THIS resume call.
    // Transport-level failures (WebSocket close mid-invoke, proxy
    // timeout, cmd-send throw, a transient 5xx from the server) must
    // leave `_resumed = false` and the URL params intact so a later
    // trigger — reconnect, component re-mount, page reload — can retry.
    // Stripping on transport failure is the path that creates duplicate-
    // charge exposure: the 3DS flow already cleared at Stripe's end, but
    // the app would have no way to fold the real intent's terminal state
    // back into observable state and would auto-prepare a NEW intent for
    // the same cart.
    //
    // Snapshot `_remoteErrorSeq` BEFORE the await so "Core spoke" is
    // decided by whether it published any error update during THIS
    // resume, not by whether some stale error from an earlier operation
    // is still sitting in `_remoteValues.error`. Checking only
    // `!!_remoteValues.error` would misclassify a pure cmd-send failure
    // on a session that already holds an old error as a Core-origin
    // denial and strip the URL. Mirrors the same seq-based freshness
    // check used in `_setErrorStateFromUnknown`.
    const remoteSeqBefore = this._isRemote ? this._remoteErrorSeq : 0;
    let coreSpoke = false;
    try {
      await this._coreResume(intentId, mode, clientSecret);
      coreSpoke = true;
    } catch (e: unknown) {
      this._setErrorStateFromUnknown(e);
      if (this._isRemote) {
        // Core participated in this resume iff at least one `error`
        // update crossed the wire since we started. A Core-origin
        // rejection ALWAYS bumps the seq (via `_setError(null)` at the
        // top of resumeIntent + `_setError(err)` before throwing). A
        // cmd that never reached the Core advances nothing.
        coreSpoke = this._remoteErrorSeq > remoteSeqBefore;
      } else {
        // Local mode has no transport boundary — a throw out of
        // `_coreResume` is the Core's own throw. Treat as definitive.
        coreSpoke = true;
      }
    } finally {
      this._resuming = false;
      if (coreSpoke) {
        this._resumed = true;
        this._stripRedirectParamsFromUrl();
      }
      // Transport-only failure path: leave `_resumed = false` so the
      // next trigger (`_connectRemote` after a reconnect, a fresh
      // `connectedCallback` on page reload) picks the URL up again.
    }
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    if (getConfig().remote.enableRemote && !this._isRemote) {
      try {
        this._initRemote();
        this._clearErrorState();
      } catch (error) {
        this._setErrorStateFromUnknown(error);
      }
    }
    // Post-3DS page load: resume takes precedence over auto-prepare.
    // `_maybeAutoPrepare` explicitly bails when `_isPostRedirect()` or
    // `_resuming` is true, so a concurrent auto path would not create a
    // second intent alongside the one we are rebuilding. Schedule the
    // auto-prepare attempt unconditionally — if `_resumeFromRedirect`
    // wins the race and sets `_resuming = true`, the auto path bails.
    void this._resumeFromRedirect();
    this._maybeAutoPrepare();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === "mode") {
      this._syncInput("mode", newValue === "setup" ? "setup" : "payment");
      // After prepare, mode is locked to whatever was captured at prepare
      // time (see _preparedMode). Warn so app code doesn't silently assume
      // the change is effective for the next submit() — it is not.
      this._warnIfConfigChangedAfterPrepare("mode");
    } else if (name === "amount-value") {
      const v = newValue != null && newValue !== "" ? Number(newValue) : null;
      this._syncInput("amountValue", Number.isFinite(v as number) ? (v as number) : null);
      this._warnIfConfigChangedAfterPrepare("amountValue");
    } else if (name === "amount-currency") {
      this._syncInput("amountCurrency", newValue || null);
      this._warnIfConfigChangedAfterPrepare("amountCurrency");
    } else if (name === "customer-id") {
      this._syncInput("customerId", newValue || null);
      this._warnIfConfigChangedAfterPrepare("customerId");
    } else if (name === "publishable-key") {
      // Observed but not synced to the Core (it is a Stripe.js configuration,
      // not a wcBindable input). Its late arrival can nevertheless be the
      // last missing prerequisite for auto-prepare — per SPEC §5.4
      // "auto-prepare のライフサイクル", auto-prepare must fire whenever
      // the last prerequisite lands, independent of ordering.
      //
      // A *change* of the key (not just the initial set) also requires
      // invalidating any cached Stripe.js instance, tearing down Elements,
      // and cancelling the orphan intent on the server. pk_A and pk_B
      // typically belong to different Stripe accounts/environments;
      // reusing a pk_A-bound `_stripeJs` under a pk_B configuration
      // would route payment method submissions to the wrong account.
      // Treat an empty OLD value as "no key" — a framework that stages
      // the element with `publishable-key=""` before setting the real
      // key would otherwise trip `_invalidateForKeyChange` on a purely
      // initial transition (wasted teardown + coreReset work).
      //
      // An empty NEW value, by contrast, is a real "clear the key"
      // action — the caller wants Elements torn down so a subsequent
      // prepare() does not early-return on the stale `_paymentElement`
      // that is still bound to pk_OLD. Do NOT skip invalidation in
      // that direction.
      if (oldValue != null && oldValue !== "" && newValue !== oldValue) {
        this._invalidateForKeyChange();
      }
      this._maybeAutoPrepare();
    }
  }

  /**
   * Drop all state bound to the prior publishable key. Synchronous parts
   * (Elements teardown, cache null-out, `_preparedMode`, `_clientSecret`)
   * run inline so `_maybeAutoPrepare` sees a clean slate on the very next
   * statement. The server-side orphan cancel is fire-and-forget — it uses
   * the Core's provider (secret key), which is independent of the
   * publishable key that just changed.
   *
   * Bumping `_prepareGeneration` tells any prepare() currently parked on
   * an await (in particular `Stripe._loader(pk_A)`) to abort instead of
   * carrying the old key's Stripe.js into `_mountElements`. The prepare
   * cleanup observes the bump and re-fires `_maybeAutoPrepare` so the
   * new config converges.
   */
  private _invalidateForKeyChange(): void {
    // key-change supersede — cleanup auto-retries with the new key.
    this._markSupersede(false);
    const orphanId = this.intentId;
    this._teardownElements();  // clears Elements, _clientSecret, _preparedMode
    this._stripeJs = null;
    this._stripeJsKey = "";
    if (orphanId) {
      this._cancelIntent(orphanId).catch(() => { /* best-effort */ });
    } else {
      // No intent to cancel, but the Core may still hold stale observable
      // state (e.g. `error` from a prior failed prepare). Put it back to
      // idle so the upcoming auto-prepare starts from a clean baseline.
      this._coreReset().catch(() => {});
    }
  }

  /**
   * Emit an observability event when an input that feeds prepare() (mode /
   * amount / customer) is changed AFTER prepare has locked in a clientSecret.
   * The change does NOT retroactively re-issue the PaymentIntent — the
   * mounted Elements and its clientSecret stay bound to the values captured
   * at prepare time. Apps that actually want to switch modes / amounts
   * must call reset() or abort() and re-prepare. Silent divergence here
   * is the exact failure finding #2 warns against.
   */
  private _warnIfConfigChangedAfterPrepare(field: string): void {
    if (!this._preparedMode) return;
    this.dispatchEvent(new CustomEvent("stripe-checkout:stale-config", {
      detail: {
        field,
        message: `${field} changed after prepare() — call reset() to re-prepare with the new value.`,
      },
      bubbles: true,
    }));
  }

  /**
   * Proxy a declarative input from the Shell attribute surface to the
   * Core (local mode) or to the wire (remote mode). `name` is restricted
   * to the four bindable inputs declared in `wcBindable.inputs` — any
   * other value is a bug, not a runtime concern, so we raise rather than
   * silently dropping.
   *
   * Dispatching via a typed switch (not a dynamic `(core as any)[name] = v`)
   * keeps the call site under TypeScript's checker — a rename of
   * `amountValue` on the Core would surface here as a compile error
   * instead of a runtime null-write at the end of a long chain.
   */
  private _syncInput(
    name: "mode" | "amountValue" | "amountCurrency" | "customerId",
    value: unknown,
  ): void {
    if (this._isRemote && this._proxy) {
      this._proxy.setWithAck(name, value).catch((e: unknown) => this._setErrorStateFromUnknown(e));
      return;
    }
    if (!this._core) return;
    switch (name) {
      case "mode":
        this._core.mode = value as StripeMode;
        return;
      case "amountValue":
        this._core.amountValue = value as number | null;
        return;
      case "amountCurrency":
        this._core.amountCurrency = value as string | null;
        return;
      case "customerId":
        this._core.customerId = value as string | null;
        return;
      default: {
        // Exhaustiveness check. If a new bindable input is added to the
        // Core's wcBindable.inputs, the type narrowing above catches the
        // missing branch at compile time; this runtime assertion
        // additionally catches a caller passing a string outside the
        // declared union (e.g. via a dynamic cast). Silent drop was the
        // old behavior — surfacing makes the misuse debuggable.
        const exhaustive: never = name;
        raiseError(`_syncInput: unknown input name: ${JSON.stringify(exhaustive as unknown)}.`);
      }
    }
  }

  disconnectedCallback(): void {
    // Stop any in-flight prepare BEFORE teardown so a parked prepare does
    // not resume and mount Stripe Elements into a now-detached DOM
    // subtree (memory leak + orphan Stripe iframe). Same user-abort
    // semantics as reset()/abort() — do NOT auto-retry.
    this._markSupersede(true);
    this._teardownElements();
    if (this._isRemote) {
      this._disposeRemoteWithBestEffortReset();
    } else {
      // Reset state on the attached Core, then drop our reference.
      // Keeping the reference would otherwise cause a re-mount followed
      // by `attachLocalCore(newCore)` to trip the "different core"
      // guard in `attachLocalCore`, making lifecycle re-use impossible.
      // The Core's own registrations (webhook handlers, intent builder)
      // survive — the caller is responsible for reusing the same Core
      // or explicitly disposing the old one before passing a new one.
      this._core?.reset();
      this._core = null;
    }
  }
}
