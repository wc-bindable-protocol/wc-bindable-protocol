export interface ITagNames {
  readonly auth: string;
  readonly authLogout: string;
  readonly authSession: string;
}

export interface IWritableTagNames {
  auth?: string;
  authLogout?: string;
  authSession?: string;
}

export interface IConfig {
  readonly autoTrigger: boolean;
  readonly triggerAttribute: string;
  readonly tagNames: ITagNames;
}

export interface IWritableConfig {
  autoTrigger?: boolean;
  triggerAttribute?: string;
  tagNames?: IWritableTagNames;
}

export interface IWcBindableProperty {
  readonly name: string;
  readonly event: string;
  readonly getter?: (event: Event) => any;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: number;
  readonly properties: IWcBindableProperty[];
}

/**
 * Auth0 user profile returned after authentication.
 */
export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: any;
}

/**
 * Auth0 authentication error.
 */
export interface AuthError {
  error: string;
  error_description?: string;
  [key: string]: any;
}

/**
 * Value types for AuthCore (headless) — the async state properties.
 */
export interface AuthCoreValues {
  authenticated: boolean;
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  error: AuthError | Error | null;
}

/**
 * Value types for the `<hawc-auth0>` custom element — the bindable
 * surface seen by `data-wcs`-style binding systems.
 *
 * This intentionally does NOT include `token`: the access token is
 * deliberately kept out of the bindable surface (security — see the
 * remote spec) and is exposed only as a JS-only getter / `getToken()`
 * method on the element. `connected` is included instead, and the
 * element adds `trigger` on top of the Shell's bindable properties.
 */
export interface AuthValues extends AuthShellValues {
  trigger: boolean;
}

// ---------------------------------------------------------------------------
// Deprecated legacy aliases (Wcs* prefix is a `@wcstack` artifact).
// Kept for backward compatibility — schedule removal in a future major.
// ---------------------------------------------------------------------------

/** @deprecated Renamed to {@link AuthUser}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthUser = AuthUser;

/** @deprecated Renamed to {@link AuthError}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthError = AuthError;

/** @deprecated Renamed to {@link AuthCoreValues}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthCoreValues = AuthCoreValues;

/** @deprecated Renamed to {@link AuthValues}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthValues = AuthValues;

/**
 * Auth0 client configuration options passed to createAuth0Client.
 */
