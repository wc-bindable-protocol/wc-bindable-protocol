/**
 * Server-side entry point.
 *
 * The default barrel (`@wc-bindable/hawc-stripe`) re-exports `<hawc-stripe>`
 * which extends `HTMLElement`. Loading that class from Node throws
 * `ReferenceError: HTMLElement is not defined`, so server-side consumers
 * (Express/Fastify/Hono routes that create intents, handle webhooks, or
 * bridge a RemoteShellProxy) must use this entry instead.
 *
 * Exports only the headless pieces safe in Node:
 *   - `StripeCore`           (the wcBindable Core that holds the webhook secret)
 *   - `StripeSdkProvider`    (adapter for stripe-node)
 *   - types
 */
export { StripeCore } from "./core/StripeCore.js";
export { StripeSdkProvider } from "./providers/StripeSdkProvider.js";
export type { StripeNodeLike } from "./providers/StripeSdkProvider.js";
export type {
  IStripeProvider, StripeMode, StripeStatus, StripeAmount, StripePaymentMethod, StripeError,
  StripeEvent, StripeIntentView, IntentRequestHint, IntentRequest, IntentBuilder,
  IntentBuilderResult, IntentCreationResult, ConfirmationReport,
  PaymentIntentOptions, SetupIntentOptions, WebhookHandler, WebhookRegisterOptions,
  ResumeAuthorizer, UserContext, WcsStripeCoreValues,
} from "./types.js";
