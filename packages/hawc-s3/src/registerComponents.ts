import { S3 } from "./components/S3.js";
import { S3Callback } from "./components/S3Callback.js";
import { _getInternalConfig } from "./config.js";

export function registerComponents(): void {
  const cfg = _getInternalConfig();
  if (!customElements.get(cfg.tagNames.s3)) {
    customElements.define(cfg.tagNames.s3, S3);
  }
  if (!customElements.get(cfg.tagNames.s3Callback)) {
    customElements.define(cfg.tagNames.s3Callback, S3Callback);
  }
}
