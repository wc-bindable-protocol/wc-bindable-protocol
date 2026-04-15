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
  // `login()` is async and can reject (e.g. click fires before the
  // element's `domain` / `client-id` attributes are set, or during
  // an init failure). Swallow the rejection here so we don't leak
  // an unhandled-rejection into the host page's global handler —
  // the failure is still observable via `authEl.error` /
  // `hawc-auth0:error`, matching the trigger setter's contract.
  const result = (authElement as any).login();
  if (result && typeof result.then === "function") {
    result.catch(() => {
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
