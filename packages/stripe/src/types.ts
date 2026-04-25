export interface ITagNames {
  readonly stripe: string;
}

export interface IWritableTagNames {
  stripe?: string;
}

export interface IRemoteConfig {
  readonly enableRemote: boolean;
  readonly remoteSettingType: "env" | "config";
  readonly remoteCoreUrl: string;
}

export interface IWritableRemoteConfig {
  enableRemote?: boolean;
  remoteSettingType?: "env" | "config";
  remoteCoreUrl?: string;
}

export interface IConfig {
  readonly tagNames: ITagNames;
  readonly remote: IRemoteConfig;
}

export interface IWritableConfig {
  tagNames?: IWritableTagNames;
  remote?: IWritableRemoteConfig;
}

export interface IWcBindableProperty {
  readonly name: string;
  readonly event: string;
  readonly getter?: (event: Event) => unknown;
}

export interface IWcBindableInput {
  readonly name: string;
  readonly attribute?: string;
}

export interface IWcBindableCommand {
  readonly name: string;
  readonly async?: boolean;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: 1;
  readonly properties: IWcBindableProperty[];
  readonly inputs?: IWcBindableInput[];
  readonly commands?: IWcBindableCommand[];
}

/**
 * Stripe intent mode. `payment` drives PaymentIntent (immediate charge);
 * `setup` drives SetupIntent (save a card for future off-session use).
 */
export type StripeMode = "payment" | "setup";

/**
 * Observable status. Covers the full lifecycle from "no intent yet" through
 * redirect-based 3DS challenges back to terminal success/failure.
 *   idle             — no intent in flight; Elements not yet mounted
 *   collecting       — Elements mounted, user entering card details
 *   processing       — confirmPayment/Setup in flight OR awaiting webhook
 *   requires_action  — 3DS redirect pending (Stripe returned next_action.type)
 *   succeeded        — PaymentIntent/SetupIntent reached a success terminal
 *   failed           — Stripe returned a failure, or client-side confirm threw
 */
export type StripeStatus =
  | "idle"
  | "collecting"
  | "processing"
  | "requires_action"
  | "succeeded"
  | "failed";

/**
 * User-facing amount snapshot. Mirrors Stripe's representation: `value` is the
 * smallest currency unit (cents for USD, yen for JPY) and `currency` is a
 * three-letter ISO code. Null until the Core's IntentBuilder returns one.
 */
export interface StripeAmount {
  value: number;
  currency: string;
}

/**
 * Observable paymentMethod info after a successful intent. Deliberately a
 * minimal view — no card number, no CVC, no expiry, no raw PaymentMethod
 * object. Brand/last4 are the parts safe to render in UI (e.g. "Visa •• 4242")
 * and `id` is the pm_... reference the application can pass to future
 * off-session charges via the server.
 */
export interface StripePaymentMethod {
  id: string;
  brand: string;
  last4: string;
}

/**
 * Sanitized error shape handed to the Shell and over the wire. `code` /
 * `declineCode` are the Stripe error taxonomy values (stable, safe to render);
 * `message` is user-facing and intentionally terse — do not stuff raw Stripe
 * SDK errors into this slot, because they cross the WebSocket unredacted.
 */
export interface StripeError {
  code?: string;
  declineCode?: string;
  message: string;
  type?: string;
}

/**
 * Hint the Shell passes up with a requestIntent call. Treated as advisory —
 * the server-side IntentBuilder is the source of truth for amount/currency/
 * customer, because anything Shell-supplied can be tampered with in the
 * browser.
 */
export interface IntentRequestHint {
  amountValue?: number;
  amountCurrency?: string;
  customerId?: string;
}

/**
 * Request object fed to the IntentBuilder. Carries the hint plus the mode so
 * one builder can branch between PaymentIntent and SetupIntent without the
 * application having to register two.
 */
export interface IntentRequest {
  mode: StripeMode;
  hint: IntentRequestHint;
}

/**
 * Minimal subset of Stripe's PaymentIntent create params we expose to the
 * IntentBuilder return value. A fuller binding is delegated to the
 * IStripeProvider — this type just names the fields the Core needs to route
 * through to `stripe.paymentIntents.create()`.
 */
