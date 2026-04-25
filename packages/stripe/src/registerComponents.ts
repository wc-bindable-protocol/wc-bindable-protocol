import { Stripe } from "./components/Stripe.js";
import { getConfig } from "./config.js";
import { raiseError } from "./raiseError.js";

export function registerComponents(): void {
  // `customElements` is a browser-only global — it is undefined in plain
  // Node and, absent this guard, throws a raw `ReferenceError` from the
  // `customElements.get(...)` access below. That failure mode is hostile
  // for SSR setups that accidentally evaluate the browser barrel on the
  // server: the actual misuse (wrong entry point — use
  // `@wc-bindable/stripe/server` for Node) is invisible. Surface it
  // with a formatted message instead.
  if (typeof customElements === "undefined") {
    raiseError("registerComponents() requires a browser — customElements is undefined. Use @wc-bindable/stripe/server for Node.");
  }
  const tag = getConfig().tagNames.stripe;
  const existing = customElements.get(tag);
  if (existing === Stripe) {
    // Same class, already registered: idempotent / HMR-safe no-op.
    return;
  }
  if (existing !== undefined) {
    // Same tag, different class. That is almost certainly a
    // configuration mistake — another copy of the package was installed
    // under the same tag name, or the app called
    // `customElements.define("stripe-checkout", SomethingElse)` first.
    // Either way, silently continuing would leave our Shell uninstalled
    // and the user with an inert `<stripe-checkout>` element; fail loud.
    raiseError(`registerComponents(): custom element "${tag}" is already registered with a different class. Check for a duplicate package install or a conflicting customElements.define() call.`);
  }
  customElements.define(tag, Stripe);
}
