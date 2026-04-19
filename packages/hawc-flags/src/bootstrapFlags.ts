import { setConfig } from "./config.js";
import { registerComponents } from "./registerComponents.js";
import type { IWritableConfig } from "./types.js";

export function bootstrapFlags(userConfig?: IWritableConfig): void {
  if (userConfig) {
    setConfig(userConfig);
  }
  registerComponents();
}
