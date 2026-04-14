# hawc-auth0 Remote HAWC Specification

## 1. Overview

Adapt `hawc-auth0` to the remote HAWC architecture. Map the inherent two-layer structure of the Auth0 authentication flow — **"browser-dependent parts"** and **"server-completable parts"** — precisely onto the remote HAWC **Shell/Core boundary**.

### Design Principles

- **Shell (browser)**: Auth0 SPA SDK calls, redirect navigation, token acquisition, login UI control
- **Core (server)**: Token verification, user context retention, permission/role evaluation, session management
- **Junction point**: Access token handoff during WebSocket handshake (single point only)

### Fundamental Difference from hawc-s3

hawc-s3 follows the pattern "Shell connects to Core and delegates operations." The Shell acts as a proxy for the Core and subscribes to Core property changes.

hawc-auth0 remote follows the pattern **"Cores are constructed only after authentication succeeds."** The Auth0 Shell functions as a **gatekeeper** to other Cores, responsible for establishing an authenticated WebSocket connection. The Core itself contains no authentication logic — **it already holds an authenticated user context at the time of construction**.

---

## 2. Architecture

### 2.1 System Diagram

```
┌─────────────────────────────────────────────────────┐
│                  BROWSER (Shell side)                 │
│                                                       │
│  ┌───────────┐    ┌──────────────────┐               │
│  │ Auth0 SPA │    │  AuthShell       │               │
│  │   SDK     │◄──►│  (EventTarget)   │               │
│  └───────────┘    │                  │               │
│                   │  - authenticated │               │
│                   │  - user          │               │
│                   │  - loading       │               │
│                   │  - error         │               │
│                   │  - connected     │               │
│                   └───────┬──────────┘               │
│                           │ token                     │
│                           ▼                           │
│                   ┌──────────────────┐               │
│                   │  WebSocket       │               │
│                   │  (bearer.{token})│               │
│                   └───────┬──────────┘               │
│                           │                           │
│  ┌────────────────────────┼─────────────────────┐    │
│  │ RemoteCoreProxy(s)     │                     │    │
│  │                        │                     │    │
│  │  proxy.currentUser ◄───┘ (available after    │    │
│  │  proxy.permissions       sync)               │    │
│  │  proxy.someBusinessProp                      │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────┘
                           │ wss://
                           ▼
┌──────────────────────────────────────────────────────┐
│                  SERVER (Core side)                    │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  Connection Handler                           │    │
│  │  1. Extract token (Sec-WebSocket-Protocol)    │    │
│  │  2. Verify JWT (jose / JWKS)                  │    │
│  │  3. Build UserContext                         │    │
│  │  4. Instantiate Cores (inject user)           │    │
│  │  5. Wrap with RemoteShellProxy                │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐   │
│  │  UserCore    │  │  S3Core     │  │ OtherCore  │   │
│  │  (user ctx)  │  │  (user ctx) │  │ (user ctx) │   │
│  └─────────────┘  └─────────────┘  └────────────┘   │
│         ▲                ▲                ▲           │
│         └────────────────┼────────────────┘           │
│                    AppCore (aggregate)                 │
│                          ▲                            │
│                   RemoteShellProxy                    │
└──────────────────────────────────────────────────────┘
```

### 2.2 State Transitions

```
[Unauthenticated] ──login()──► [Auth0 Redirect] ──callback──► [Token Acquired]
    │                                                               │
    │                                                               ▼
    │                                                      [WebSocket Connect]
    │                                                      (token verified)
    │                                                               │
    │                                                               ▼
    │                                                      [Core Build & Sync]
    │                                                               │
    │                                                               ▼
    ◄──────────── logout() ◄──────────────────────── [Authenticated & Operable]
                                                           │        ▲
                                                           │        │
                                                      token expired  │
                                                           │        │
                                                           ▼        │
                                                   [refreshToken]   │
                                                           │        │
                                                           ▼        │
                                                    [reconnect()] ──┘
```

---

## 3. Shell Side Specification

### 3.1 AuthShell Class

A thin wrapper around the Auth0 SPA SDK that exposes state via the wc-bindable protocol.
Retains the browser-dependent parts of the local `AuthCore` while adding **remote connection establishment** as a responsibility.