export interface PaymentIntentOptions {
  amount: number;
  currency: string;
  customer?: string;
  description?: string;
  metadata?: Record<string, string>;
  receipt_email?: string;
  setup_future_usage?: "on_session" | "off_session";
  statement_descriptor?: string;
  statement_descriptor_suffix?: string;
  capture_method?: "automatic" | "manual";
  payment_method_types?: string[];
  automatic_payment_methods?: { enabled: boolean; allow_redirects?: "always" | "never" };
  // Permit Stripe create-param pass-through (e.g. Connect fields such as
  // application_fee_amount / transfer_data) while keeping common keys typed.
  [key: string]: unknown;
}

export interface SetupIntentOptions {
  customer?: string;
  description?: string;
  metadata?: Record<string, string>;
  usage?: "on_session" | "off_session";
  payment_method_types?: string[];
  automatic_payment_methods?: { enabled: boolean; allow_redirects?: "always" | "never" };
  // Permit additional Stripe SetupIntent create params from IntentBuilder.
  [key: string]: unknown;
}

export type IntentBuilderResult =
  | ({ mode: "payment" } & PaymentIntentOptions)
  | ({ mode: "setup" } & SetupIntentOptions);

/**
 * Server-side builder that turns a client hint + authenticated user context
 * into the final intent options. Required — the Core refuses `requestIntent`
 * RPCs until one is registered. See SPEC.md §6.3 for fail-loud rationale.
 */
export type IntentBuilder = (
  request: IntentRequest,
  ctx: UserContext | undefined,
) => IntentBuilderResult | Promise<IntentBuilderResult>;

/**
 * The shape handed to the IntentBuilder and webhook handlers. Opaque on
 * purpose: apps plug in whatever their auth layer produces
 * (`{ sub, email, permissions[] }`, a Drizzle/Prisma user row, etc.). Typed
 * as `unknown` upstream and narrowed by the app — stripe-checkout does not read
 * it, so we do not force a schema.
 */
export type UserContext = Record<string, unknown>;

/**
 * Result of intent creation, returned to the Shell's requestIntent call.
 * `clientSecret` is needed by Stripe.js to drive the Elements confirmation
 * and never appears in observable state (see SPEC §5.2).
 */
export interface IntentCreationResult {
  intentId: string;
  clientSecret: string;
  mode: StripeMode;
  amount?: StripeAmount;
}

/**
 * Outcome reported back by the Shell after `stripe.confirmPayment` /
 * `stripe.confirmSetup` resolves. Drives the Core's `status` transitions and
 * lets the Core observe terminal states even if the webhook has not yet
 * arrived (webhooks may lag seconds to minutes behind the client).
 *
 * `error` is provided when Stripe returns an error from confirmation —
 * re-sanitized by the Shell before crossing the wire so we do not leak raw
 * SDK internals.
 */
export interface ConfirmationReport {
  intentId: string;
  outcome: "succeeded" | "requires_action" | "processing" | "failed";
  paymentMethod?: StripePaymentMethod;
  error?: StripeError;
}

/**
 * Narrow view of Stripe's Webhook event. `data.object` is opaque here —
 * apps downcast in their registered handler. Kept minimal so stripe-checkout does
 * not pin itself to a specific stripe-node version's type surface.
 */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  created: number;
}

/**
 * Thin view of a PaymentIntent/SetupIntent for Core-internal polling after
 * a 3DS redirect. The Core calls `retrieveIntent` when the Shell reports
 * `outcome: "processing"` to resolve the terminal state without waiting on
 * the webhook.
 */
export interface StripeIntentView {
  id: string;
  status: string;
  mode: StripeMode;
  amount?: StripeAmount;
  paymentMethod?: StripePaymentMethod;
  lastPaymentError?: StripeError;
  /**
   * @internal
   * Stripe-issued `client_secret` for the intent. Populated by the
   * provider so `StripeCore.resumeIntent` can verify the caller knows the
   * secret before trusting the supplied `intentId` — this is how Stripe
   * itself authorizes `stripe.retrievePaymentIntent(clientSecret)` on the
   * client side.
   *
   * Consumers of this type MUST NOT propagate the value onto observable
   * state, the wcBindable bindable surface, any `CustomEvent.detail`, any
   * attribute, dataset entry, or log sink. The Core reads it exactly once
   * for comparison and discards it; no other subsystem has a reason to.
   */
  clientSecret?: string;
}

