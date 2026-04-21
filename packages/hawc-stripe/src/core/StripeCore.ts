import { raiseError } from "../raiseError.js";
import {
  IWcBindable, IStripeProvider, IntentBuilder, IntentRequest, IntentCreationResult,
  ConfirmationReport, WebhookHandler, WebhookRegisterOptions, StripeError, StripeEvent,
  StripeMode, StripeStatus, StripeAmount, StripePaymentMethod, UserContext,
  PaymentIntentOptions, SetupIntentOptions, IntentBuilderResult, ResumeAuthorizer,
} from "../types.js";

/**
 * Headless Stripe payments core.
 *
 * Lives server-side. Holds the Stripe secret key via the injected
 * IStripeProvider, owns PaymentIntent / SetupIntent creation, runs registered
 * webhook handlers after signature verification, and tracks the observable
 * status a Shell subscribes to over the wcBindable wire.
 *
 * The card payload never crosses this Core — the browser hands card data
 * directly to Stripe through the Elements iframe (see SPEC §2 data plane
 * bypass). Only intent metadata, the client secret (never observable), and
 * confirmation outcomes flow through the WebSocket.
 *
 * Secret handling invariant (SPEC §9.2):
 *   - STRIPE_SECRET_KEY lives only inside the provider instance.
 *   - webhook signing secret lives only inside this Core.
 *   - clientSecret is stored per active intent in `_activeIntent` and never
 *     surfaced through an observable property or getter. The Shell receives
 *     it through the `requestIntent` RPC return value alone.
 */
