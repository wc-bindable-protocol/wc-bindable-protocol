import { WebAuthn } from "./components/WebAuthn.js";
import { config } from "./config.js";

export function registerComponents(): void {
  if (!customElements.get(config.tagNames.webauthn)) {
    customElements.define(config.tagNames.webauthn, WebAuthn);
  }
}