/**
 * Optional defense-in-depth hook, registered via
 * `StripeCore.registerResumeAuthorizer`. Called AFTER the Core has verified
 * the caller-supplied `clientSecret` matches the Stripe-issued value on the
 * retrieved intent, but BEFORE `_activeIntent` is rebuilt. Returning
 * `false` (or a Promise resolving to `false`) rejects the resume with a
 * `resume_not_authorized` error.
 *
 * Typical use: enforce that `intentView.metadata.userId === ctx.sub`, or
 * that the intent's customer field matches the authenticated user. The
 * clientSecret check alone is Stripe's native authorization model and is
 * sufficient in most cases — this hook is for apps that want layered
 * enforcement (metadata-based ACLs, tenant isolation, etc.).
 */
export type ResumeAuthorizer = (
  intentId: string,
  mode: StripeMode,
  intentView: StripeIntentView,
  ctx: UserContext | undefined,
) => boolean | Promise<boolean>;

/**
 * Provider abstraction. The Core never imports `stripe` directly — the
 * default `StripeSdkProvider` wraps stripe-node and implements this
 * interface. Tests inject a mock provider; that is the main motivation for
 * keeping this seam even though we have no second provider in v1.
 */
export interface IStripeProvider {
  createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult>;
  createSetupIntent(opts: SetupIntentOptions): Promise<IntentCreationResult>;
  retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView>;
  cancelPaymentIntent(id: string): Promise<void>;
  cancelSetupIntent?(id: string): Promise<void>;
  verifyWebhook(rawBody: string | Buffer | Uint8Array, signatureHeader: string, secret: string): StripeEvent;
}

export type WebhookHandler = (event: StripeEvent) => Promise<void> | void;

/**
 * Options for `StripeCore.registerWebhookHandler`.
 *
 * `fatal` (default `true`) controls what happens when the hook throws. A
 * fatal throw propagates out of `handleWebhook`, so the app's HTTP route
 * returns 5xx and Stripe retries per its delivery policy. Non-fatal hooks
 * (`fatal: false`) survive their own throw — the failure is surfaced via
 * a `stripe-checkout:webhook-warning` event on the Core's target and the chain
 * continues. Mirrors s3-uploader's registerPostProcess fatal semantics.
 */
export interface WebhookRegisterOptions {
  fatal?: boolean;
}

/**
 * Observable state emitted by StripeCore.
 */
export interface WcsStripeCoreValues {
  status: StripeStatus;
  loading: boolean;
  amount: StripeAmount | null;
  paymentMethod: StripePaymentMethod | null;
  intentId: string | null;
  error: StripeError | null;
}

/**
 * Element-facing values. Adds `trigger` so declarative frameworks can
 * imperatively fire `submit()` via a reactive boolean (mirrors s3-uploader).
 */
export interface WcsStripeValues extends WcsStripeCoreValues {
  trigger: boolean;
}

/**
 * Detail payload for `stripe-checkout:unknown-status` events.
 *
 * Fires from three sites — all three share this shape so listeners can
 * branch on `source` without having to probe for differently-named fields:
 *
 * - `source: "core"` — Core's `_reconcileFromIntentView` saw a Stripe
 *   status outside the known union (e.g. a newly introduced value). The
 *   observable status is left unchanged; the webhook path remains the
 *   authority.
 * - `source: "shell-confirm"` — Shell's `_applyIntentOutcome` saw a
 *   Stripe.js confirm result with an unknown `status`. Shell reports
 *   `outcome: "processing"` to the Core so webhook can resolve terminal
 *   state.
 * - `source: "shell-malformed"` — Stripe.js returned a result with
 *   neither `paymentIntent` / `setupIntent` nor `error`. Shell reports
 *   `outcome: "processing"` with `reason` set so an operator can trace
 *   back to the broken Stripe.js response.
 *
 * `intentId` can be null on the core path if the Core has no
 * `_activeIntent` at dispatch time. `status` is the raw string Stripe
 * returned, or `""` for the shell-malformed path. `reason` is optional,
 * set only when there is additional diagnostic context beyond `status`.
 */
export interface UnknownStatusDetail {
  source: "core" | "shell-confirm" | "shell-malformed";
  intentId: string | null;
  mode: StripeMode;
  status: string;
  reason?: string;
}
