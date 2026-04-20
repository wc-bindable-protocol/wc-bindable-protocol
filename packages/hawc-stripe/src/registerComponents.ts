import { Stripe } from "./components/Stripe.js";
import { config } from "./config.js";

export function registerComponents(): void {
  if (!customElements.get(config.tagNames.stripe)) {
    customElements.define(config.tagNames.stripe, Stripe);
  }
}
