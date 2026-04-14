export { bootstrapAuth } from "./bootstrapAuth.js";
export { getConfig } from "./config.js";
export { AuthCore } from "./core/AuthCore.js";
export { AuthShell } from "./shell/AuthShell.js";
export { Auth as HawcAuth0 } from "./components/Auth.js";
export { AuthLogout as HawcAuth0Logout } from "./components/AuthLogout.js";

export type {
  IWritableConfig, IWritableTagNames,
  WcsAuthUser, WcsAuthError, WcsAuthCoreValues, WcsAuthValues,
  Auth0ClientOptions,
  AuthShellValues, AuthShellOptions,
  UserContext, AuthenticatedConnectionOptions, VerifyTokenOptions,
} from "./types.js";
