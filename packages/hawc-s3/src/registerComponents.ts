import { S3 } from "./components/S3.js";
import { S3Callback } from "./components/S3Callback.js";
import { config } from "./config.js";

export function registerComponents(): void {
  if (!customElements.get(config.tagNames.s3)) {
    customElements.define(config.tagNames.s3, S3);
  }
  if (!customElements.get(config.tagNames.s3Callback)) {
    customElements.define(config.tagNames.s3Callback, S3Callback);
  }
}
