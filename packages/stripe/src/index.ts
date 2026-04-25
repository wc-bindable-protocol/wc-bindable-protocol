// Browser-facing barrel. DO NOT re-export `StripeCore` / `StripeSdkProvider`
// here — those belong to the `/server` subpath so Node consumers reach them
// without going through the browser-shaped surface. `components/Stripe.js`
// contains the `<stripe-checkout>` Custom Element and guards its `HTMLElement`
// base with a `typeof` fallback so *this* barrel stays evaluable under
// plain Node (SSR pre-render, test pre-scanners, bundler graph walks); the
// fallback does not make the component functional on the server — the
// supported Node entry is still `@wc-bindable/stripe/server` (see
// `./server.ts` and README §Server).
export { bootstrapStripe } from "./bootstrapStripe.js";
export { getConfig, getRemoteCoreUrl } from "./config.js";
export { Stripe as WcsStripe } from "./components/Stripe.js";
export type { StripeJsLike, StripeElementsLike, StripePaymentElementLike, StripeJsLoader } from "./components/Stripe.js";

export type {
  IConfig, ITagNames, IRemoteConfig,
  IWritableConfig, IWritableTagNames, IWritableRemoteConfig,
  IStripeProvider, StripeMode, StripeStatus, StripeAmount, StripePaymentMethod, StripeError,
  StripeEvent, StripeIntentView, IntentRequestHint, IntentRequest, IntentBuilder,
  IntentBuilderResult, IntentCreationResult, ConfirmationReport,
  PaymentIntentOptions, SetupIntentOptions, WebhookHandler, WebhookRegisterOptions,
  ResumeAuthorizer, UserContext, WcsStripeCoreValues, WcsStripeValues,
  UnknownStatusDetail,
} from "./types.js";