export interface Auth0ClientOptions {
  domain: string;
  clientId: string;
  authorizationParams?: {
    redirect_uri?: string;
    audience?: string;
    scope?: string;
    [key: string]: any;
  };
  cacheLocation?: "memory" | "localstorage";
  useRefreshTokens?: boolean;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Remote HAWC types
// ---------------------------------------------------------------------------

/**
 * Value types for AuthShell — the remote-capable authentication shell.
 * Unlike AuthCoreValues, this omits `token` (security) and adds `connected`.
 */
export interface AuthShellValues {
  authenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
  error: AuthError | Error | null;
  connected: boolean;
}

/**
 * Deployment mode for AuthShell / `<hawc-auth0>`.
 *
 * - `"local"`: Auth0-only. `.token` / `getToken()` are JS-reachable so the
 *   application can attach `Authorization: Bearer` headers to outbound
 *   fetches.
 * - `"remote"`: the access token is held inside AuthShell and sent on the
 *   wire only at the WebSocket handshake and during in-band `auth:refresh`.
 *   `.token` returns `null` and `getToken()` throws — applications rely on
 *   the remote transport for auth and use `getTokenExpiry()` for refresh
 *   scheduling.
 */
export type AuthMode = "local" | "remote";

/**
 * Options for AuthShell.initialize().
 */
export interface AuthShellOptions {
  domain: string;
  clientId: string;
  /**
   * Auth0 API identifier (audience for the access token).
   *
   * Optional: when omitted (or passed as an empty string) the Auth0 SPA
   * SDK issues an opaque access token tied only to the ID token flow.
   * Set this to the API identifier whenever the application either
   * (a) attaches `Authorization: Bearer` headers to a backend,
   * (b) runs in remote mode (server-side `verifyAuth0Token` enforces
   *     an `aud` match — missing audience causes handshake rejection),
   * or (c) relies on RBAC `permissions` / `roles` claims.
   * In those cases, treat it as effectively required.
   */
  audience?: string;
  /** OAuth scope (default: "openid profile email"). */
  scope?: string;
  /** Redirect URI (default: window.location.origin). */
  redirectUri?: string;
  /** Cache location (default: "memory"). */
  cacheLocation?: "memory" | "localstorage";
  /** Whether to use Refresh Tokens (default: true — recommended). */
  useRefreshTokens?: boolean;
  /** Deployment mode (default: "local"). See {@link AuthMode}. */
  mode?: AuthMode;
}

// ---------------------------------------------------------------------------
// Server-side types
// ---------------------------------------------------------------------------

/**
 * User context built after JWT verification on the server.
 */
export interface UserContext {
  /** Auth0 user identifier (e.g. "auth0|abc123"). */
  sub: string;
  email?: string;
  name?: string;
  /** Auth0 RBAC permissions array. */
  permissions: string[];
  /** Auth0 RBAC roles array. */
  roles: string[];
  /** Organization ID for multi-tenancy. */
  orgId?: string;
  /** Raw JWT payload for custom claim access. */
  raw: Record<string, unknown>;
}

/**
 * Options for the server-side authenticated connection handler.
 */
export interface AuthenticatedConnectionOptions {
  auth0Domain: string;
  auth0Audience: string;
  /** Allowed Origin list (CSRF prevention). */
  allowedOrigins?: string[];
  /**
   * JWT claim key used to read Auth0 RBAC roles. Forwarded to
   * `verifyAuth0Token` — see `VerifyTokenOptions.rolesClaim`. Leave
   * unset for tenants whose custom Action emits `roles` under the
   * non-namespaced key; set to a namespaced URI (e.g.
   * `"https://api.example.com/roles"`) for the default Auth0 RBAC
   * flow, which otherwise leaves `UserContext.roles` empty.
   */
  rolesClaim?: string;
  /** Core factory — generates Core(s) from verified user context. */
  createCores: (user: UserContext) => EventTarget;
  /**
   * Propagate a refreshed UserContext into the Core(s) after an in-band
   * `auth:refresh`. Required when token claims (permissions, roles, ...)
   * can change across refreshes and the Core exposes them — otherwise
   * server-side bindable state goes stale relative to the latest token.
   *
   * May be sync or async; the handler is awaited and the refresh
   * commit only proceeds if it resolves. A sync throw or async rejection
   * rolls back the refresh and is reported as `auth:refresh-failure`.
   *
   * For the reference `UserCore`, pass `(core, user) => core.updateUser(user)`.
   */
  onTokenRefresh?: (core: EventTarget, user: UserContext) => void | Promise<void>;
  proxyOptions?: import("@wc-bindable/remote").RemoteShellProxyOptions;
}

/**
 * Options for verifyAuth0Token().
 */
export interface VerifyTokenOptions {
  domain: string;
  audience: string;
  /**
   * JWT claim key that holds the Auth0 RBAC roles array.
   *
   * Auth0's default RBAC configuration emits roles as a namespaced
   * custom claim (e.g. `https://example.com/roles`) because Auth0
   * reserves non-namespaced claims for its OIDC payload. SPEC-REMOTE
   * §4.2 documents the expected shape as
   * `payload["https://{namespace}/roles"]`.
   *
   * When this option is set, `verifyAuth0Token` reads roles from the
   * given claim key first and falls back to the non-namespaced
   * `payload.roles` only if the namespaced key is absent. When unset,
   * the legacy `payload.roles` lookup is used, matching pre-existing
   * deployments that emit roles through a custom Action into the
   * non-namespaced key.
   *
   * Leave unset for Auth0 tenants that have a custom Action emitting
   * `event.accessToken.setCustomClaim("roles", …)`; set to your
   * namespaced URI (e.g. `"https://api.example.com/roles"`) for the
   * out-of-the-box Auth0 RBAC "Add Permissions in the Access Token"
   * flow combined with a namespaced roles claim.
   */
  rolesClaim?: string;
}
