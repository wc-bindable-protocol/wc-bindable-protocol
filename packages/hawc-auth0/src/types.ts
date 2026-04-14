export interface ITagNames {
  readonly auth: string;
  readonly authLogout: string;
}

export interface IWritableTagNames {
  auth?: string;
  authLogout?: string;
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
export interface WcsAuthUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: any;
}

/**
 * Auth0 authentication error.
 */
export interface WcsAuthError {
  error: string;
  error_description?: string;
  [key: string]: any;
}

/**
 * Value types for AuthCore (headless) — the async state properties.
 */
export interface WcsAuthCoreValues {
  authenticated: boolean;
  user: WcsAuthUser | null;
  token: string | null;
  loading: boolean;
  error: WcsAuthError | Error | null;
}

/**
 * Value types for the Shell (`<wcs-auth>`) — extends Core with `trigger`.
 */
export interface WcsAuthValues extends WcsAuthCoreValues {
  trigger: boolean;
}

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
 * Unlike WcsAuthCoreValues, this omits `token` (security) and adds `connected`.
 */
export interface AuthShellValues {
  authenticated: boolean;
  user: WcsAuthUser | null;
  loading: boolean;
  error: WcsAuthError | Error | null;
  connected: boolean;
}

/**
 * Options for AuthShell.initialize().
 */
export interface AuthShellOptions {
  domain: string;
  clientId: string;
  /** Auth0 API identifier (audience for the access token). */
  audience: string;
  /** OAuth scope (default: "openid profile email"). */
  scope?: string;
  /** Redirect URI (default: window.location.origin). */
  redirectUri?: string;
  /** Cache location (default: "memory"). */
  cacheLocation?: "memory" | "localstorage";
  /** Whether to use Refresh Tokens (default: true — recommended). */
  useRefreshTokens?: boolean;
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
  /** Core factory — generates Core(s) from verified user context. */
  createCores: (user: UserContext) => EventTarget;
  proxyOptions?: import("@wc-bindable/remote").RemoteShellProxyOptions;
}

/**
 * Options for verifyAuth0Token().
 */
export interface VerifyTokenOptions {
  domain: string;
  audience: string;
  /** JWKS cache TTL in milliseconds (default: 600000 = 10 minutes). */
  jwksCacheTtl?: number;
}
