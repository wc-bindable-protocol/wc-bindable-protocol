// Root entry surface — mirrors `@wc-bindable/webauthn`'s
// convention by exposing the full config API (not just a one-shot
// `bootstrapFlags(userConfig)` hook). Advanced consumers can
// re-configure tag names after bootstrap, inspect the live config
// via `config` / `getConfig()`, or split registration from
// configuration by calling `registerComponents()` separately.
// The `*Writable*` / read-only config types are exported alongside
// the setter so IDEs surface a consistent API.
export { bootstrapFlags } from "./bootstrapFlags.js";
export { registerComponents } from "./registerComponents.js";
export { getConfig, setConfig, config } from "./config.js";
export { Flags } from "./components/Flags.js";

export type {
  IConfig,
  ITagNames,
  IWritableConfig,
  IWritableTagNames,
  FlagMap,
  FlagValue,
  FlagIdentity,
  FlagsValues,
} from "./types.js";