```typescript
export class AuthShell extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "authenticated", event: "hawc-auth0:authenticated-changed" },
      { name: "user",          event: "hawc-auth0:user-changed" },
      { name: "loading",       event: "hawc-auth0:loading-changed" },
      { name: "error",         event: "hawc-auth0:error" },
      { name: "connected",     event: "hawc-auth0:connected-changed" },
    ],
  };
}
```

#### Properties

| Property        | Type                    | Description                                    |
|----------------|-------------------------|------------------------------------------------|
| `authenticated`| `boolean`               | Authentication state from Auth0                |
| `user`         | `AuthUser \| null`      | User profile retrieved from Auth0              |
| `loading`      | `boolean`               | Authentication in progress flag                |
| `error`        | `AuthError \| null`     | Most recent error                              |
| `connected`    | `boolean`               | WebSocket connection established (= Core available) |

> **Note**: The `token` property present in the local version is **intentionally not exposed** externally. The token is held only within the browser and used solely during the WebSocket handshake, minimizing the risk of token leakage via XSS.

#### Commands

| Command               | Arguments                      | Return Type              | Description                                     |
|-----------------------|--------------------------------|--------------------------|-------------------------------------------------|
| `initialize(options)` | `AuthShellOptions`             | `Promise<void>`          | Initialize Auth0 client + handle callback       |
| `login(options?)`     | `LoginOptions?`                | `Promise<void>`          | Redirect to Auth0 login page                    |
| `loginWithPopup(options?)` | `LoginOptions?`           | `Promise<void>`          | Login via popup window                          |
| `logout(options?)`    | `LogoutOptions?`               | `Promise<void>`          | Logout + close WebSocket                        |
| `connect(url)`        | `string`                       | `Promise<ClientTransport>` | Establish authenticated WebSocket connection  |
| `reconnect()`         | none                           | `Promise<ClientTransport>` | Refresh token and establish new connection     |

### 3.2 AuthShellOptions (initialize argument)

```typescript
interface AuthShellOptions {
  /** Auth0 tenant domain */
  domain: string;
  /** Auth0 application Client ID */
  clientId: string;
  /** Auth0 API identifier (audience for the access token) */
  audience: string;
  /** OAuth scope (default: "openid profile email") */
  scope?: string;
  /** Redirect URI (default: window.location.origin) */
  redirectUri?: string;
  /** Cache location (default: "memory") */
  cacheLocation?: "memory" | "localstorage";
  /** Whether to use Refresh Tokens (default: true — recommended) */
  useRefreshTokens?: boolean;
}
```

### 3.3 connect() Detailed Specification

`connect()` establishes an authenticated WebSocket connection.

```typescript
async connect(url: string): Promise<ClientTransport> {
  // 1. Obtain access token from Auth0 SPA SDK
  const token = await this._client.getTokenSilently();

  // 2. Open WebSocket with token in Sec-WebSocket-Protocol
  const ws = new WebSocket(url, [`hawc-auth0.bearer.${token}`]);

  // 3. Wrap with WebSocketClientTransport and return
  const transport = new WebSocketClientTransport(ws);
  
  // 4. Track connection state
  this._setConnected(true);
  ws.addEventListener("close", () => this._setConnected(false));

  return transport;
}
```

**Token transmission method**: Uses the `Sec-WebSocket-Protocol` subprotocol header.

- Format: `hawc-auth0.bearer.{JWT}`
- Reason: The browser WebSocket API cannot attach arbitrary HTTP headers (`Authorization`)
- The server must echo back the same value in the `Sec-WebSocket-Protocol` response header

**Alternative methods (not recommended)**:
- Query parameter `?token=...` — risk of URL being logged
- First message after connection — socket is open before verification

### 3.4 reconnect() Detailed Specification

Re-establishes the WebSocket after a token refresh. Combined with `RemoteCoreProxy.reconnect()`, this enables seamless connection updates while preserving `bind()` subscribers.

```typescript
async reconnect(): Promise<ClientTransport> {
  // 1. Refresh token via Auth0 SPA SDK
  const token = await this._client.getTokenSilently({ cacheMode: "off" });

  // 2. Establish new WebSocket connection
  const ws = new WebSocket(this._url, [`hawc-auth0.bearer.${token}`]);
  const transport = new WebSocketClientTransport(ws);

  // 3. Update connection state
  this._setConnected(true);
  ws.addEventListener("close", () => this._setConnected(false));

  return transport;
}
```

