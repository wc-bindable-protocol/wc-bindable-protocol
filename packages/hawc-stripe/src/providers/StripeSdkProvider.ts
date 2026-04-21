import {
  IStripeProvider, IntentCreationResult, PaymentIntentOptions, SetupIntentOptions,
  StripeMode, StripeIntentView, StripeEvent, StripeAmount, StripePaymentMethod, StripeError,
} from "../types.js";
import { raiseError } from "../raiseError.js";

/**
 * Minimal structural view of the subset of the `stripe` (stripe-node) package
 * surface this provider needs. Typed here rather than imported from the
 * `stripe` package so the `stripe` peer dependency stays optional — apps
 * that supply their own provider (e.g. a mock in tests) do not need stripe
 * installed at all.
 *
 * A real stripe-node client fits this shape structurally; the constructor
 * also accepts a plain object for tests.
 */
export interface StripeNodeLike {
  paymentIntents: {
    create(params: Record<string, unknown>): Promise<Record<string, unknown>>;
    retrieve(id: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    cancel(id: string): Promise<Record<string, unknown>>;
  };
  setupIntents: {
    create(params: Record<string, unknown>): Promise<Record<string, unknown>>;
    retrieve(id: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * Present on real stripe-node clients but optional here so tests/mocks
     * are not forced to implement it. The default StripeCore policy
     * intentionally does not call SetupIntent cancel (cost optimization);
     * apps that want explicit cleanup can implement it in a custom provider.
     */
    cancel?(id: string): Promise<Record<string, unknown>>;
  };
  webhooks: {
    constructEvent(payload: string, header: string, secret: string): Record<string, unknown>;
  };
}

function extractAmount(obj: Record<string, unknown>): StripeAmount | undefined {
  const value = obj.amount;
  const currency = obj.currency;
  if (typeof value === "number" && typeof currency === "string") {
    return { value, currency };
  }
  return undefined;
}

function extractPaymentMethod(obj: Record<string, unknown>): StripePaymentMethod | undefined {
  const pm = obj.payment_method;
  // Expanded PaymentMethod object (when the caller used `?expand[]=payment_method`).
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

function extractLastPaymentError(obj: Record<string, unknown>): StripeError | undefined {
  const err = obj.last_payment_error ?? obj.last_setup_error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      declineCode: typeof e.decline_code === "string" ? e.decline_code : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
      message: typeof e.message === "string" ? e.message : "Payment failed.",
    };
  }
  return undefined;
}

/**
 * Default `IStripeProvider` implementation backed by the `stripe` (node)
 * package. Holds the secret key indirectly — the app passes a constructed
 * `Stripe` client into the constructor, so the secret lives in exactly one
 * place (the client) and this provider is just an adapter.
 *
 * Apps that need custom behavior (e.g. injecting `idempotency_key` per
 * request, routing to a mock in tests, switching accounts per tenant) can
 * either wrap this provider or implement `IStripeProvider` directly — the
 * Core never imports `stripe` itself, so there is no hidden coupling.
 */
export class StripeSdkProvider implements IStripeProvider {
  private _client: StripeNodeLike;

  constructor(client: StripeNodeLike) {
    if (!client) raiseError("stripe client is required.");
    this._client = client;
  }

  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
      raiseError(`amount must be a positive number, got ${opts.amount}.`);
    }
    if (!opts.currency) raiseError("currency is required.");
    // Default to automatic_payment_methods when the caller did not opt out —
    // it is Stripe's recommended path and it supports the widest range of
    // Elements-based confirmation flows without the app having to enumerate
    // payment_method_types.
    const params: Record<string, unknown> = { ...opts };
    if (params.automatic_payment_methods === undefined && params.payment_method_types === undefined) {
      params.automatic_payment_methods = { enabled: true };
    }
    const result = await this._client.paymentIntents.create(params);
    const id = typeof result.id === "string" ? result.id : "";
    const clientSecret = typeof result.client_secret === "string" ? result.client_secret : "";
    if (!id || !clientSecret) {
      raiseError("stripe.paymentIntents.create returned no id/client_secret.");
    }
    return {
      intentId: id,
      clientSecret,
      mode: "payment",
      amount: extractAmount(result),
    };
  }

  async createSetupIntent(opts: SetupIntentOptions): Promise<IntentCreationResult> {
    const params: Record<string, unknown> = { ...opts };
    if (params.automatic_payment_methods === undefined && params.payment_method_types === undefined) {
      params.automatic_payment_methods = { enabled: true };
    }
    const result = await this._client.setupIntents.create(params);
    const id = typeof result.id === "string" ? result.id : "";
    const clientSecret = typeof result.client_secret === "string" ? result.client_secret : "";
    if (!id || !clientSecret) {
      raiseError("stripe.setupIntents.create returned no id/client_secret.");
    }
    return {
      intentId: id,
      clientSecret,
      mode: "setup",
    };
  }

  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    if (!id) raiseError("id is required.");
    // Expand `payment_method` so brand / last4 are present in the response.
    // Without this, Stripe returns `payment_method` as a bare id string and
    // we cannot surface card details to the UI without a second round-trip.
    // The Core's succeeded-branch paymentMethod fallback relies on this
    // returning expanded data (SPEC §5.1 paymentMethod contract).
    const opts = { expand: ["payment_method"] };
    const result = mode === "payment"
      ? await this._client.paymentIntents.retrieve(id, opts)
      : await this._client.setupIntents.retrieve(id, opts);
    return {
      id: typeof result.id === "string" ? result.id : id,
      status: typeof result.status === "string" ? result.status : "unknown",
      mode,
      amount: extractAmount(result),
      paymentMethod: extractPaymentMethod(result),
      lastPaymentError: extractLastPaymentError(result),
      // Stripe's PaymentIntent/SetupIntent retrieve returns `client_secret`
      // on every call. The Core uses it exclusively to validate that a
      // resume call (from a post-3DS URL) actually knows the secret —
      // never stored, never emitted. See StripeIntentView.clientSecret.
      clientSecret: typeof result.client_secret === "string" ? result.client_secret : undefined,
    };
  }

  async cancelPaymentIntent(id: string): Promise<void> {
    if (!id) raiseError("id is required.");
    await this._client.paymentIntents.cancel(id);
  }

  verifyWebhook(rawBody: string, signatureHeader: string, secret: string): StripeEvent {
    // Delegates to stripe-node's constructEvent, which performs the HMAC-SHA256
    // over the raw body + timestamp check. It throws on failure — we let the
    // throw propagate so StripeCore.handleWebhook returns the error to the
    // HTTP route unchanged (4xx → Stripe stops retrying a forged request).
    const event = this._client.webhooks.constructEvent(rawBody, signatureHeader, secret);
    return {
      id: typeof event.id === "string" ? event.id : "",
      type: typeof event.type === "string" ? event.type : "",
      data: (event.data as { object: Record<string, unknown> }) ?? { object: {} },
      created: typeof event.created === "number" ? event.created : 0,
    };
  }
}
