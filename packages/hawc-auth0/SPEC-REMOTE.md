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
| `connected`    | `boolean`               | WebSocket connection is open (transport layer ready) |

> **Note**: The `token` property present in the local version is **intentionally not exposed** externally. The token is held only within the browser and used solely during the WebSocket handshake, minimizing the risk of token leakage via XSS.

#### Semantics of `connected`

`connected` reflects the **transport-layer** state: it becomes `true` when the WebSocket `open` event fires (i.e., the TCP + TLS handshake and the HTTP Upgrade have completed), and returns to `false` when the WebSocket `close` event fires.

This is a deliberate choice. AuthShell is a **gatekeeper**, not a proxy — it does not own a `RemoteCoreProxy` and therefore cannot observe the application-level sync exchange. The three stages of readiness are:

| Stage | What happened | Who knows | Signal |
|-------|---------------|-----------|--------|
| 1. WebSocket open | TCP/TLS + HTTP Upgrade completed | **AuthShell** | `connected = true` |
| 2. Token verified, Core built | Server accepted the token, constructed Cores, sent sync response | **RemoteCoreProxy** | Sync callback fires; proxy properties populated |
| 3. UI bindable | Application called `createRemoteCoreProxy()` + `bind()` | **Application** | Application-specific |

**Recommendation for application code:** Do not use `connected` alone to gate UI rendering. Instead, wait for the proxy's sync to complete before showing the authenticated view. A typical pattern:

```typescript
const transport = await authShell.connect(url);
// connected=true fires here (stage 1)

const proxy = createRemoteCoreProxy(AppCore.wcBindable, transport);
// stage 2 happens asynchronously inside the proxy

bind(proxy, (name, value) => {
  // First callback batch = sync response (stage 2 complete)
  // Safe to render UI now (stage 3)
});
```

If `<hawc-auth0 remote-url="...">` auto-connects, the element emits `connected=true` after the WebSocket opens. The application must still create the proxy and wait for sync before rendering Core-dependent UI.

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

### 3.4 Token Refresh Strategies

Access tokens expire (typically 300–900 seconds). Two strategies exist for keeping the session alive without losing Core state.

#### 3.4.1 Strategy A: In-Band Refresh (Recommended)

The WebSocket connection stays open. The client periodically obtains a fresh token from Auth0 and sends it to the server over the **existing** connection as a protocol-level command. The server re-verifies the token and updates the session's expiry without reconstructing Cores.

**Why this is preferred:**
- **Core state is fully continuous.** No re-sync, no property reset. An in-flight upload, a streaming AI response, or a multi-step wizard all survive the refresh.
- **No in-flight command loss.** Pending `invoke()` / `setWithAck()` calls are unaffected.
- **No UI flicker.** `bind()` subscribers see no state change at all — the refresh is invisible to the application layer.

**Shell side:**

```typescript
async refreshToken(): Promise<void> {
  const token = await this._core.client.getTokenSilently({ cacheMode: "off" });
  if (!token) raiseError("Failed to refresh access token.");
  // Send the fresh token over the existing WebSocket via the proxy
  // The server handles re-verification transparently
  await this._proxy.invoke("auth:refresh", token);
}
```

> `auth:refresh` is a reserved command name on the server-side connection handler, not on individual Cores. It updates the session's token/expiry without touching Core state.

**Server side (connection handler):**

```typescript
// Inside the connection handler, before delegating to RemoteShellProxy:
// Intercept "auth:refresh" commands at the transport layer
transport.onMessage((msg) => {
  if (msg.type === "cmd" && msg.name === "auth:refresh") {
    const newToken = msg.args[0] as string;
    verifyAuth0Token(newToken, { domain, audience })
      .then((user) => {
        session.user = user;
        session.expiresAt = Date.now() + tokenLifetimeMs;
        transport.send({ type: "return", id: msg.id, value: undefined });
      })
      .catch(() => {
        transport.send({ type: "throw", id: msg.id, error: { name: "Error", message: "Token refresh failed" } });
      });
    return; // Do not forward to RemoteShellProxy
  }
  // Forward all other messages to the proxy normally
  shellProxy.handleMessage(msg);
});
```