**Usage pattern** (application side):

```typescript
// Proactively refresh before token expiry
async function refreshConnection(authShell: AuthShell, proxy: RemoteCoreProxy) {
  const newTransport = await authShell.reconnect();
  proxy.reconnect(newTransport);
  // bind() subscribers are preserved — UI experiences zero downtime
}
```

### 3.5 HTMLElement Wrapper (`<hawc-auth0>`)

```typescript
export class Auth extends HTMLElement {
  static wcBindable: IWcBindable = {
    ...AuthShell.wcBindable,
    properties: [
      ...AuthShell.wcBindable.properties,
      { name: "trigger", event: "hawc-auth0:trigger-changed" },
    ],
  };

  static get observedAttributes(): string[] {
    return [
      "domain", "client-id", "audience", "scope",
      "redirect-uri", "cache-location", "use-refresh-tokens",
      "remote-url",  // additional attribute for remote HAWC
    ];
  }
}
```

**Additional attribute**:

| Attribute     | Description                            | Example                        |
|---------------|----------------------------------------|--------------------------------|
| `remote-url`  | WebSocket URL of the Core server       | `wss://api.example.com/hawc`   |

When `remote-url` is set, `connect()` is automatically called after successful authentication.

---

## 4. Server Side Specification

### 4.1 Connection Handler

The server accepts WebSocket connections and constructs Cores only after token verification.

```typescript
import { WebSocketServer } from "ws";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import { createRemoteJWKSet, jwtVerify } from "jose";

interface AuthenticatedConnectionOptions {
  /** Auth0 tenant domain */
  auth0Domain: string;
  /** Auth0 API identifier */
  auth0Audience: string;
  /** Core factory — generates Core(s) from verified user context */
  createCores: (user: UserContext) => EventTarget;
  /** Allowed Origin list (CSRF prevention) */
  allowedOrigins?: string[];
  /** RemoteShellProxy options */
  proxyOptions?: RemoteShellProxyOptions;
}
```

### 4.2 Token Verification Flow

```
WebSocket connection request
    │
    ▼
Origin check ──failure──► socket.close(1008, "Forbidden origin")
    │
    │ success
    ▼
Extract token from Sec-WebSocket-Protocol
    │
    │ Parse "hawc-auth0.bearer.{JWT}"
    ▼
JWT verification (jose)
    │
    │  - JWKS endpoint: https://{domain}/.well-known/jwks.json
    │  - issuer:   https://{domain}/
    │  - audience: {API identifier}
    │  - exp, iat, nbf checks
    ▼
Build UserContext
    │
    │  {
    │    sub:         payload.sub,
    │    email:       payload.email,
    │    name:        payload.name,
    │    permissions: payload.permissions ?? [],
    │    roles:       payload["https://{namespace}/roles"] ?? [],
    │    orgId:       payload.org_id,
    │    raw:         payload,
    │  }
    ▼
Invoke Core factory
    │
    │  createCores(userContext) → EventTarget (AppCore)
    ▼
Construct RemoteShellProxy
    │
    │  new RemoteShellProxy(appCore, transport, options)
    ▼
Connection established
```

### 4.3 UserContext Type

```typescript
interface UserContext {
  /** Auth0 user identifier (e.g. "auth0|abc123") */
  sub: string;
  /** Email address */
  email?: string;
  /** Display name */
  name?: string;
  /** Auth0 RBAC permissions array */
  permissions: string[];
  /** Auth0 RBAC roles array */
  roles: string[];
  /** Organization ID for multi-tenancy */
  orgId?: string;
  /** Raw JWT payload (for custom claim access) */
  raw: Record<string, unknown>;
}
```

### 4.4 Provided Helper Functions

#### `createAuthenticatedWSS(options): WebSocketServer`

Helper to simplify WebSocket server construction.

```typescript
import { createAuthenticatedWSS } from "@wc-bindable/hawc-auth0/server";

const wss = createAuthenticatedWSS({
  auth0Domain: "your-tenant.auth0.com",
  auth0Audience: "https://api.example.com",
  allowedOrigins: ["https://app.example.com"],
  createCores: (user) => new AppCore(user),
});

wss.listen(3000);
```

