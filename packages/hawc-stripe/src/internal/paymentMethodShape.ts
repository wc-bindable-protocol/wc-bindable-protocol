import { StripePaymentMethod } from "../types.js";

/**
 * Extract a minimal card-PaymentMethod view from a Stripe object (typically
 * a PaymentIntent / SetupIntent retrieve result, a webhook payload, or a
 * Stripe.js confirm result).
 *
 * Returns a value only when `payment_method` is expanded into an object
 * AND that object carries a `card`. Non-card (e.g. bank_transfer, pix) and
 * non-expanded (bare pm_... string) shapes return undefined so the caller
 * can decide whether to try another channel — server-side retrieve,
 * webhook fallback, etc.
 *
 * Shared between the Core, the SdkProvider, and the Shell so a shape
 * change in Stripe's response (new brand tokens, expanded last4 moving,
 * etc.) only requires an update here. Lives under `internal/` because it
 * is an implementation helper, not part of the package's public surface.
 */
export function extractCardPaymentMethod(obj: Record<string, unknown>): StripePaymentMethod | undefined {
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
