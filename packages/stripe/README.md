# @wc-bindable/stripe

`@wc-bindable/stripe` is a headless **Stripe payments** component built on wc-bindable-protocol.

It is not a visual UI widget.
It is an **I/O node** that connects Stripe's PaymentIntent / SetupIntent + Elements flow to reactive state — with PCI-safe card entry, 3DS redirect handling, and server-side webhook reconciliation.

- **input / command surface**: `mode`, `amount-value`, `amount-currency`, `customer-id`, `publishable-key`, `return-url`, `prepare()`, `submit()`, `reset()`, `abort()`
- **output state surface**: `status`, `loading`, `amount`, `paymentMethod`, `intentId`, `error`

`@wc-bindable/stripe` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/packages/hawc/README.md) architecture:

- **Core** (`StripeCore`) lives server-side. Owns the Stripe secret key (via `IStripeProvider`), creates PaymentIntents / SetupIntents, verifies and dispatches webhook events.
- **Shell** (`<stripe-checkout>`) lives in the browser. Loads Stripe.js, mounts the Payment Element in an iframe **sandboxed by Stripe**, drives `confirmPayment` / `confirmSetup`, handles the 3DS redirect return.
- **Card data never traverses the WebSocket** — Stripe Elements posts it directly to Stripe from within its iframe; only PaymentIntent creation, confirmation outcomes, and webhook-driven status updates flow through our server.

In the HAWC taxonomy this is the **Case C** shape: the Core owns decisions and policy on the server, while the Shell is a browser-anchored execution engine for a data plane the server cannot perform on the browser's behalf.

See [SPEC.md](./SPEC.md) for the full protocol — state machine, wcBindable surface, authorization model for 3DS resume, PCI scope invariants, webhook pipeline, and the security section that apps must follow in production.

## Quick start

### Server

Server-side code **must** import from the `/server` subpath. The bare package name `@wc-bindable/stripe` is the browser barrel — it re-exports `<stripe-checkout>` (a Custom Element built on `HTMLElement`). The component guards its `HTMLElement` base with a `typeof` fallback so the barrel *evaluates* under plain Node without crashing (useful for SSR pre-render, test pre-scanners, and bundler graph walks that touch the root specifier), but the component is **not functional on the server** — there is no `customElements` registry, no DOM, no Stripe.js. `StripeCore` / `StripeSdkProvider` are exported **only** from `/server` so Node-side code reaches the headless pieces through the entry intended for it, not through the browser surface.

> ⚠️ **Lifecycle note**: this Quick Start shows the Core wired up **at request / connection time** — `authenticatedUser` and `activeCartId` are per-request values resolved by your auth middleware. Do NOT build a single module-level `StripeCore` at server startup and try to close over request-scoped variables — that pattern captures `undefined` at module-eval time and, worse, shares one `userContext` across every tenant. Two production-safe shapes:
>
> 1. **Per-connection Core (recommended for multi-tenant WebSocket servers)**: build `provider` + `core` inside the WS `upgrade` handler once per authenticated session, and `core.dispose()` on `close`. Each session gets its own `userContext` / `buildIdempotencyKey` closure.
> 2. **One Core per process + per-request metadata**: keep `core` / `provider` at module scope and pass request-scoped data through the `IntentBuilder`'s return value — set `metadata: { userId, cartId }` on the intent options, then read it in `buildIdempotencyKey` via `ctx.options.metadata`:
>
>    ```ts
>    // IntentBuilder — embed the request-scoped keys into Stripe metadata
>    core.registerIntentBuilder((request, ctx) => ({
>      mode: "payment",
>      amount,
>      currency,
>      metadata: { userId: ctx.sub, cartId: cart.id },
>    }));
>
>    // buildIdempotencyKey — read back the same fields
>    new StripeSdkProvider(stripe, {
>      buildIdempotencyKey: ({ operation, options }) => {
>        const meta = options.metadata as { userId?: string; cartId?: string } | undefined;
>        return `${operation}:${meta?.userId ?? "anon"}:${meta?.cartId ?? "none"}`;
>      },
>    });
>    ```
>
> The example below assumes shape 1 — `authenticatedUser` / `activeCartId` are in scope because the block is conceptually inside a per-connection handler.

```ts
import Stripe from "stripe";
import { StripeCore, StripeSdkProvider } from "@wc-bindable/stripe/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const provider = new StripeSdkProvider(stripe, {
  // Optional but recommended: make intent creation idempotent per cart/user.
  // `authenticatedUser` / `activeCartId` are per-request values — see the
  // lifecycle note above for multi-tenant patterns.
  buildIdempotencyKey: ({ operation }) => `${operation}:${authenticatedUser.sub}:${activeCartId}`,
});

const core = new StripeCore(provider, {
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  userContext: authenticatedUser,
  // Optional: also cancel SetupIntents on abort/cancelIntent.
  // Default is false (state-only reset for SetupIntents).
  cancelSetupIntents: true,
});

// REQUIRED — server decides the final amount/currency/metadata from the
// authenticated user + cart, never from the Shell's hint.
core.registerIntentBuilder((request, ctx) => {
  if (request.mode === "setup") {
    return { mode: "setup", customer: resolveCustomer(ctx) };
  }
  const cart = loadCart(ctx);
  return {
    mode: "payment",
    amount: cart.totalInSmallestCurrencyUnit(),
    currency: cart.currency,
    metadata: { cartId: cart.id },
  };
});

// Webhook route handler — Stripe's HMAC-signed events land here.
core.registerWebhookHandler("payment_intent.succeeded", async (event) => {
  await fulfillOrder(event.data.object);
});

// Wire to an HTTP endpoint. `rawBody` MUST be the unparsed request body.
// Response codes control Stripe's retry policy (SPEC §6.2 / §9):
//   4xx — Stripe stops retrying. Use for requests we can prove are
//     unprocessable regardless of how often Stripe tries:
//       · StripeSignatureVerificationError (forged/wrong signing secret)
//       · stripe-checkout input/config guards (missing rawBody, missing
//         stripe-signature header, webhookSecret not configured on the
//         Core). These come through as plain Errors whose `message`
//         starts with `[@wc-bindable/stripe]`.
//   5xx — Stripe retries per its delivery policy. Reserve for fatal
//     fulfillment handler failures (DB write failed, downstream 5xx).
// StripeCore keeps a best-effort in-memory dedup window keyed by
// `event.id` and may suppress duplicate deliveries on the same process.
// Durable idempotency still belongs in your handler storage layer.
app.post("/webhooks/stripe", async (req, res) => {
  try {
    await core.handleWebhook(req.rawBody, req.headers["stripe-signature"]);
    res.status(200).end();
  } catch (err) {
    const e = err as { type?: string; message?: string };
    const isSignatureError = e?.type === "StripeSignatureVerificationError";
    const isInputOrConfigError =
      typeof e?.message === "string" && e.message.startsWith("[@wc-bindable/stripe]");
    res.status(isSignatureError || isInputOrConfigError ? 400 : 500).end();
  }
});
```