#### `verifyAuth0Token(token, options): Promise<UserContext>`

Utility for token verification only. Use when integrating with an existing WebSocket server.

```typescript
import { verifyAuth0Token } from "@wc-bindable/hawc-auth0/server";

wss.on("connection", async (socket, req) => {
  try {
    const token = extractTokenFromProtocol(req);
    const user = await verifyAuth0Token(token, {
      domain: "your-tenant.auth0.com",
      audience: "https://api.example.com",
    });
    // Build Cores...
  } catch {
    socket.close(1008, "Unauthorized");
  }
});
```

#### `extractTokenFromProtocol(req): string`

Parses the `Sec-WebSocket-Protocol` header to extract the token from `hawc-auth0.bearer.{JWT}`.

---

## 5. Core Side Patterns

### 5.1 UserCore — Exposing Authenticated User Information

A Core constructed server-side that exposes user information as wc-bindable properties.

```typescript
export class UserCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "currentUser", event: "hawc-auth0:user-changed" },
      { name: "permissions", event: "hawc-auth0:permissions-changed" },
      { name: "roles",       event: "hawc-auth0:roles-changed" },
    ],
  };

  private _user: UserContext;

  constructor(user: UserContext) {
    super();
    this._user = user;
  }

  get currentUser(): { sub: string; email?: string; name?: string } {
    return {
      sub:   this._user.sub,
      email: this._user.email,
      name:  this._user.name,
    };
  }

  get permissions(): string[] {
    return [...this._user.permissions];
  }

  get roles(): string[] {
    return [...this._user.roles];
  }
}
```

### 5.2 AppCore Pattern — Aggregating Multiple Cores

An aggregate Core that bundles multiple Cores onto a single WebSocket connection.

```typescript
export class AppCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      // Forward UserCore properties
      { name: "currentUser", event: "hawc-auth0:user-changed" },
      { name: "permissions", event: "hawc-auth0:permissions-changed" },
      // Forward other Core properties similarly
    ],
    commands: [
      // Expose commands from each Core
      { name: "requestUpload", async: true },
      // ...
    ],
  };

  private _userCore: UserCore;
  private _s3Core: S3Core;

  constructor(user: UserContext) {
    super();
    this._userCore = new UserCore(user);
    this._s3Core   = new S3Core(new AwsS3Provider({ region: "us-east-1" }));
    // Forward child Core events to self
    this._forwardEvents(this._userCore);
    this._forwardEvents(this._s3Core);
  }
}
```

> **Design decision**: 1 connection = 1 user session = 1 AppCore. Separate connections per Core would multiply authentication verification overhead. The recommended pattern is the **"user session = connection = AppCore" trinity**.

### 5.3 Authorization Pattern — Permission Checks Inside the Core

```typescript
class S3Core extends EventTarget {
  private _user: UserContext;

  constructor(provider: IS3Provider, user: UserContext) {
    super();
    this._user = user;
  }

  async requestUpload(key: string, size?: number): Promise<PresignedUpload> {
    // Authorization check — self-contained within the Core
    if (!this._user.permissions.includes("storage:upload")) {
      throw new Error("Forbidden: missing storage:upload permission");
    }
    // ... actual processing
  }
}
```

---

## 6. Lifecycle Flows

### 6.1 Login → Core Usage

```
1. App startup
   └─ AuthShell.initialize(options)
      └─ Initialize Auth0 SPA SDK
      └─ If callback URL: handleRedirectCallback()
      └─ If isAuthenticated() → false:
         └─ Emit authenticated=false, connected=false
         └─ UI: Show <LoggedOutView>
         └─ * Do NOT connect WebSocket, do NOT create Core

2. User clicks login button
   └─ AuthShell.login()
      └─ Redirect to Auth0 login page

3. Authentication succeeds at Auth0 → return to callback URL
   └─ AuthShell.initialize() handles callback
      └─ handleRedirectCallback()
      └─ isAuthenticated() → true
      └─ Emit authenticated=true

4. Establish WebSocket connection
   └─ Call AuthShell.connect(url) (or auto-connect via remote-url attribute)
      └─ getTokenSilently() to obtain access token
      └─ WebSocket(url, ["hawc-auth0.bearer.{token}"])
      └─ Return transport

5. Server-side connection verification
   └─ Extract token → Verify JWT → Build UserContext
   └─ createCores(user) → AppCore
   └─ new RemoteShellProxy(appCore, transport)

6. Client-side Core proxy construction
   └─ createRemoteCoreProxy(AppCore.wcBindable, transport)
   └─ sync message → receive initial values
   └─ Emit connected=true
   └─ UI: Show <LoggedInView>, bind() to Core properties
```

