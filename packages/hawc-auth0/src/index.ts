export { bootstrapAuth } from "./bootstrapAuth.js";
export { getConfig } from "./config.js";
export { AuthCore } from "./core/AuthCore.js";
export { AuthShell } from "./shell/AuthShell.js";
export { Auth as HawcAuth0 } from "./components/Auth.js";
export { AuthLogout as HawcAuth0Logout } from "./components/AuthLogout.js";

export type {
  IWritableConfig, IWritableTagNames,
  AuthUser, AuthError, AuthCoreValues, AuthValues,
  Auth0ClientOptions,
  AuthShellValues, AuthShellOptions,
  UserContext, AuthenticatedConnectionOptions, VerifyTokenOptions,
  // Deprecated — kept for backward compatibility, see types.ts
  WcsAuthUser, WcsAuthError, WcsAuthCoreValues, WcsAuthValues,
} from "./types.js";