### Browser

```html
<stripe-checkout
  mode="payment"
  publishable-key="pk_live_..."
  amount-value="1980"
  amount-currency="jpy"
  return-url="https://example.com/checkout/complete"
></stripe-checkout>

<button onclick="document.querySelector('stripe-checkout').submit()">Pay</button>
```

Auto-prepare mounts Stripe Elements as soon as the element is connected and a `publishable-key` is present. `submit()` drives confirmation. 3DS redirect returns are detected and folded back into state via an authenticated `resumeIntent` call (the element reads Stripe's `payment_intent_client_secret` from the URL as the ownership token).

## Security — Your Responsibilities

The Quick Start is **deliberately minimal** and **not production-ready**. Before shipping, read SPEC.md §9 and at a minimum:

- **Authenticate the WebSocket / HTTP session** that backs the Core.
- **Compute the intent amount server-side** in `registerIntentBuilder` from authenticated user context. Never trust `request.hint.amountValue`.
- **Preserve the raw webhook body** before any JSON parser touches it — signature verification requires the exact bytes Stripe sent.
- **Enable idempotent intent creation** by supplying `buildIdempotencyKey` to `StripeSdkProvider` (or implement it in your own `IStripeProvider`). On network flake, retries without a key can create multiple intents for the same cart/user.
- **Prefer `await el.abort()` before removing the element** when you need deterministic cancel of the active PaymentIntent. Automatic disconnect teardown is best-effort; in a narrow window (disconnect during in-flight intent create), the intent may survive until Stripe natural expiry.
- **Understand SetupIntent cancel defaults**: by default `cancelIntent` does not call Stripe's `setupIntents.cancel` (state-only reset). If dashboard cleanup of stale SetupIntents matters, set `cancelSetupIntents: true` on `StripeCore` and use a provider that implements `cancelSetupIntent`.
- **Keep webhook handlers idempotent** even with Core dedup enabled. Core suppresses duplicate `event.id` deliveries only within an in-memory per-process window; multi-process routing and process restarts still require DB-backed idempotency keyed by `event.id`.
- **Consider `registerResumeAuthorizer`** for multi-tenant deployments so a leaked `client_secret` alone cannot resume a foreign user's intent.
- **Handle WebSocket disconnects in your app** (remote mode only). The `<stripe-checkout>` element connects once per mount and does NOT auto-reconnect on `close` / `error` events (mobile network drop, server rolling deploy, LB idle timeout). Subscribe to `stripe-checkout:error` and, on `code: "transport_unavailable"`, remove + re-append the element — or prompt the user to retry. See SPEC §9.3 for the rationale (auto-reconnect would push backoff policy, in-flight promise handling, and infinite-retry safety onto the library).
- **Sanitize errors** that cross the wire: the built-in sanitizer keeps `code` / `decline_code` / `type` and forwards `message` only for Stripe-shaped errors (type starts with `Stripe` or matches a known Stripe taxonomy token like `card_error` / `invalid_request_error`) and our own `[@wc-bindable/stripe]`-prefixed internals — anything else collapses to a generic `"Payment failed."` so a raw `new Error("FATAL: ...")` from an `IntentBuilder` does not reach the browser. **Do not fake Stripe type tokens on your own errors** (`Object.assign(err, { type: "card_error" })`) — that bypasses the allowlist. Custom handlers you add (webhook fulfillment, authorizers) must be equally careful. See SPEC §6.3.1.
- **Keep `publishable-key` and the server Core's secret key aligned to the same Stripe account**. The Shell (browser) is bound to `publishable-key`, the Core (server) holds the secret key via its injected `IStripeProvider`. A `publishable-key` swap invalidates cached Stripe.js and cancels the orphan intent on the *previously active* account, but it does NOT reconfigure the Core — the Core will keep creating intents under the old secret key until you construct a new `StripeCore` with a provider pointing at the new account. For multi-account routing, build one Core per account and route requests before they reach `requestIntent`.

Core observability events include `stripe-checkout:webhook-deduped` with `detail: { eventId, type }` whenever a duplicate authenticated webhook is suppressed by the dedup window.

## Install

```bash
npm install @wc-bindable/stripe stripe @stripe/stripe-js
```

`stripe` (server SDK) and `@stripe/stripe-js` (browser loader) are declared as optional peer dependencies. Install whichever side you consume.

## License

MIT. See [LICENSE](./LICENSE).
