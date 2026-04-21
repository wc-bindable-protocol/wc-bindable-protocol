import { Stripe } from "./components/Stripe.js";
import { getConfig } from "./config.js";
import { raiseError } from "./raiseError.js";

export function registerComponents(): void {
  // `customElements` is a browser-only global — it is undefined in plain
  // Node and, absent this guard, throws a raw `ReferenceError` from the
  // `customElements.get(...)` access below. That failure mode is hostile
  // for SSR setups that accidentally evaluate the browser barrel on the
  // server: the actual misuse (wrong entry point — use
  // `@wc-bindable/hawc-stripe/server` for Node) is invisible. Surface it
  // with a formatted message instead.
  if (typeof customElements === "undefined") {
    raiseError("registerComponents() requires a browser — customElements is undefined. Use @wc-bindable/hawc-stripe/server for Node.");
  }
  const tag = getConfig().tagNames.stripe;
  if (!customElements.get(tag)) {
    customElements.define(tag, Stripe);
  }
}