**Usage pattern (exp-based scheduling):**

Do NOT use a fixed `setInterval`. The access token's `exp` claim is the authoritative source of when the token expires. Decode it and schedule the refresh relative to `exp`, with a safety margin (default 30 seconds before expiry). This handles:
- Auth0 tenant-side changes to token lifetime — the schedule adapts automatically
- Network stalls or suspended tabs — `setTimeout` fires when the tab resumes, and if `exp` has already passed, the refresh runs immediately

```typescript
/**
 * Schedule token refresh based on the access token's `exp` claim.
 * Refreshes `marginMs` before expiry (default 30s).
 */
function scheduleTokenRefresh(
  authShell: AuthShell,
  marginMs: number = 30_000,
): () => void {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function refresh() {
    if (disposed) return;
    try {
      await authShell.refreshToken();
      // After refresh, schedule the next one based on the new token's exp
      scheduleNext();
    } catch {
      await authShell.logout();
    }
  }

  function scheduleNext() {
    if (disposed) return;
    const token = authShell.token;
    if (!token) return;

    // Decode the JWT payload (no verification — we trust our own token)
    const payload = JSON.parse(atob(token.split(".")[1]));
    const expiresAt = payload.exp * 1000; // seconds → ms
    const delay = Math.max(0, expiresAt - Date.now() - marginMs);

    timerId = setTimeout(refresh, delay);
  }

  scheduleNext();

  return () => {
    disposed = true;
    if (timerId !== null) clearTimeout(timerId);
  };
}
```

#### 3.4.2 Strategy B: WebSocket Reconnection (Fallback)

Close the old WebSocket and open a new one with a fresh token. Use `RemoteCoreProxy.reconnect(newTransport)` to attach the new transport to the existing proxy.

**What is preserved:** `bind()` subscriber registrations, proxy object identity.

**What is NOT preserved:** Server-side Core state. The server constructs fresh Cores on the new connection. The proxy receives a new `sync` response, which may differ from the previous state. This means:
- Upload progress resets to zero
- In-flight async commands are rejected (transport closed)
- UI may briefly show stale-then-updated values as the new sync arrives

This makes Strategy B unsuitable during active operations. It is appropriate for:
- Recovery from unexpected WebSocket disconnection (network failure, server restart)
- Environments where in-band refresh is not supported

```typescript
async reconnect(): Promise<ClientTransport> {
  const token = await this._core.client.getTokenSilently({ cacheMode: "off" });
  if (!token) raiseError("Failed to refresh access token.");

  this._closeWebSocket();

  const ws = new WebSocket(this._url, [`hawc-auth0.bearer.${token}`]);
  this._ws = ws;
  ws.addEventListener("close", () => {
    if (this._ws === ws) this._setConnected(false);
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(
      new Error(`[@wc-bindable/hawc-auth0] WebSocket reconnection failed: ${this._url}`)
    ), { once: true });
  });

  this._setConnected(true);
  return new WebSocketClientTransport(ws);
}
```

**Usage pattern (reconnection after disconnect):**

```typescript
async function handleDisconnect(authShell: AuthShell, proxy: RemoteCoreProxy) {
  const newTransport = await authShell.reconnect();
  proxy.reconnect(newTransport);
  // bind() subscriptions survive, but Core state is re-synced from scratch
}
```

#### 3.4.3 Recommended Approach

Use **in-band refresh** (Strategy A) for routine token renewal. Reserve **WebSocket reconnection** (Strategy B) for recovery from unexpected disconnections. This hybrid gives full state continuity during normal operation while still handling network failures gracefully.

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

### 5.3 Authorization Patterns

Authorization in the remote HAWC architecture operates at two levels: **declarative** (metadata-driven, enforced before the command reaches the Core) and **imperative** (hand-written logic inside the Core method). Both are needed; neither alone is sufficient.

#### 5.3.1 Declarative Authorization (Middleware Layer)

Simple permission gates — "this command requires permission X" — are pure metadata. Repeating them as `if (!user.permissions.includes(...))` in every method is error-prone boilerplate. Instead, declare the required permission in the `wcBindable.commands` metadata:

```typescript
static wcBindable: IWcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [ /* ... */ ],
  commands: [
    { name: "requestUpload",   async: true, requiresPermission: "storage:upload" },
    { name: "requestDownload", async: true, requiresPermission: "storage:read" },
    { name: "deleteObject",    async: true, requiresPermission: "storage:delete" },
    { name: "listObjects",     async: true },  // no permission required
  ],
};
```

An authorization middleware layer intercepts `cmd` messages **before** they reach `RemoteShellProxy` and checks the declared permission against the session's `UserContext.permissions`. If the check fails, the middleware sends a `throw` response immediately — the Core method is never invoked.

```typescript
// Conceptual middleware (wraps the transport's onMessage)
function withAuthorizationGuard(
  transport: ServerTransport,
  declaration: IWcBindable,
  user: UserContext,
): ServerTransport {
  const commandMap = new Map(
    (declaration.commands ?? []).map((c) => [c.name, c]),
  );

  const original = transport.onMessage.bind(transport);
  transport.onMessage = (handler) => {
    original((msg) => {
      if (msg.type === "cmd") {
        const cmd = commandMap.get(msg.name);
        const required = cmd?.requiresPermission;
        if (required && !user.permissions.includes(required)) {
          transport.send({
            type: "throw",
            id: msg.id,
            error: {
              name: "ForbiddenError",
              message: `Missing permission: ${required}`,
            },
          });
          return; // Block — never reaches the Core
        }
      }
      handler(msg);
    });
  };

  return transport;
}
```

**Benefits:**
- Single point of enforcement — no boilerplate in Core methods
- Impossible to forget — if the metadata says `requiresPermission`, it is enforced
- Auditable — scan `wcBindable.commands` to see the entire permission surface
- Testable — middleware is unit-testable independently of Core logic

> **Protocol impact:** `requiresPermission` is an extension field on `IWcBindableCommand`. It is optional and ignored by vanilla `RemoteShellProxy`. This means the middleware is an **opt-in layer** provided by `hawc-auth0/server`, not a breaking change to `@wc-bindable/remote`. If `@wc-bindable/remote` later adopts a built-in authorization hook, this middleware can be retired.

#### 5.3.2 Imperative Authorization (Inside the Core)

Not all authorization decisions can be expressed as a single permission string. Examples:
- **Resource-level checks:** "User can only delete objects they own"
- **Conditional logic:** "Upload allowed only if quota is not exceeded"
- **Multi-field checks:** "Requires `admin` role AND `org_id` matches the target tenant"

These remain inside the Core method:

```typescript
async deleteObject(key: string): Promise<void> {
  // Declarative check (requiresPermission: "storage:delete") already passed.
  // Now do the resource-level check:
  const metadata = await this._provider.headObject(key, this._requestOptions());
  if (metadata.owner !== this._user.sub) {
    throw new Error("Forbidden: you can only delete your own objects.");
  }
  await this._provider.deleteObject(key, this._requestOptions());
}
```

#### 5.3.3 Hybrid Summary

| Check type | Where | Example | Mechanism |
|------------|-------|---------|-----------|
| Simple permission gate | Middleware (before Core) | "requires storage:upload" | `requiresPermission` in wcBindable metadata |
| Resource-level ownership | Core method | "owner === user.sub" | Imperative `if` + `throw` |
| Quota / rate limit | Core method or middleware | "upload count < plan limit" | Imperative or custom middleware |
| Role-based | Either | "requires admin role" | `requiresRole` metadata (future) or imperative |

The declarative layer handles the common case (80%+). The imperative layer handles the rest. Neither replaces the other.

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
      └─ WebSocket open event fires
      └─ Emit connected=true          ← transport layer ready
      └─ Return transport

5. Server-side connection verification
   └─ Extract token → Verify JWT → Build UserContext
   └─ createCores(user) → AppCore
   └─ new RemoteShellProxy(appCore, transport)

6. Client-side Core proxy construction
   └─ createRemoteCoreProxy(AppCore.wcBindable, transport)
   └─ sync message → receive initial values  ← application layer ready
   └─ bind() callbacks fire with initial property values
   └─ UI: Show <LoggedInView>