export class StripeCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "status", event: "hawc-stripe:status-changed" },
      { name: "loading", event: "hawc-stripe:loading-changed" },
      { name: "amount", event: "hawc-stripe:amount-changed" },
      { name: "paymentMethod", event: "hawc-stripe:paymentMethod-changed" },
      { name: "intentId", event: "hawc-stripe:intentId-changed" },
      { name: "error", event: "hawc-stripe:error" },
    ],
    inputs: [
      { name: "mode" },
      { name: "amountValue" },
      { name: "amountCurrency" },
      { name: "customerId" },
    ],
    commands: [
      { name: "requestIntent", async: true },
      { name: "reportConfirmation", async: true },
      { name: "cancelIntent", async: true },
      { name: "resumeIntent", async: true },
      { name: "reset" },
    ],
  };

  private _target: EventTarget;
  private _provider: IStripeProvider;
  private _webhookSecret: string | null;
  private _userContext: UserContext | undefined;

  private _mode: StripeMode = "payment";
  private _amountValueHint: number | null = null;
  private _amountCurrencyHint: string | null = null;
  private _customerId: string | null = null;

  private _status: StripeStatus = "idle";
  private _loading: boolean = false;
  private _amount: StripeAmount | null = null;
  private _paymentMethod: StripePaymentMethod | null = null;
  private _intentId: string | null = null;
  private _error: StripeError | null = null;

  private _intentBuilder: IntentBuilder | null = null;
  private _webhookHandlers: Map<string, { handler: WebhookHandler; fatal: boolean }[]> = new Map();
  private _resumeAuthorizer: ResumeAuthorizer | null = null;

  /**
   * Tracks the clientSecret and mode of the currently-active intent.
   *
   * Stored separately from observable state because clientSecret is
   * deliberately NOT in the bindable surface (SPEC §5.2) — surfacing it
   * through `this._intentId`'s event or a `_setClientSecret` helper would
   * broadcast a confirmation token to every subscriber and (via
   * RemoteShellProxy) every connected browser tab. The Shell receives it
   * exactly once, as the return value of `requestIntent`. This slot's only
   * job on the Core side is to let `cancelIntent` validate the id being
   * cancelled matches the one we created.
   *
   * `generation` increments on every `requestIntent` so that confirmation
   * reports or webhook-driven status transitions from a superseded intent
   * (user clicked submit twice, Stripe delivered the 3DS callback late) do
   * not clobber the current intent's state.
   */
  private _activeIntent: {
    id: string;
    mode: StripeMode;
    generation: number;
  } | null = null;
  private _generation: number = 0;

  constructor(
    provider: IStripeProvider,
    opts: {
      webhookSecret?: string;
      userContext?: UserContext;
      target?: EventTarget;
    } = {},
  ) {
    super();
    if (!provider) raiseError("provider is required.");
    this._provider = provider;
    this._webhookSecret = opts.webhookSecret ?? null;
    this._userContext = opts.userContext;
    this._target = opts.target ?? this;
  }

  // --- Inputs ---

  get mode(): StripeMode { return this._mode; }
  set mode(value: StripeMode) {
    if (value !== "payment" && value !== "setup") {
      raiseError(`mode must be "payment" or "setup", got ${JSON.stringify(value)}.`);
    }
    this._mode = value;
  }

  get amountValue(): number | null { return this._amountValueHint; }
  set amountValue(value: number | null) {
    if (value === null || value === undefined) {
      this._amountValueHint = null;
      return;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) raiseError(`amountValue must be a non-negative number, got ${value}.`);
    this._amountValueHint = n;
  }

  get amountCurrency(): string | null { return this._amountCurrencyHint; }
  set amountCurrency(value: string | null) {
    this._amountCurrencyHint = value ? String(value) : null;
  }

  get customerId(): string | null { return this._customerId; }
  set customerId(value: string | null) {
    this._customerId = value ? String(value) : null;
  }

  // --- Output state ---

  get status(): StripeStatus { return this._status; }
  get loading(): boolean { return this._loading; }
  get amount(): StripeAmount | null {
    return this._amount ? { ...this._amount } : null;
  }
  get paymentMethod(): StripePaymentMethod | null {
    return this._paymentMethod ? { ...this._paymentMethod } : null;
  }
  get intentId(): string | null { return this._intentId; }
  get error(): StripeError | null { return this._error; }

  // --- Registration API (server-side only) ---

  /**
   * Register the server-side builder that decides amount/currency/customer
   * for incoming intent requests. REQUIRED — `requestIntent` rejects with an
   * `intent_builder_not_registered` error until this is set (SPEC §6.3).
   *
   * This is the single point that converts a tamperable Shell hint into the
   * server's authoritative intent options. Typical usage pulls amount from
   * the cart/order DB keyed by the authenticated UserContext, never from
   * `request.hint.amountValue` directly.
   *
   * Calling twice replaces the prior builder; returns a disposer for the
   * registration. Unlike registerWebhookHandler (which supports multiple
   * handlers per event type), there is only ever one active builder because
   * amount/currency must have a single source of truth.
   */
  registerIntentBuilder(builder: IntentBuilder): () => void {
    if (typeof builder !== "function") raiseError("builder must be a function.");
    this._intentBuilder = builder;
    return () => {
      if (this._intentBuilder === builder) this._intentBuilder = null;
    };
  }

  /**
   * Register a webhook handler for a Stripe event type (e.g.
   * `"payment_intent.succeeded"`). Multiple handlers per type are allowed
   * and run in registration order.
   *
   * `options.fatal` (default `true`): a fatal handler's throw propagates out
   * of `handleWebhook`, so the app's HTTP route returns 5xx and Stripe
   * retries per its delivery policy — the canonical behavior for handlers
   * that gate DB writes (fulfillment, provisioning, refund). `fatal: false`
   * is for ancillary handlers (audit log, notification, telemetry): a throw
   * emits `hawc-stripe:webhook-warning` on the Core's target and the chain
   * continues. Mirrors hawc-s3's registerPostProcess semantics.
   */
  registerWebhookHandler(
    type: string,
    handler: WebhookHandler,
    options: WebhookRegisterOptions = {},
  ): () => void {
    if (!type || typeof type !== "string") raiseError("type must be a non-empty string.");
    if (typeof handler !== "function") raiseError("handler must be a function.");
    const entry = { handler, fatal: options.fatal !== false };
    const list = this._webhookHandlers.get(type) ?? [];
    list.push(entry);
    this._webhookHandlers.set(type, list);
    return () => {
      const current = this._webhookHandlers.get(type);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) this._webhookHandlers.delete(type);
    };
  }

  /**
   * Optional defense-in-depth hook for `resumeIntent`. Runs AFTER the
   * built-in clientSecret check (which is always applied) and BEFORE
   * `_activeIntent` is rebuilt. Returning `false` rejects the resume with
   * a `resume_not_authorized` error.
   *
   * The clientSecret check is Stripe's native authorization model and is
   * on by default — registering an authorizer is for apps that want an
   * additional per-user / per-tenant check on top (e.g. "the intent's
   * `metadata.userId` must equal the authenticated `ctx.sub`").
   *
   * Calling twice replaces the prior authorizer; returns a disposer.
   */
  registerResumeAuthorizer(authorizer: ResumeAuthorizer): () => void {
    if (typeof authorizer !== "function") raiseError("authorizer must be a function.");
    this._resumeAuthorizer = authorizer;
    return () => {
      if (this._resumeAuthorizer === authorizer) this._resumeAuthorizer = null;
    };
  }

  // --- Setters / dispatch ---

  private _setStatus(v: StripeStatus): void {
    if (this._status === v) return;
    this._status = v;
    this._target.dispatchEvent(new CustomEvent("hawc-stripe:status-changed", { detail: v, bubbles: true }));
  }

  private _setLoading(v: boolean): void {
    if (this._loading === v) return;
    this._loading = v;
    this._target.dispatchEvent(new CustomEvent("hawc-stripe:loading-changed", { detail: v, bubbles: true }));
  }

  private _setAmount(a: StripeAmount | null): void {
    this._amount = a;
    this._target.dispatchEvent(new CustomEvent("hawc-stripe:amount-changed", { detail: a ? { ...a } : null, bubbles: true }));
  }

  private _setPaymentMethod(pm: StripePaymentMethod | null): void {
    this._paymentMethod = pm;
    this._target.dispatchEvent(new CustomEvent("hawc-stripe:paymentMethod-changed", { detail: pm ? { ...pm } : null, bubbles: true }));
  }

  private _setIntentId(id: string | null): void {
    this._intentId = id;
    this._target.dispatchEvent(new CustomEvent("hawc-stripe:intentId-changed", { detail: id, bubbles: true }));
  }

  private _setError(err: StripeError | null): void {
    this._error = err;
    this._target.dispatchEvent(new CustomEvent("hawc-stripe:error", { detail: err, bubbles: true }));
  }

  /**
   * Turn anything throwable into a sanitized StripeError. Raw stripe-node
   * errors carry internals (request IDs, stack traces, the HTTP body Stripe
   * returned) that must not cross the WebSocket unredacted — SPEC §9.3.
   *
   * Message-copy policy: the `message` field is only forwarded when the
   * error looks like (a) a Stripe SDK error — `type` starts with "Stripe"
   * (class-name shape: StripeCardError, StripeAPIError, ...) or ends with
   * "_error" (Stripe API object shape: card_error, invalid_request_error,
   * ...) — or (b) one of our own `[@wc-bindable/hawc-stripe]`-prefixed
   * internal errors whose messages are hand-curated. Anything else
   * (IntentBuilder throwing a raw `new Error("DB auth failed for user=...")`,
   * a network-layer exception whose `.message` contains internal hostnames,
   * etc.) is replaced with a generic "Payment failed." so the observable
   * `error` property and the wire-serialized throw do not leak server-side
   * details to the browser. `code` / `decline_code` / `type` are still
   * copied through when present — those are stable Stripe taxonomy values.
   */
  private _sanitizeError(err: unknown): StripeError {
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const type = typeof e.type === "string" ? e.type : undefined;
      const rawMessage = typeof e.message === "string" ? e.message : undefined;
      const stripeShaped = type !== undefined
        && (type.startsWith("Stripe") || type.endsWith("_error"));
      const internal = rawMessage !== undefined
        && rawMessage.startsWith("[@wc-bindable/hawc-stripe]");
      const safeMessage = (stripeShaped || internal) && rawMessage !== undefined
        ? rawMessage
        : "Payment failed.";
      return {
        code: typeof e.code === "string" ? e.code : undefined,
        declineCode: typeof e.decline_code === "string"
          ? e.decline_code
          : typeof e.declineCode === "string" ? e.declineCode : undefined,
        type,
        message: safeMessage,
      };
    }
    return { message: "Payment failed." };
  }

  // --- Commands ---

  /**
   * Create a PaymentIntent or SetupIntent for the Shell to confirm against.
   * Flow:
   *   1. Enforce the IntentBuilder is registered (fail-loud per SPEC §6.3).
   *   2. Invoke the builder with the client hint + UserContext so the app
   *      decides the final amount/currency/customer.
   *   3. Call the provider to actually create the intent at Stripe.
   *   4. Stash the active-intent snapshot, bump the generation counter, and
   *      return `{ intentId, clientSecret, ... }` to the Shell.
   *
   * `status` advances `idle → processing` during the provider call and
   * lands on `collecting` after success so the Shell knows Elements should
   * mount. A failure here surfaces through `_error` and returns status to
   * `idle`.
   */
  async requestIntent(request: IntentRequest): Promise<IntentCreationResult> {
    if (!request || typeof request !== "object") raiseError("request is required.");
    const mode = request.mode ?? this._mode;
    if (mode !== "payment" && mode !== "setup") {
      raiseError(`mode must be "payment" or "setup", got ${JSON.stringify(mode)}.`);
    }
    if (!this._intentBuilder) {
      const err: StripeError = {
        code: "intent_builder_not_registered",
        message: "StripeCore.registerIntentBuilder() must be called before requestIntent.",
      };
      this._setError(err);
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    this._generation++;
    const gen = this._generation;
    this._setError(null);
    this._setLoading(true);
    this._setStatus("processing");
    this._setPaymentMethod(null);

    const hint = request.hint ?? {
      amountValue: this._amountValueHint ?? undefined,
      amountCurrency: this._amountCurrencyHint ?? undefined,
      customerId: this._customerId ?? undefined,
    };

    let built: IntentBuilderResult;
    try {
      built = await this._intentBuilder({ mode, hint }, this._userContext);
    } catch (e: unknown) {
      if (gen === this._generation) {
        this._setError(this._sanitizeError(e));
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw e;
    }

    // Validate the builder returned options matching the requested mode. A
    // cross-mode mismatch would route a PaymentIntent create through the
    // setup path (or vice versa) — a programming error we want to surface
    // loudly rather than silently charging the wrong surface.
    if (built.mode !== mode) {
      const err: StripeError = {
        code: "intent_builder_mode_mismatch",
        message: `IntentBuilder returned mode "${built.mode}" but client requested "${mode}".`,
      };
      if (gen === this._generation) {
        this._setError(err);
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    let creation: IntentCreationResult;
    try {
      if (built.mode === "payment") {
        const { mode: _m, ...options } = built;
        creation = await this._provider.createPaymentIntent(options as PaymentIntentOptions);
      } else {
        const { mode: _m, ...options } = built;
        creation = await this._provider.createSetupIntent(options as SetupIntentOptions);
      }
    } catch (e: unknown) {
      if (gen === this._generation) {
        this._setError(this._sanitizeError(e));
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw e;
    }

    // Superseded mid-flight — user fired another requestIntent while this
    // one was at the provider. Best-effort cancel the orphan PaymentIntent
    // (SetupIntents have no cancel cost beyond a stale row; PaymentIntents
    // reserve the amount against the card's available balance, so we free
    // it) and return the creation result to the caller anyway — the caller
    // is from the superseding request which will see `gen !== _generation`
    // here and know to discard it.
    if (gen !== this._generation) {
      if (creation.mode === "payment") {
        this._provider.cancelPaymentIntent(creation.intentId).catch(() => { /* best-effort */ });
      }
      throw new Error("[@wc-bindable/hawc-stripe] requestIntent superseded.");
    }

    this._activeIntent = { id: creation.intentId, mode, generation: gen };
    this._setIntentId(creation.intentId);
    // amount is only meaningful in payment mode (SPEC §5.1). In setup mode
    // force it to null so a prior payment-mode amount does not bleed through
    // into a subsequent setup session on the same Core.
    this._setAmount(mode === "payment" && creation.amount ? creation.amount : null);
    this._setStatus("collecting");
    this._setLoading(false);
    return creation;
  }

  /**
   * The Shell reports the outcome of `stripe.confirmPayment` / `confirmSetup`.
   * Status transitions follow SPEC §4:
   *   succeeded       → `status = "succeeded"`, paymentMethod populated
   *   processing      → `status = "processing"`, poll the provider to reach
   *                     a terminal state (webhook may be delayed / missing
   *                     in test environments)
   *   requires_action → `status = "requires_action"` (redirect imminent or
   *                     in progress)
   *   failed          → `status = "failed"`, error populated
   *
   * Stale reports (intentId does not match `_activeIntent.id` or the
   * generation has advanced) are dropped silently — the original intent
   * was already superseded and the current one is the source of truth.
   */
  async reportConfirmation(report: ConfirmationReport): Promise<void> {
    if (!report || typeof report !== "object") raiseError("report is required.");
    const active = this._activeIntent;
    if (!active) return; // no active intent — stale/late report, drop.
    if (active.id !== report.intentId) return;
    const gen = active.generation;

    switch (report.outcome) {
      case "succeeded": {
        // A prior failed attempt on the SAME intent (card_declined → retry
        // with another card → success) would otherwise leave the stale
        // `error` populated even as status flips to succeeded. Clear it
        // so the observable surface reflects the terminal truth.
        this._setError(null);
        if (report.paymentMethod) {
          this._setPaymentMethod(report.paymentMethod);
        } else if (!this._paymentMethod) {
          // Stripe.js's `confirmPayment` result frequently returns
          // `payment_method` as a bare id string (not an expanded object),
          // so the Shell cannot populate brand/last4 from the client side
          // alone. Fall back to a server-side retrieve — the provider is
          // expected to expand `payment_method` so we get the card details
          // reliably. Best-effort: if the fetch fails, the webhook path can
          // still fill the slot later.
          try {
            const view = await this._provider.retrieveIntent(active.mode, active.id);
            if (gen !== this._generation) return; // superseded during fetch
            if (view.paymentMethod) this._setPaymentMethod(view.paymentMethod);
          } catch { /* keep pm null; webhook will reconcile later */ }
        }
        this._setStatus("succeeded");
        this._setLoading(false);
        return;
      }
      case "requires_action": {
        this._setStatus("requires_action");
        this._setLoading(false);
        return;
      }
      case "failed": {
        if (report.error) this._setError(report.error);
        this._setStatus("failed");
        this._setLoading(false);
        return;
      }
      case "processing": {
        this._setStatus("processing");
        this._setLoading(true);
        // Poll once now so a terminal state arriving before the webhook does
        // not get wedged. Best-effort: webhook path remains authoritative
        // for the actual DB writes via registered handlers.
        try {
          const view = await this._provider.retrieveIntent(active.mode, active.id);
          if (gen !== this._generation) return; // superseded during await
          this._reconcileFromIntentView(active.mode, view);
        } catch { /* ignore — webhook or next confirmation will resolve */ }
        return;
      }
      default: {
        // Compile-time exhaustiveness check: every union member must be
        // handled by the cases above. The runtime could still carry a
        // value outside the union (malformed cmd payload from a broken
        // client) — surface it in the error message to aid debugging.
        const exhaustive: never = report.outcome;
        raiseError(`unknown outcome: ${JSON.stringify(exhaustive as unknown)}.`);
      }
    }
  }

  /**
   * Fold a fresh intent view back into observable state. Used both by the
   * `processing` polling branch of reportConfirmation and by webhook
   * handlers that want to re-sync after a mutation.
   *
   * Stripe status strings are mapped to our StripeStatus union:
   *   succeeded                          → "succeeded"
   *   requires_action | requires_confirmation | requires_payment_method
   *                                      → "requires_action" / "failed"
   *   processing                         → "processing"
   *   canceled                           → "failed"
   */
  private _reconcileFromIntentView(mode: StripeMode, view: { status: string; amount?: StripeAmount; paymentMethod?: StripePaymentMethod; lastPaymentError?: StripeError }): void {
    if (view.paymentMethod) this._setPaymentMethod(view.paymentMethod);
    // amount is only meaningful in payment mode (SPEC §5.1). Reflect it
    // only for payment-mode views — if a custom provider returns amount on
    // a setup intent view, drop it rather than leak it through the bindable
    // surface. Symmetric with the amount-clear in `requestIntent`.
    if (mode === "payment") {
      if (view.amount) this._setAmount(view.amount);
    } else if (this._amount !== null) {
      this._setAmount(null);
    }
    switch (view.status) {
      case "succeeded":
        // Mirror the clear in reportConfirmation's direct succeeded
        // branch and the webhook succeeded fold — reach here through
        // the reportConfirmation-processing-poll or resumeIntent paths
        // with a terminal "succeeded" view, so any lingering error
        // from a prior failed attempt on the same intent must be
        // dropped. Without this, a fail-then-processing-then-succeeded
        // sequence ends with status=succeeded + error=card_declined.
        this._setError(null);
        this._setStatus("succeeded");
        this._setLoading(false);
        break;
      case "requires_action":
      case "requires_confirmation":
        this._setStatus("requires_action");
        this._setLoading(false);
        break;
      case "processing":
        this._setStatus("processing");
        break;
      case "requires_payment_method":
        if (view.lastPaymentError) this._setError(view.lastPaymentError);
        this._setStatus("failed");
        this._setLoading(false);
        break;
      case "canceled":
        // Stripe keeps `last_payment_error` / `last_setup_error` on the
        // canceled intent when cancellation followed a failed attempt
        // (declined card, authentication fail, etc). Surface it so UI
        // can show *why* — otherwise the caller only sees a silent
        // `failed`. Symmetric with requires_payment_method above.
        if (view.lastPaymentError) this._setError(view.lastPaymentError);
        this._setStatus("failed");
        this._setLoading(false);
        break;
      // default: leave status unchanged (unrecognized Stripe status string).
    }
  }

  /**
   * Cancel the active PaymentIntent. SetupIntents are not cancellable via
   * the Stripe API (they expire naturally) — we transition the Core to
   * `idle` without a provider call.
   *
   * Bumps the generation so any in-flight confirmation report or webhook
   * update from the canceled intent is dropped by the `gen !== ...` guards
   * elsewhere.
   */
  async cancelIntent(intentId: string): Promise<void> {
    if (!intentId) raiseError("intentId is required.");
    const active = this._activeIntent;
    if (!active) return;
    if (active.id !== intentId) {
      raiseError(`cancelIntent id mismatch: expected ${active.id}, got ${intentId}.`);
    }
    // Snapshot the generation for a post-await supersede check. If a
    // key-change or other caller starts a fresh `requestIntent()` while
    // we are parked on the cancel network call, the replacement session
    // will have bumped `_generation` and rebuilt `_activeIntent`. Blindly
    // proceeding with the state-clear below would then wipe the NEW
    // session's intentId / amount / paymentMethod / status. Compare
    // generations after the await and bail if they no longer match.
    const activeGen = active.generation;
    if (active.mode === "payment") {
      try {
        // Keep `_activeIntent` and the current generation set while the
        // provider call is in flight — if Stripe rejects the cancel (network
        // error, intent already in a non-cancelable state), we surface the
        // error and leave ownership intact so the caller can retry or react
        // to incoming reports/webhooks for the same intent. Clearing state
        // before the await would zombify the intent: retries would hit the
        // `if (!active) return;` early-out and webhooks would stop folding.
        await this._provider.cancelPaymentIntent(intentId);
      } catch (e: unknown) {
        // Only surface the error if THIS cancel still owns the session.
        // If another requestIntent / reset has already taken over, the
        // user-visible truth is the new session, not our dead intent.
        if (this._activeIntent?.generation === activeGen) {
          this._setError(this._sanitizeError(e));
        }
        throw e;
      }
    }
    if (this._activeIntent?.generation !== activeGen) {
      // Superseded during the cancel await — a fresh session owns the
      // surface now. Do NOT clobber its state. The pi_OLD cancel did
      // happen at Stripe (that is what we requested), but the Core-side
      // lifecycle reset belongs to whoever now holds `_activeIntent`.
      return;
    }
    this._generation++;
    this._activeIntent = null;
    // Clear any error left over from a prior failed cancel attempt on this
    // same intent — on the success path the terminal state must be a clean
    // idle, mirroring requestIntent / resumeIntent / reset.
    this._setError(null);
    this._setStatus("idle");
    this._setLoading(false);
    this._setPaymentMethod(null);
    this._setIntentId(null);
    this._setAmount(null);
  }

  /**
   * Re-hydrate observable state from a 3DS redirect return. The Shell
   * reads the intent id AND Stripe-issued `client_secret` from the URL
   * (Stripe always puts both in `return_url`) and passes both through.
   *
   * Authorization model (default-secure — rejects by default):
   *
   *   1. **clientSecret check (always on).** The Core retrieves the
   *      intent server-side (authoritative, signed with the secret key)
   *      and rejects unless the caller-supplied `clientSecret` equals
   *      `intent.client_secret`. This is the same authorization Stripe
   *      itself uses for `stripe.retrievePaymentIntent(clientSecret)`:
   *      knowledge of the clientSecret is the evidence-of-ownership
   *      token. An attacker knowing only `pi_xxx` cannot resume.
   *
   *   2. **registerResumeAuthorizer (optional, additional).** For apps
   *      that want layered enforcement — e.g. "intent.metadata.userId
   *      must equal ctx.sub" — a custom authorizer is consulted after
   *      clientSecret match succeeds and before `_activeIntent` is
   *      rebuilt. Returning false rejects the resume.
   *
   * On successful authorization, `_activeIntent` is rebuilt so subsequent
   * `reportConfirmation` / `cancelIntent` / webhook events for this
   * intent flow normally. On any failure, `_activeIntent` is NOT touched
   * and observable state returns to `idle` with a sanitized error.
   *
   * The caller-supplied clientSecret is never stored — it is consumed
   * once for comparison and discarded. The SPEC §5.2 non-exposure
   * invariant (clientSecret not on the bindable surface, not in any
   * CustomEvent detail, not reflected to an attribute) remains intact.
   */
  async resumeIntent(intentId: string, mode: StripeMode, clientSecret: string): Promise<void> {
    if (!intentId) raiseError("intentId is required.");
    if (mode !== "payment" && mode !== "setup") {
      raiseError(`mode must be "payment" or "setup", got ${JSON.stringify(mode)}.`);
    }
    if (!clientSecret || typeof clientSecret !== "string") {
      // Reject before touching state — this path only fires when the
      // Shell's URL parsing yields an id without the matching secret,
      // which Stripe's redirect never does. A bare id without the
      // secret is almost certainly a tampered URL and must not grant
      // access to any intent.
      raiseError("clientSecret is required for resumeIntent (default-secure authorization).");
    }

    this._generation++;
    const gen = this._generation;
    this._setError(null);
    this._setLoading(true);

    let view;
    try {
      view = await this._provider.retrieveIntent(mode, intentId);
    } catch (e: unknown) {
      if (gen === this._generation) {
        this._setError(this._sanitizeError(e));
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw e;
    }

    if (gen !== this._generation) return; // superseded mid-flight

    // Ownership check. `view.clientSecret` is Stripe's authoritative value
    // for the intent; the caller must have been handed that same string by
    // Stripe's redirect URL. Any mismatch (tampered URL, foreign intent id,
    // provider that forgot to populate clientSecret) is a hard reject.
    if (!view.clientSecret || view.clientSecret !== clientSecret) {
      const err: StripeError = {
        code: "resume_client_secret_mismatch",
        message: "clientSecret does not match the retrieved intent — resume denied.",
      };
      this._setError(err);
      this._setStatus("idle");
      this._setLoading(false);
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    // Optional defense-in-depth.
    if (this._resumeAuthorizer) {
      let ok: boolean;
      let authorizerThrew: unknown = null;
      try {
        ok = await this._resumeAuthorizer(intentId, mode, view, this._userContext);
      } catch (e: unknown) {
        // Authorizer threw. Normalize to the same `resume_not_authorized`
        // denial path as an explicit `false` return — a thrown authorizer
        // must not (a) grant access, nor (b) leak its raw exception
        // across the wire, where stack traces, DB error messages, and ACL
        // lookup internals would otherwise reach the Shell and any
        // observable subscriber. The original error is observable
        // server-side via the `hawc-stripe:authorizer-error` event on
        // this Core's target (operators can log it there) — it just does
        // not cross the remote boundary.
        authorizerThrew = e;
        ok = false;
      }
      if (!ok) {
        if (authorizerThrew !== null) {
          // Emit the raw exception on the Core's EventTarget for
          // server-side operator observability. Symmetric with
          // `hawc-stripe:webhook-warning` for non-fatal webhook handler
          // failures.
          this._target.dispatchEvent(new CustomEvent("hawc-stripe:authorizer-error", {
            detail: { error: authorizerThrew, intentId, mode },
            bubbles: true,
          }));
        }
        const err: StripeError = {
          code: "resume_not_authorized",
          message: "resume rejected by registered authorizer.",
        };
        if (gen === this._generation) {
          this._setError(err);
          this._setStatus("idle");
          this._setLoading(false);
        }
        throw Object.assign(new Error(err.message), { code: err.code });
      }
    }

    if (gen !== this._generation) return; // superseded during authorize

    this._activeIntent = { id: intentId, mode, generation: gen };
    this._setIntentId(intentId);
    this._reconcileFromIntentView(mode, view);
    // Terminal of the resume call — flip loading off only if the
    // reconciled status is not "processing". A 3DS redirect can land
    // while Stripe is still asynchronously finalizing the charge
    // (`intent.status === "processing"`), and `_reconcileFromIntentView`
    // deliberately keeps `loading = true` in that branch so the UI
    // spinner bridges the processing → succeeded/failed transition
    // delivered via webhook. Unconditionally clearing loading here
    // would drop the spinner mid-flight and make a still-in-progress
    // charge look idle.
    if (this._status !== "processing") {
      this._setLoading(false);
    }
  }

  /**
   * Return to a clean idle state. Does not talk to Stripe — `cancelIntent`
   * is the network-cancel path. Used by the Shell when Elements is
   * unmounted/remounted for a second attempt after failure, or by the app
   * when the component is reused for a new transaction.
   */
  reset(): void {
    this._generation++;
    this._activeIntent = null;
    this._setError(null);
    this._setPaymentMethod(null);
    this._setIntentId(null);
    this._setAmount(null);
    this._setStatus("idle");
    this._setLoading(false);
  }

  // --- Webhook ingress ---

  /**
   * Called from the app's HTTP route that receives Stripe webhooks. Verifies
   * the signature header against the webhook signing secret, dispatches the
   * parsed event to registered handlers, and folds common `payment_intent.*`
   * / `setup_intent.*` events back into observable state so subscribed Shells
   * see the terminal status without a round-trip through the client.
   *
   * `rawBody` must be the exact bytes Stripe POSTed — pass the string before
   * any JSON parse / re-serialize, because signature verification includes
   * a HMAC over the raw payload. SPEC §9.3 ("Webhook endpoint の raw body
   * 保全").
   */
  async handleWebhook(rawBody: string, signatureHeader: string): Promise<void> {
    if (!this._webhookSecret) {
      raiseError("handleWebhook called but StripeCore was constructed without webhookSecret.");
    }
    if (typeof rawBody !== "string") raiseError("rawBody must be a string.");
    if (!signatureHeader) raiseError("signatureHeader is required.");

    let event: StripeEvent;
    try {
      event = this._provider.verifyWebhook(rawBody, signatureHeader, this._webhookSecret);
    } catch (e: unknown) {
      // Signature verification failure must propagate so the HTTP route
      // returns 4xx and Stripe does not keep retrying a payload we cannot
      // trust. Do NOT sanitize into `this._error` — a forged request should
      // not mutate our observable state.
      throw e;
    }

    // Reflect common event types into observable state. Only the currently-
    // active intent is folded in; events for other intents (different user,
    // old session) pass through to handlers but do not move UI state.
    await this._foldWebhookIntoState(event);

    // Dispatch to registered handlers. Fatal/non-fatal semantics mirror
    // hawc-s3's registerPostProcess. Run sequentially so a fatal throw
    // aborts the chain deterministically and the HTTP route sees the
    // rejection before Stripe considers the webhook delivered.
    const handlers = this._webhookHandlers.get(event.type);
    if (!handlers || handlers.length === 0) return;
    for (const entry of handlers) {
      try {
        await entry.handler(event);
      } catch (e: unknown) {
        if (entry.fatal) throw e;
        this._target.dispatchEvent(new CustomEvent("hawc-stripe:webhook-warning", {
          detail: { error: e, event },
          bubbles: true,
        }));
      }
    }
  }

  private async _foldWebhookIntoState(event: StripeEvent): Promise<void> {
    const active = this._activeIntent;
    if (!active) return;
    const obj = event.data?.object as Record<string, unknown> | undefined;
    const objId = obj && typeof obj.id === "string" ? obj.id : undefined;
    if (!objId || objId !== active.id) return;
    // Snapshot the generation at entry. Any branch below that awaits must
    // re-check this before mutating observable state — otherwise a
    // concurrent `reset()` / new `requestIntent()` during the await would
    // let the old intent's pm / status / error bleed into the new
    // session's UI. Same discipline `reportConfirmation` already uses.
    const gen = active.generation;

    switch (event.type) {
      case "payment_intent.succeeded":
      case "setup_intent.succeeded": {
        // If reportConfirmation's succeeded branch failed to populate
        // paymentMethod (transient retrieve error, Stripe.js returned a
        // bare pm id, etc.) or was never invoked (pure webhook-driven
        // path), recover here. Prefer the webhook event's payload —
        // Stripe sometimes expands `payment_method` on specific webhook
        // types — then fall back to a fresh server-side retrieve. This
        // is the last-chance fill described in SPEC §6.4.
        if (!this._paymentMethod && obj) {
          const pmFromEvent = this._extractPaymentMethodFromObject(obj);
          if (pmFromEvent) {
            this._setPaymentMethod(pmFromEvent);
          } else {
            try {
              const view = await this._provider.retrieveIntent(active.mode, active.id);
              // Supersede guard: the only await in this fold method.
              // Without this check, a stale retrieve landing after
              // `reset()` + new `requestIntent()` would paint pi_OLD's
              // card onto pi_NEW's observable state.
              if (gen !== this._generation) return;
              if (view.paymentMethod) this._setPaymentMethod(view.paymentMethod);
            } catch {
              /* best-effort. Fall through — but the guard below still
                 covers the case where generation advanced DURING the
                 failed retrieve. */
            }
          }
        }
        // Generation may have advanced either during the retrieve await
        // (handled above) or while we were parked before reaching this
        // line. Re-check before flipping status / loading so we do not
        // stamp "succeeded" onto a new session that is currently
        // mid-prepare.
        if (gen !== this._generation) return;
        // Clear any lingering failure (e.g. a prior card_declined from
        // a retried attempt on the same intent) so the terminal
        // observable surface matches the success.
        this._setError(null);
        this._setStatus("succeeded");
        this._setLoading(false);
        break;
      }
      case "payment_intent.payment_failed":
      case "setup_intent.setup_failed": {
        const le = obj!.last_payment_error ?? obj!.last_setup_error;
        if (le) this._setError(this._sanitizeError(le));
        this._setStatus("failed");
        this._setLoading(false);
        break;
      }
      case "payment_intent.requires_action":
      case "setup_intent.requires_action":
        this._setStatus("requires_action");
        // Mirror reportConfirmation's requires_action branch: the
        // user is now owning the flow (3DS challenge, redirect, etc),
        // so the server-side "busy" flag must clear — otherwise a
        // session that was `loading=true` during processing stays
        // stuck on the spinner even though the UI should be showing
        // the challenge.
        this._setLoading(false);
        break;
      case "payment_intent.processing":
      case "setup_intent.processing":
        this._setStatus("processing");
        this._setLoading(true);
        break;
      case "payment_intent.canceled":
      case "setup_intent.canceled": {
        // Mirror the payment_failed / setup_failed branch above — a
        // canceled intent can carry `last_payment_error` / `last_setup_
        // error` that explains why (declined attempt that preceded the
        // cancel, for example). Without this, cancellation-by-failure
        // arrives on the Shell as a silent "failed" with no diagnostic.
        const le = obj!.last_payment_error ?? obj!.last_setup_error;
        if (le) this._setError(this._sanitizeError(le));
        this._setStatus("failed");
        this._setLoading(false);
        break;
      }
    }
  }

  /**
   * Extract a minimal PaymentMethod view from a Stripe object (typically
   * a PaymentIntent / SetupIntent from a webhook payload or a provider
   * retrieve). Only returns a value when `payment_method` is expanded
   * AND has a card. Non-card / non-expanded returns undefined so the
   * caller can decide whether to try another channel.
   *
   * Mirrors the extractor in `StripeSdkProvider` — kept inline here so
   * the Core does not have to depend on the provider's helpers.
   */
  private _extractPaymentMethodFromObject(obj: Record<string, unknown>): StripePaymentMethod | undefined {
    const pm = obj.payment_method;
    if (pm && typeof pm === "object") {
      const pmObj = pm as Record<string, unknown>;
      const card = pmObj.card;
      if (card && typeof card === "object") {
        const c = card as Record<string, unknown>;
        const id = typeof pmObj.id === "string" ? pmObj.id : "";
        const brand = typeof c.brand === "string" ? c.brand : "";
        const last4 = typeof c.last4 === "string" ? c.last4 : "";
        if (id) return { id, brand, last4 };
      }
    }
    return undefined;
  }
}
