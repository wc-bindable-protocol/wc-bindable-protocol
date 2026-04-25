import { Flags } from "./components/Flags.js";
import { config } from "./config.js";

export function registerComponents(): void {
  if (!customElements.get(config.tagNames.flags)) {
    customElements.define(config.tagNames.flags, Flags);
  }
}