```

### 6.2 Token Refresh (In-Band — Recommended)

```
1. Token expiry approaches (detected client-side via timer)
   └─ AuthShell.refreshToken()
      └─ getTokenSilently({ cacheMode: "off" })  → fresh access token
      └─ proxy.invoke("auth:refresh", token)      → sent over existing WebSocket

2. Server side
   └─ Connection handler intercepts "auth:refresh" command
   └─ Verify new token via JWKS
   └─ Update session expiry
   └─ Return success

3. Result
   └─ WebSocket connection unchanged
   └─ Core state unchanged — no re-sync, no property reset
   └─ bind() subscribers see nothing — refresh is invisible
   └─ In-flight commands continue uninterrupted
```

### 6.2.1 Recovery from Disconnection (WebSocket Reconnection)

```
1. WebSocket close event fires (network failure, server restart)
   └─ connected=false emitted
   └─ Application detects disconnection

2. Application calls authShell.reconnect()
   └─ getTokenSilently({ cacheMode: "off" })
   └─ New WebSocket with fresh token
   └─ connected=true emitted

3. Application calls proxy.reconnect(newTransport)
   └─ New sync message sent
   └─ Proxy receives fresh Core state (may differ from previous)
   └─ bind() subscriptions survive, but property values may change

4. Server side
   └─ Old RemoteShellProxy was already disposed (connection lost)
   └─ New connection → new token verification → new Cores
   └─ Core state starts fresh (stateless)

⚠ Note: In-flight commands from the old connection are rejected.
   UI may see state reset (e.g., upload progress → 0). This is
   expected for crash recovery, not routine token renewal.
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

### 9.0 Threat Model and Honest Boundaries

This section defines what this specification's security measures **do and do not protect against**. Readers should not assume that omitting `token` from wcBindable or using `cacheLocation: "memory"` constitutes a complete XSS defense.

#### What this design protects against

| Threat | Mitigation | Effectiveness |
|--------|-----------|---------------|
| Accidental token exposure via `bind()` / framework state | `token` not in wcBindable — never appears in React state, Vue reactive data, etc. | **Effective.** Eliminates the most common accidental leakage vector in SPA frameworks. |
| Token in DevTools component tree | Token not a public property on `<hawc-auth0>` — won't show in React DevTools, Vue Devtools property panels | **Effective** for casual inspection. The Auth0 SDK still holds it internally. |
| Token persisted across sessions | `cacheLocation: "memory"` (default) — token is lost on page reload | **Effective.** Prevents token surviving in `localStorage` across tabs/sessions. |
| Token sent repeatedly over the wire | Token used once (handshake only); subsequent messages carry no credentials | **Effective.** Reduces the window of interception compared to per-request `Authorization` headers. |

#### What this design does NOT protect against

| Threat | Why not | Real mitigation |
|--------|---------|-----------------|
| **XSS with arbitrary JS execution** | If an attacker can run `await auth0Client.getTokenSilently()`, they get the token regardless of whether hawc-auth0 exposes it. The Auth0 SPA SDK holds the token in a JS-reachable closure/cache. `cacheLocation: "memory"` does NOT mean "inaccessible to JS" — it means "not in `localStorage`". | **Prevent XSS in the first place.** CSP, input sanitization, dependency auditing. Once XSS is achieved, all in-browser secrets are compromised — this is a fundamental browser security boundary. |
| **Compromised browser extension** | Extensions with `webRequest` permissions can read all HTTP headers including `Sec-WebSocket-Protocol`. | Short token lifetime (300–900s) limits the damage window. There is no browser-side defense against a malicious extension with full permissions. |
| **Token theft via DevTools Network tab** | The `Sec-WebSocket-Protocol` header is visible in the Network tab. Any user (or attacker with physical access) can see it. | This is identical to the threat model of `Authorization: Bearer` headers on HTTP requests. Short token lifetime is the primary mitigation. |

#### The honest summary

Omitting `token` from wcBindable is a **defense-in-depth measure**, not a security boundary. It reduces the **surface area** — the number of places where token values appear in application code, framework state, and developer tooling — without eliminating the fundamental risk that any JavaScript running in the same origin can obtain the token from the Auth0 SPA SDK.