### 6.2 Token Refresh

```
1. Token expiry approaches (detected client-side)
   └─ AuthShell.reconnect()
      └─ getTokenSilently({ cacheMode: "off" })
      └─ Establish new WebSocket connection
      └─ Return transport

2. Application calls proxy.reconnect(newTransport)
   └─ Send new sync message
   └─ bind() subscribers preserved → zero UI downtime

3. Server side
   └─ Old connection's RemoteShellProxy is disposed
   └─ New RemoteShellProxy constructed on new connection
   └─ Core state is freshly built (stateless)
      * Or carry over state via session store (application decision)
```

### 6.3 Logout

```
1. AuthShell.logout()
   └─ Close WebSocket
      └─ Server side: RemoteShellProxy disposed, Core becomes GC eligible
   └─ Call Auth0 SPA SDK logout()
      └─ Auth0-side session also cleared
   └─ Emit authenticated=false, connected=false
   └─ UI: Return to <LoggedOutView>
```

---

## 7. Type Definitions

### 7.1 Public Types

```typescript
// --- Shell side ---

/** AuthShell wc-bindable property value types */
export interface AuthShellValues {
  authenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
  error: AuthError | Error | null;
  connected: boolean;
}

/** Auth0 user profile (scope exposed by Shell) */
export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: unknown;
}

/** Authentication error */
export interface AuthError {
  error: string;
  error_description?: string;
  [key: string]: unknown;
}

/** initialize() options */
export interface AuthShellOptions {
  domain: string;
  clientId: string;
  audience: string;
  scope?: string;
  redirectUri?: string;
  cacheLocation?: "memory" | "localstorage";
  useRefreshTokens?: boolean;
}

// --- Server side ---

/** User context built after JWT verification */
export interface UserContext {
  sub: string;
  email?: string;
  name?: string;
  permissions: string[];
  roles: string[];
  orgId?: string;
  raw: Record<string, unknown>;
}

/** Server-side connection handler options */
export interface AuthenticatedConnectionOptions {
  auth0Domain: string;
  auth0Audience: string;
  allowedOrigins?: string[];
  createCores: (user: UserContext) => EventTarget;
  proxyOptions?: import("@wc-bindable/remote").RemoteShellProxyOptions;
}

/** Token verification options */
export interface VerifyTokenOptions {
  domain: string;
  audience: string;
  /** JWKS cache TTL in milliseconds (default: 600000 = 10 minutes) */
  jwksCacheTtl?: number;
}
```

---

## 8. Export Structure

### 8.1 Package Entry Points

```json
{
  "name": "@wc-bindable/hawc-auth0",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./server": {
      "import": "./dist/server/index.js",
      "types": "./dist/server/index.d.ts"
    }
  }
}
```

### 8.2 Client-Side Exports (`index.js`)

```typescript
// Shell
export { AuthShell } from "./shell/AuthShell.js";

// HTMLElement wrapper
export { Auth } from "./components/Auth.js";

// Bootstrap
export { bootstrapAuth } from "./bootstrapAuth.js";
export { getConfig } from "./config.js";

// Types
export type {
  AuthShellValues, AuthShellOptions, AuthUser, AuthError,
  IWritableConfig, IWritableTagNames,
} from "./types.js";
```

### 8.3 Server-Side Exports (`server/index.js`)

```typescript
// Helpers
export { createAuthenticatedWSS } from "./createAuthenticatedWSS.js";
export { verifyAuth0Token } from "./verifyAuth0Token.js";
export { extractTokenFromProtocol } from "./extractTokenFromProtocol.js";

// Reference implementation
export { UserCore } from "./UserCore.js";

// Types
export type {
  UserContext, AuthenticatedConnectionOptions, VerifyTokenOptions,
} from "./types.js";
```

