import { Ai } from "./components/Ai.js";
import { AiMessage } from "./components/AiMessage.js";
import { config } from "./config.js";
import { raiseError } from "./raiseError.js";

/**
 * Define the element if that tag is free, or short-circuit if the *same*
 * class is already registered under it (idempotent / HMR-safe). If the tag
 * is held by a different class — or, conversely, if our class is already
 * registered under a different tag (HMR / second bootstrapAi() with a new
 * tagNames override) — we fail loud rather than letting `customElements.define`
 * throw a bare `NotSupportedError`.
 */
function defineOrVerify(tag: string, ctor: CustomElementConstructor, label: string): void {
  const existing = customElements.get(tag);
  if (existing === ctor) {
    // Same tag + same class: idempotent no-op.
    return;
  }
  if (existing !== undefined) {
    raiseError(`registerComponents(): custom element "${tag}" is already registered with a different class. Check for a duplicate package install or a conflicting customElements.define() call.`);
  }
  // A CustomElementConstructor can only be registered once per document.
  // `customElements.getName?.` is the lightest probe; it returns the first
  // tag the constructor was registered under and `null` otherwise. When the
  // class is already bound to a *different* tag the raw
  // `customElements.define` call would throw DOMException("already defined"),
  // which is opaque at the call site — surface the real cause here.
  const existingName = (customElements as unknown as { getName?: (c: CustomElementConstructor) => string | null })
    .getName?.(ctor) ?? null;
  if (existingName !== null && existingName !== tag) {
    raiseError(`registerComponents(): ${label} class is already registered under "${existingName}"; cannot re-register under "${tag}". bootstrapAi() should be called once per document; to switch tag names, do it before the first call.`);
  }
  customElements.define(tag, ctor);
}

export function registerComponents(): void {
  defineOrVerify(config.tagNames.ai, Ai, "Ai");
  defineOrVerify(config.tagNames.aiMessage, AiMessage, "AiMessage");
}
