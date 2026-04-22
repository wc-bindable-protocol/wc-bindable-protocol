import { config } from "./config.js";

/**
 * Refcount of `<hawc-auth0>` instances (and any direct callers) that
 * have requested the global click listener. The listener itself is
 * attached **once** while `_refCount > 0` and detached as soon as
 * every caller has balanced their `registerAutoTrigger()` with
 * `unregisterAutoTrigger()`. This lets a long-lived SPA that mounts
 * and unmounts `<hawc-auth0>` (routing, dynamic toolbars, etc.) tear
 * the global `document` listener down instead of leaking it for the
 * rest of the session.
 */
let _refCount = 0;

function handleClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const triggerElement = target.closest<Element>(`[${config.triggerAttribute}]`);
  if (!triggerElement) return;

  const authId = triggerElement.getAttribute(config.triggerAttribute);
  if (!authId) return;

  const authElement = document.getElementById(authId);
  if (!authElement || authElement.tagName.toLowerCase() !== config.tagNames.auth) return;

  event.preventDefault();
  // Duck-check before invocation. The tag-name match above only
  // proves the element's tagName is registered — not that the
  // upgrade has installed the prototype methods yet. On the very
  // first click after navigation (custom element definition loaded
  // via `defer` after parse), `login` can still be undefined, and
  // calling it would throw `TypeError: authElement.login is not a
  // function` into the click handler's call stack.
  const loginFn = (authElement as unknown as { login?: unknown }).login;
  if (typeof loginFn !== "function") return;
  // `login()` is async and can reject (e.g. click fires before the
  // element's `domain` / `client-id` attributes are set, or during
  // an init failure). Treat the returned value as a potential
  // Thenable rather than assuming a Promise: custom implementations
  // could return a non-Promise Thenable, and the same `.catch`
  // pattern handles both without a second await. Swallow the
  // rejection here so we don't leak an unhandled-rejection into the
  // host page's global handler — the failure is still observable
  // via `authEl.error` / `hawc-auth0:error`, matching the trigger
  // setter's contract. Normalising through `Promise.resolve(...)`
  // would work too, but the explicit Thenable check keeps the
  // rejection origin attached to whatever the method actually
  // returned (easier to attribute in dev tools).
  const result = (loginFn as (...a: unknown[]) => unknown).call(authElement);
  if (result && typeof (result as { then?: unknown }).then === "function") {
    (result as Promise<unknown>).catch(() => {
      /* error surfaces via authEl.error (AuthShell state) */
    });
  }
}

export function registerAutoTrigger(): void {
  if (_refCount === 0) {
    document.addEventListener("click", handleClick);
  }
  _refCount++;
}

export function unregisterAutoTrigger(): void {
  if (_refCount === 0) return;
  _refCount--;
  if (_refCount === 0) {
    document.removeEventListener("click", handleClick);
  }
}