The phrase "minimize leakage risk" in §9.1 means exactly this: **minimize**, not eliminate. The true security boundary is XSS prevention. Everything in this specification operates **inside** that boundary, assuming XSS has not occurred. If XSS has occurred, all bets are off — the attacker has the same capabilities as the legitimate application code.

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

### 9.3 Subprotocol Header — Risks and Mitigations

Carrying a JWT directly in `Sec-WebSocket-Protocol` is the most common browser-compatible approach, but it introduces exposure surfaces that must be understood.

#### 9.3.1 Protocol-Level Requirements

- The server **must echo back the same subprotocol string** in the `Sec-WebSocket-Protocol` response header (per WebSocket spec, the connection is closed if the server does not return one of the client's requested subprotocols).

#### 9.3.2 Client-Side Exposure

The `Sec-WebSocket-Protocol` header is **visible in browser DevTools** (Network tab → WS frames → Headers) and accessible to **browser extensions** with `webRequest` permissions. This is the same exposure level as cookies and `Authorization` headers on HTTP requests — it is not unique to the subprotocol approach, but it must be acknowledged.

**Mitigations:**
- Keep access token lifetime **short** (300–900 seconds). Even if captured, the token expires quickly.
- Use `cacheLocation: "memory"` (default) so tokens are not persisted to `localStorage`/`sessionStorage`, reducing the window for XSS-based extraction.
- The token is used **once** (during the handshake) and is not stored or re-sent on subsequent WebSocket messages. Post-handshake, the connection itself is the session — no bearer token is attached to individual frames.

#### 9.3.3 Infrastructure Logging

CDNs and reverse proxies may log the `Sec-WebSocket-Protocol` header in access logs. Behaviour varies by provider:

| Provider         | Default behaviour                                                         | Mitigation                                        |
|------------------|---------------------------------------------------------------------------|---------------------------------------------------|
| **nginx**        | `$http_sec_websocket_protocol` is available but NOT logged by default in `access_log`. Custom log formats that include `$http_*` wildcards will capture it. | Audit `log_format` directives. Use `map` to redact the header in logs. |
| **Cloudflare**   | Enterprise log fields include request headers. Free/Pro plans do not log arbitrary headers by default.        | Disable `RequestHeaders` in Logpush field selection, or apply a log redaction rule. |
| **AWS ALB**      | ALB access logs include limited fields; `Sec-WebSocket-Protocol` is **not** among them. However, if WAF is configured with header inspection rules, the value may appear in WAF logs. | Review WAF logging rules if header inspection is enabled. |
| **Envoy / Istio**| Request headers can be logged via `%REQ(...)%` in access log format. Not included by default.                | Remove or mask `Sec-WebSocket-Protocol` from access log format strings. |

**General guidance:** When TLS termination occurs at a load balancer or CDN edge, audit the access log configuration of that layer. The header travels in plaintext only between the TLS termination point and the origin — ensure no logging occurs in that segment.

#### 9.3.4 Alternative: Short-Lived Ticket Pattern

For deployments where subprotocol header exposure is unacceptable (e.g., strict compliance environments, shared infrastructure with broad log access), a **short-lived ticket** pattern avoids placing the real access token in the WebSocket handshake entirely:

```
1. Client calls POST /auth/ws-ticket with Authorization: Bearer {access_token}
   (standard HTTPS request — token is in the Authorization header, not the URL)

2. Server verifies the access token, generates a single-use ticket (e.g., random UUID),
   stores it in a short-TTL cache (e.g., 30 seconds), and returns the ticket.

3. Client opens WebSocket with the ticket instead of the token:
   new WebSocket(url, ["hawc-auth0.ticket.{ticket}"])

4. Server looks up the ticket in the cache, retrieves the associated UserContext,
   deletes the ticket (single-use), and proceeds normally.
```

**Advantages:**
- The real access token never appears in WebSocket headers or logs.
- Tickets are single-use and expire in seconds — replay is effectively impossible.
- The access token is only ever sent over standard HTTPS (with full header protection).

**Trade-offs:**
- Requires an additional HTTP endpoint (`/auth/ws-ticket`).
- Adds one round-trip before the WebSocket connection.
- Server needs a short-TTL store (in-memory `Map` with TTL, Redis, etc.).

This pattern is listed as an **opt-in alternative**, not the default. The subprotocol approach remains the primary method for its simplicity and zero-infrastructure overhead. Implementations that support the ticket pattern should accept both `hawc-auth0.bearer.*` and `hawc-auth0.ticket.*` prefixes in `extractTokenFromProtocol`.

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
  //
  // `synced` tracks whether the proxy has received its initial sync
  // response from the server. This is the true "ready" signal — not
  // `auth.connected`, which only means the WebSocket is open (transport
  // layer). See §3.1 "Semantics of connected" for details.
  const [synced, setSynced] = useState(false);
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
      // connect() resolves after WebSocket open (connected=true)
      const transport = await el.connect("wss://api.example.com/hawc");
      if (cancelled) return;

      const proxy = createRemoteCoreProxy(AppCoreDeclaration, transport);
      proxyRef.current = proxy;

      // bind() fires the callback with initial values once sync completes.
      // The first batch of callbacks signals that the Core is ready.
      const { bind } = await import("@wc-bindable/core");
      let firstBatch = true;
      bind(proxy, (name, value) => {
        setAppValues((prev) => ({ ...prev, [name]: value }));
        if (firstBatch) {
          // Defer so all sync properties are applied before rendering
          queueMicrotask(() => { setSynced(true); firstBatch = false; });
        }
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

  // Gate on `synced`, not `auth.connected`.
  // connected=true means WebSocket is open; synced=true means the
  // server has verified the token, built Cores, and returned initial values.
  if (!synced) {
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

### 11.4 With Token Refresh (In-Band)

```typescript
// In-band refresh scheduled from the token's `exp` claim.
// See §3.4.1 for the full scheduleTokenRefresh() implementation.

// After connect + proxy setup:
const transport = await authShell.connect("wss://api.example.com/hawc");
const proxy = createRemoteCoreProxy(AppCoreDeclaration, transport);

// Start exp-based refresh scheduler (refreshes 30s before expiry)
const stopRefresh = scheduleTokenRefresh(authShell);

// On logout or unmount:
stopRefresh();
```

```typescript
// Reconnection after unexpected disconnect (recovery, not routine refresh):
async function handleDisconnect(authShell: AuthShell, proxy: RemoteCoreProxy) {
  try {
    const newTransport = await authShell.reconnect();
    proxy.reconnect(newTransport);
    // ⚠ Core state is re-synced from scratch — values may change
  } catch {
    await authShell.logout();
  }
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

### 15.1 Architecture & Protocol

| Item                          | Options                                              | Recommended            |
|-------------------------------|------------------------------------------------------|------------------------|
| Server WebSocket library      | `ws` / Deno native / Node 22+ native                | `ws` (WebSocketLike compatible) |
| Session continuity            | Stateless (fresh Core on reconnect) / session store  | Stateless (initial)    |
| Multi-tenancy support         | `org_id` claim / per-tenant connections              | `org_id` (Auth0 Organizations) |
| Multiple Core bundling        | Single AppCore / namespaced multiplexing             | Single AppCore (initial) |

### 15.2 Token & Authentication

| Item                          | Options                                              | Recommended            |
|-------------------------------|------------------------------------------------------|------------------------|
| Token refresh strategy        | In-band refresh (§3.4.1) / WS reconnection (§3.4.2)   | In-band refresh; WS reconnection for crash recovery only |
| Token handshake method        | Subprotocol bearer (default) / short-lived ticket (§9.3.4) | Subprotocol bearer (initial); ticket for strict compliance |
| Silent renewal vs. in-band refresh | Auth0 SPA SDK's iframe-based silent renewal keeps the Auth0 session alive and rotates the access token in background. In-band refresh (§3.4.1) sends the new token to the WS server. These are complementary, not alternatives: silent renewal feeds `getTokenSilently()`, which `refreshToken()` then forwards. However, in environments where iframe silent renewal is blocked (Safari ITP, third-party cookie restrictions), `useRefreshTokens: true` with Refresh Token Rotation is the only reliable path. | Enable `useRefreshTokens: true` (default). Do not depend on iframe-based silent renewal. |

### 15.3 Authorization

| Item                          | Options                                              | Recommended            |
|-------------------------------|------------------------------------------------------|------------------------|
| Declarative authorization     | `hawc-auth0/server` middleware (§5.3.1) / native `RemoteShellProxy` hook | Middleware in `hawc-auth0/server` (initial); propose `onBeforeCommand` hook upstream to `@wc-bindable/remote` later |
| `requiresRole` metadata       | Extend `IWcBindableCommand` with `requiresRole: string` | Future — after `requiresPermission` is validated in practice |

### 15.4 Multi-Tab & Concurrency

| Item                          | Description                                          | Considerations         |
|-------------------------------|------------------------------------------------------|------------------------|
| Concurrent tab token conflict | When multiple tabs share the same Auth0 SPA SDK session, simultaneous `getTokenSilently({ cacheMode: "off" })` calls can race. With Refresh Token Rotation enabled, the first call consumes the refresh token and the second may fail with `invalid_grant`. | Auth0 SPA SDK v2 mitigates this via internal locking (`useRefreshTokens` + `cacheLocation: "memory"`). Verify behavior with your Auth0 tenant. If still problematic, consider a `BroadcastChannel`-based coordinator that ensures only one tab refreshes at a time and shares the result. |
| Cross-tab state sync          | If one tab logs out, other tabs' WebSocket connections remain open until their token expires or the server detects staleness. | Options: (1) `BroadcastChannel` to propagate logout across tabs immediately. (2) Server-initiated close (§15.5). (3) Accept eventual consistency — in-band refresh will fail on the next cycle, triggering logout. Recommendation: option (3) for simplicity initially; add `BroadcastChannel` if users report confusion. |

### 15.5 Server-Initiated Actions

| Item                          | Description                                          | Considerations         |
|-------------------------------|------------------------------------------------------|------------------------|
| Server-initiated logout       | An admin force-revokes a user's session (e.g., via Auth0 Dashboard or Management API). The server needs to notify the client. | Options: (1) Close the WebSocket with a specific close code (e.g., `4401`). The client's `connected=false` handler checks the code and triggers `logout()`. (2) Send a custom `update` message (e.g., `{ type: "update", name: "auth:revoked", value: true }`) and let the client react. (3) Rely on in-band refresh failure — the next `auth:refresh` will fail because the token was revoked. Recommendation: (1) is cleanest. Define `4401` as the "session revoked" close code in this spec. |
| Server-side token expiry enforcement | If in-band refresh is late (client timer drift, suspended tab), the server holds a stale session. | Server should track `session.expiresAt` and close the WebSocket (code `4401`) if no refresh arrives within `exp + graceMs`. Grace period: 60 seconds. |

### 15.6 Operational Concerns

| Item                          | Description                                          | Considerations         |
|-------------------------------|------------------------------------------------------|------------------------|
| Connection rate limiting      | After login, the client immediately attempts `connect()`. A malicious or buggy client could flood the server with connection attempts. | Apply rate limiting at the WebSocket server level: per-IP connection rate, per-token connection rate. `createAuthenticatedWSS` should accept an optional `rateLimiter` hook. In production, this is typically handled by the reverse proxy (nginx `limit_req`, Cloudflare rate rules) rather than application code. |
| Observability hooks           | Authentication failures, token verification errors, and connection lifecycle events need to be observable for monitoring and alerting. | `createAuthenticatedWSS` and `handleConnection` should accept an optional `onEvent` callback: `onEvent(event: { type: "auth:success" \| "auth:failure" \| "auth:refresh" \| "connection:open" \| "connection:close"; user?: UserContext; error?: Error; })`. This allows integration with any logging/metrics system (OpenTelemetry, Datadog, CloudWatch, console) without coupling to a specific provider. |
| Health check endpoint         | Load balancers need a way to verify the server is healthy without authenticating. | Reserve a subprotocol `hawc-auth0.healthcheck` that the server responds to with an immediate close (code 1000). Alternatively, expose a separate HTTP `/health` endpoint alongside the WebSocket server. Recommendation: HTTP `/health` is simpler and more conventional. |