---

## 9. Security Considerations

### 9.1 Required

| Item                                     | Measure                                                                  |
|------------------------------------------|--------------------------------------------------------------------------|
| Minimize token leakage risk              | Token held only inside Shell internals; not exposed as a public property |
| WebSocket Origin check                   | Validate `Origin` header server-side; reject anything outside allowedOrigins |
| Prevent access token / ID token confusion| Always specify `audience`; use only API access tokens                    |
| JWT signature verification               | Retrieve public keys from JWKS endpoint; verify RS256 signature          |
| Token expiration checks                  | Always verify `exp`, `iat`, `nbf` claims                                |

### 9.2 Recommended

| Item                                     | Measure                                                                  |
|------------------------------------------|--------------------------------------------------------------------------|
| Refresh Token Rotation                   | Enable in Auth0 tenant settings; avoids iframe-based silent renewal dependency |
| Shorten token lifetime                   | Set short access token expiration (recommended: 300–900 seconds)         |
| Permissions in token                     | Enable Auth0 RBAC and include permissions in the access token            |
| HTTPS / WSS required                     | Always use TLS in production                                             |

### 9.3 Subprotocol Header Caveats

When carrying a JWT in `Sec-WebSocket-Protocol`:

- The server **must echo back the same subprotocol string** in the `Sec-WebSocket-Protocol` response header (per WebSocket spec, the connection is closed if the server does not return one of the client's requested subprotocols)
- If logging middleware records `Sec-WebSocket-Protocol`, the token may leak. In production, suppress or mask header logging output

---

## 10. Auth0 Tenant Prerequisites

The following Auth0 tenant settings are required for this specification to function correctly.

### 10.1 Define an API (Resource Server)

1. Auth0 Dashboard → Applications → APIs → Create a new API
2. Set the **Identifier (audience)** (e.g., `https://api.example.com`)
3. **Signing Algorithm**: RS256

### 10.2 Enable RBAC

1. API settings → RBAC Settings
2. Turn **Enable RBAC** ON
3. Turn **Add Permissions in the Access Token** ON
4. Define required permissions (e.g., `storage:upload`, `storage:delete`)

### 10.3 Refresh Token Rotation

1. Auth0 Dashboard → Applications → Target app → Settings
2. Turn **Refresh Token Rotation** ON
3. Set **Refresh Token Expiration** (recommended: Absolute Lifetime 2592000s = 30 days)

### 10.4 Allowed Callback URLs / Origins

1. **Allowed Callback URLs**: Set the application URL
2. **Allowed Web Origins**: Set the same (required for silent renewal)
3. **Allowed Logout URLs**: Set the post-logout redirect destination

---

## 11. Usage Examples

### 11.1 Minimal Setup (React + useWcBindable)

```tsx
// App.tsx
import { useState, useEffect, useRef } from "react";
import { useWcBindable } from "@wc-bindable/react";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import type { Auth } from "@wc-bindable/hawc-auth0";
import type { AuthShellValues, AuthUser } from "@wc-bindable/hawc-auth0";
import "@wc-bindable/hawc-auth0"; // Register custom elements

// --- AppCore wcBindable declaration (shared with server) ---
const AppCoreDeclaration = {
  protocol: "wc-bindable" as const,
  version: 1 as const,
  properties: [
    { name: "currentUser", event: "hawc-auth0:user-changed" },
    { name: "permissions", event: "hawc-auth0:permissions-changed" },
    { name: "objects",     event: "hawc-s3:objects-changed" },
  ],
  commands: [
    { name: "requestUpload", async: true },
    { name: "deleteObject",  async: true },
  ],
};

interface AppCoreValues {
  currentUser: { sub: string; email?: string; name?: string } | null;
  permissions: string[];
  objects: string[];
}

function App() {
  // --- 1. Subscribe to <hawc-auth0> element via useWcBindable ---
  const [authRef, auth] = useWcBindable<Auth, AuthShellValues>({
    authenticated: false,
    user: null,
    loading: false,
    error: null,
    connected: false,
  });

  // --- 2. Remote Core proxy after authentication ---
  const [appValues, setAppValues] = useState<AppCoreValues>({
    currentUser: null,
    permissions: [],
    objects: [],
  });
  const proxyRef = useRef<ReturnType<typeof createRemoteCoreProxy> | null>(null);

  // --- 3. On authentication success: WebSocket connect → build Core proxy ---
  useEffect(() => {
    if (!auth.authenticated || auth.connected) return;

    const el = authRef.current;
    if (!el) return;

    let cancelled = false;

    (async () => {
      const transport = await el.connect("wss://api.example.com/hawc");
      if (cancelled) return;

      const proxy = createRemoteCoreProxy(AppCoreDeclaration, transport);
      proxyRef.current = proxy;

      // Subscribe to Remote Core properties via bind()
      const { bind } = await import("@wc-bindable/core");
      bind(proxy, (name, value) => {
        setAppValues((prev) => ({ ...prev, [name]: value }));
      });
    })();

    return () => { cancelled = true; };
  }, [auth.authenticated, auth.connected]);

  // --- 4. UI ---
  if (auth.loading) {
    return <div>Loading...</div>;
  }

  if (!auth.authenticated) {
    return (
      <>
        {/* hawc-auth0 element (hidden, manages auth state) */}
        <hawc-auth0
          ref={authRef}
          domain="your-tenant.auth0.com"
          client-id="your-client-id"
          audience="https://api.example.com"
          use-refresh-tokens
        />
        <button onClick={() => authRef.current?.login()}>
          Log in
        </button>
      </>
    );
  }

  if (!auth.connected) {
    return <div>Connecting to server...</div>;
  }

  return (
    <MainApp
      user={appValues.currentUser}
      permissions={appValues.permissions}
      objects={appValues.objects}
      onUpload={(file) => proxyRef.current?.invoke("requestUpload", file.name, file.size)}
      onDelete={(key) => proxyRef.current?.invoke("deleteObject", key)}
    />
  );
}
```

### 11.2 Subscribing to Remote Core with useWcBindable

A Remote Core Proxy is an EventTarget with a `wcBindable` declaration, so it can be subscribed to via `useWcBindable` if wrapped in an HTMLElement. However, since the proxy is not an HTMLElement, a **simple adapter hook** is provided instead.

```tsx
// useRemoteCore.ts — Convert RemoteCoreProxy to React state
import { useState, useEffect } from "react";
import { bind } from "@wc-bindable/core";
import type { RemoteCoreProxy } from "@wc-bindable/remote";

export function useRemoteCore<V extends object>(
  proxy: RemoteCoreProxy | null,
  initialValues: V,
): V {
  const [values, setValues] = useState<V>(initialValues);

  useEffect(() => {
    if (!proxy) return;
    return bind(proxy, (name, value) => {
      setValues((prev) => ({ ...prev, [name]: value }));
    });
  }, [proxy]);

  return values;
}
```

```tsx
// MainApp.tsx — Subscribe to proxy via useRemoteCore
import { useRemoteCore } from "./useRemoteCore";
import type { RemoteCoreProxy } from "@wc-bindable/remote";

function MainApp({ proxy }: { proxy: RemoteCoreProxy }) {
  const app = useRemoteCore<AppCoreValues>(proxy, {
    currentUser: null,
    permissions: [],
    objects: [],
  });

  return (
    <div>
      <h1>Welcome, {app.currentUser?.name ?? "User"}</h1>
      <p>Permissions: {app.permissions.join(", ")}</p>
      <ul>
        {app.objects.map((obj) => (
          <li key={obj}>
            {obj}
            <button onClick={() => proxy.invoke("deleteObject", obj)}>Delete</button>
          </li>
        ))}
      </ul>
      <button onClick={() => proxy.invoke("requestUpload", "new-file.txt", 1024)}>
        Upload
      </button>
    </div>
  );
}
```

### 11.3 Minimal Setup (Server)

```typescript
// server.ts
import { createAuthenticatedWSS } from "@wc-bindable/hawc-auth0/server";
import { AppCore } from "./AppCore.js";

const wss = createAuthenticatedWSS({
  auth0Domain: "your-tenant.auth0.com",
  auth0Audience: "https://api.example.com",
  allowedOrigins: ["https://app.example.com"],
  createCores: (user) => new AppCore(user),
});

wss.listen(3000);
console.log("HAWC Auth0 server listening on :3000");
```

### 11.4 With Token Refresh

```typescript
// Refresh scheduler
function scheduleTokenRefresh(
  authShell: AuthShell,
  proxy: RemoteCoreProxy,
  intervalMs: number = 4 * 60 * 1000, // 4 min (for a 5 min token)
) {
  const id = setInterval(async () => {
    try {
      const newTransport = await authShell.reconnect();
      proxy.reconnect(newTransport);
    } catch (e) {
      // Refresh failed → treat as logout
      clearInterval(id);
      await authShell.logout();
    }
  }, intervalMs);

  return () => clearInterval(id);
}
```

### 11.5 Step-Up Authentication

```typescript
// Client side
try {
  await proxy.invoke("deleteAllObjects");
} catch (e) {
  if (e.message === "STEP_UP_REQUIRED") {
    // Re-authentication flow
    await authShell.login({
      acr_values: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
    });
    // Retry after redirect
  }
}

// Server-side Core
async deleteAllObjects(): Promise<void> {
  if (!this._user.raw["amr"]?.includes("mfa")) {
    throw new Error("STEP_UP_REQUIRED");
  }
  // ... actual deletion logic
}
```

---

## 12. Comparison with hawc-s3

| Aspect              | hawc-s3 (remote)                           | hawc-auth0 (remote)                              |
|---------------------|--------------------------------------------|--------------------------------------------------|
| Core responsibility | S3 operations (presign, progress, complete)| User context retention + authorization decisions  |
| Shell responsibility| File selection + XHR upload                | Auth0 SDK operations + WebSocket connection setup |
| Connection timing   | At app startup (immediately per config)    | **Only after authentication succeeds**            |
| Token handling      | None (connection requires no auth)         | Access token sent during connection handshake     |
| Core construction trigger | On WebSocket connection (unconditional) | On WebSocket connection (**after token verification**) |
| reconnect() purpose | Recovery from network disconnection        | Token refresh + network recovery                  |
| Shell's wcBindable  | Proxy of Core properties                   | Auth state (authenticated, user, connected)       |

---

## 13. File Structure (Implementation)

```
packages/hawc-auth0/src/
├── shell/
│   └── AuthShell.ts          # EventTarget-based auth Shell
├── components/
│   ├── Auth.ts               # HTMLElement wrapper (extend existing)
│   └── AuthLogout.ts         # Logout button (existing)
├── server/
│   ├── index.ts              # Server-side exports
│   ├── createAuthenticatedWSS.ts  # WSS factory
│   ├── verifyAuth0Token.ts   # JWT verification utility
│   ├── extractTokenFromProtocol.ts # Protocol header parser
│   └── UserCore.ts           # Reference implementation
├── core/
│   └── AuthCore.ts           # Local version (existing, no changes)
├── types.ts                  # Type definitions (extend existing)
├── config.ts                 # Configuration (add remote settings)
├── bootstrapAuth.ts          # Initialization helper
├── exports.ts                # Client-side exports
└── raiseError.ts             # Error utility (existing)
```

---

## 14. Dependencies

### Client-Side (`dependencies`)
- `@auth0/auth0-spa-js` — Auth0 SPA SDK (dynamic import)
- `@wc-bindable/core` — `bind()`, `isWcBindable()`
- `@wc-bindable/remote` — `RemoteCoreProxy`, `WebSocketClientTransport`

### Server-Side (`dependencies`)
- `jose` — JWT verification, JWKS retrieval
- `@wc-bindable/remote` — `RemoteShellProxy`, `WebSocketServerTransport`
- `ws` — WebSocket server (may also be listed as `peerDependencies`)

---

## 15. Open Questions & Future Considerations

| Item                          | Options                                              | Recommended            |
|-------------------------------|------------------------------------------------------|------------------------|
| Server WebSocket library      | `ws` / Deno native / Node 22+ native                | `ws` (WebSocketLike compatible) |
| Session continuity            | Stateless (fresh Core on reconnect) / session store  | Stateless (initial)    |
| Multi-tenancy support         | `org_id` claim / per-tenant connections              | `org_id` (Auth0 Organizations) |
| Multiple Core bundling        | Single AppCore / namespaced multiplexing             | Single AppCore (initial) |
| Token refresh strategy        | Client-side timer / server-side detection + disconnect | Client-side timer     |
