import { Auth } from "./components/Auth.js";
import { AuthLogout } from "./components/AuthLogout.js";
import { AuthSession } from "./components/AuthSession.js";
import { config } from "./config.js";

export function registerComponents(): void {
  if (!customElements.get(config.tagNames.auth)) {
    customElements.define(config.tagNames.auth, Auth);
  }
  if (!customElements.get(config.tagNames.authLogout)) {
    customElements.define(config.tagNames.authLogout, AuthLogout);
  }
  if (!customElements.get(config.tagNames.authSession)) {
    customElements.define(config.tagNames.authSession, AuthSession);
  }
}
