import { IWcBindable } from "../types.js";

/**
 * Static wcBindable descriptor for `StripeCore` — extracted into its own
 * module so the **browser module graph** never transitively evaluates
 * `StripeCore.ts` itself.
 *
 * Why this matters: `StripeCore.ts` imports `node:crypto` (for the
 * constant-time clientSecret compare in `resumeIntent`). When the Shell
 * (`components/Stripe.ts`, evaluated in the browser) needs
 * `StripeCore.wcBindable` at module scope 窶・for the
 * `Stripe.wcBindable.properties` spread, the remote proxy factory, and the
 * `attachLocalCore` type slot 窶・a direct `import { StripeCore }` pulls the
 * whole file into the browser graph, and `node:crypto` fails to resolve
 * (observed as `TypeError: Failed to fetch dynamically imported module`).
 *
 * Splitting the descriptor isolates the runtime dependency to its
 * definition only: the Shell imports `STRIPE_CORE_WC_BINDABLE` from here,
 * and only uses `StripeCore` via `import type { StripeCore }` (type refs
 * are erased at emit time). `StripeCore.ts` remains a node-only module
 * reached through `@wc-bindable/hawc-stripe/server`.
 */
export const STRIPE_CORE_WC_BINDABLE: IWcBindable = {
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
