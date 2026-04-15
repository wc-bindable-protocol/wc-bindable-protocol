# @wc-bindable/hawc-auth0

`@wc-bindable/hawc-auth0` is a headless authentication component for the wc-bindable ecosystem.

It is not a visual UI widget.
It is an **I/O node** that connects Auth0 authentication to reactive state.

With `@wcstack/state`, `<hawc-auth0>` can be bound directly through path contracts:

- **input / command surface**: `domain`, `client-id`, `trigger`
- **output state surface**: `authenticated`, `user`, `loading`, `error`, `connected`

> The access token is **not** part of the bindable surface (deliberate, for security). Retrieve it imperatively when needed via `await authEl.getToken()`.

This means authentication state can be expressed declaratively in HTML, without writing OAuth flows, token management, or login/logout glue code in your UI layer.

`@wc-bindable/hawc-auth0` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/docs/articles/HAWC.md) architecture:

- **Core** (`AuthCore`) handles Auth0 SDK interaction, token management, and auth state
- **Shell** (`<hawc-auth0>`) connects that state to the DOM
- frameworks and binding systems consume it through [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol)

## Why this exists

Authentication is one of the most common cross-cutting concerns in SPAs.
Login flows, token refresh, user profile retrieval, and route protection require significant imperative code.

`@wc-bindable/hawc-auth0` moves authentication logic into a reusable component and exposes the result as bindable state.

With `@wcstack/state`, the flow becomes:

1. `<hawc-auth0>` initializes the Auth0 client on connect
2. redirect callback is handled automatically
3. auth results return as `authenticated`, `user`, `loading`, `error`, `connected`
4. UI binds to those paths with `data-wcs` (access token is JS-only — see note above)

This turns authentication into **state transitions**, not imperative UI code.

## Install

```bash
npm install @wc-bindable/hawc-auth0
```

### Peer dependency

`@wc-bindable/hawc-auth0` requires the Auth0 SPA SDK:

```bash
npm install @auth0/auth0-spa-js
```

## Quick Start

### 1. Basic authentication with state binding

When `<hawc-auth0>` connects to the DOM, it initializes the Auth0 client, handles any pending redirect callback, and syncs authentication state.

```html
<script type="module" src="https://esm.run/@wcstack/state/auto"></script>
<script type="module" src="https://esm.run/@wc-bindable/hawc-auth0/auto"></script>

<wcs-state>
  <script type="module">
    export default {
      isLoggedIn: false,
      currentUser: null,
      authLoading: true,
    };
  </script>

  <hawc-auth0
    id="auth"
    domain="example.auth0.com"
    client-id="your-client-id"
    redirect-uri="/callback"
    audience="https://api.example.com"
    data-wcs="
      authenticated: isLoggedIn;
      user: currentUser;
      loading: authLoading
    ">
  </hawc-auth0>

  <template data-wcs="if: authLoading">
    <p>Authenticating...</p>
  </template>

  <template data-wcs="if: isLoggedIn">
    <p data-wcs="textContent: currentUser.name"></p>
    <hawc-auth0-logout target="auth">Sign Out</hawc-auth0-logout>
  </template>

  <template data-wcs="if: !isLoggedIn">
    <button data-authtarget="auth">Sign In</button>
  </template>
</wcs-state>
```

### 2. Login trigger from state

Use `trigger` to initiate login from a state method:

```html
<wcs-state>
  <script type="module">
    export default {
      isLoggedIn: false,
      currentUser: null,
      shouldLogin: false,

      login() {
        this.shouldLogin = true;
      },
    };
  </script>

  <hawc-auth0
    domain="example.auth0.com"
    client-id="your-client-id"
    data-wcs="
      authenticated: isLoggedIn;
      user: currentUser;
      trigger: shouldLogin
    ">
  </hawc-auth0>

  <template data-wcs="if: !isLoggedIn">
    <button data-wcs="onclick: login">Sign In</button>
  </template>
</wcs-state>
```

`trigger` is a **one-way command surface**:

- writing `true` starts `login()`
- it resets itself to `false` after completion
- the reset emits `hawc-auth0:trigger-changed`

```
external write:  false → true   No event (triggers login)
auto-reset:      true  → false  Dispatches hawc-auth0:trigger-changed
```

### 3. Popup login mode

Use the `popup` attribute to open a popup window instead of redirecting:

```html
<hawc-auth0
  domain="example.auth0.com"
  client-id="your-client-id"
  popup
  data-wcs="authenticated: isLoggedIn; user: currentUser">
</hawc-auth0>
```

### 4. Authenticated API requests

The access token is intentionally **not** part of the bindable surface (security — see §State Surface). To attach it to outbound requests, drive a small imperative bridge from APIs this package guarantees: the `hawc-auth0:authenticated-changed` event (declared in `wcBindable`) and the `getToken()` method (Methods table).

```html
<hawc-auth0
  id="auth"
  domain="example.auth0.com"
  client-id="your-client-id"
  audience="https://api.example.com">
</hawc-auth0>

<script type="module">
  const auth = document.getElementById("auth");
  await auth.connectedCallbackPromise;

  // Re-run on every login / logout transition.
  auth.addEventListener("hawc-auth0:authenticated-changed", async (e) => {
    if (!e.detail) return; // logged out — nothing to fetch
    const token = await auth.getToken();
    const res = await fetch("/api/users", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // ... render res into your UI / framework state of choice
  });
</script>
```

Two things this example deliberately does NOT do, because no public contract of this package supports it today:

- It does not bind `token` through `data-wcs` — the bindable surface omits `token` by design.
- It does not invoke a state method from a bindable property change. If you wire this through a state-binding system, surface `getToken()` from a button-driven `onclick:` handler (the convention shown in §2 above) or from your own listener registered on the auth element.

## State Surface vs Command Surface

`<hawc-auth0>` exposes two different kinds of properties.

### Output state (bindable auth state)

These properties represent the current authentication state and are the main HAWC surface:

| Property | Type | Description |
|----------|------|-------------|
| `authenticated` | `boolean` | `true` when the user is logged in |
| `user` | `AuthUser \| null` | User profile from Auth0 |
| `loading` | `boolean` | `true` during initialization or login |
| `error` | `AuthError \| Error \| null` | Authentication error |
| `connected` | `boolean` | `true` while the remote WebSocket transport is open (remote deployments only — see SPEC-REMOTE) |

The access **token** is intentionally NOT in the bindable surface. It is exposed as a JS-only getter (`authEl.token`) and via `await authEl.getToken()` for code paths that genuinely need to attach it to outbound requests.

### Input / command surface

These properties control authentication from HTML, JS, or `@wcstack/state` bindings:

| Property | Type | Description |
|----------|------|-------------|
| `domain` | `string` | Auth0 tenant domain |
| `client-id` | `string` | Auth0 application client ID |
| `redirect-uri` | `string` | Redirect URI after login |
| `audience` | `string` | API audience identifier |
| `scope` | `string` | OAuth scopes (default: `openid profile email`) |
| `trigger` | `boolean` | One-way login trigger |
| `popup` | `boolean` | Use popup instead of redirect |

## Architecture

`@wc-bindable/hawc-auth0` follows the HAWC architecture.

### Core: `AuthCore`

`AuthCore` is a pure `EventTarget` class.
It contains:

- Auth0 SPA SDK client initialization
- redirect callback handling
- login / logout / token management
- auth state transitions
- `wc-bindable-protocol` declaration

It can run headlessly in any runtime that supports `EventTarget`.

### Shell: `<hawc-auth0>`

`<hawc-auth0>` is a thin `HTMLElement` wrapper around `AuthCore`.
It adds:

- attribute / property mapping
- DOM lifecycle integration
- automatic initialization on connect
- declarative execution helpers such as `trigger` and `popup`

This split keeps the auth logic portable while allowing DOM-based binding systems such as `@wcstack/state` to interact with it naturally.

### Target injection

The Core dispatches events directly on the Shell via **target injection**, so no event re-dispatch is needed.

## Headless Usage (Core only)

`AuthCore` can be used without the Shell element. Since it declares `static wcBindable`, you can use `@wc-bindable/core`'s `bind()` to subscribe to its state:

```typescript
import { AuthCore } from "@wc-bindable/hawc-auth0";
import { bind } from "@wc-bindable/core";

const core = new AuthCore();

const unbind = bind(core, (name, value) => {
  console.log(`${name}:`, value);
});

await core.initialize({
  domain: "example.auth0.com",
  clientId: "your-client-id",
});

if (!core.authenticated) {
  await core.login();
}

unbind();
```

> **Note:** `AuthCore` requires browser globals (`location`, `history`) for redirect callback handling, and depends on `@auth0/auth0-spa-js` which itself requires a browser environment. "Headless" here means **without the Shell element**, not without a browser.

## Redirect Callback

When the user returns from Auth0's login page, the URL contains `code` and `state` query parameters. `<hawc-auth0>` automatically detects and processes this callback during initialization:

1. Calls `handleRedirectCallback()` on the Auth0 client
2. Removes `code` and `state` from the URL via `history.replaceState()`
3. Syncs authentication state (`authenticated`, `user`, `token`)

No additional configuration or route handling is required.

## Programmatic Usage

```javascript
const authEl = document.querySelector("hawc-auth0");

// Wait for initialization
await authEl.connectedCallbackPromise;

// Read state
console.log(authEl.authenticated); // boolean
console.log(authEl.user);          // user profile or null
console.log(authEl.token);         // access token or null
console.log(authEl.loading);       // boolean
console.log(authEl.error);         // error or null

// Access underlying Auth0 client
console.log(authEl.client);        // Auth0Client instance

// Methods
await authEl.login();
await authEl.logout();
const token = await authEl.getToken();
```

## Optional DOM Triggering

If `autoTrigger` is enabled (default), clicking an element with `data-authtarget` triggers the corresponding `<hawc-auth0>` element's login:

```html
<button data-authtarget="auth">Sign In</button>
<hawc-auth0 id="auth" domain="example.auth0.com" client-id="your-client-id"></hawc-auth0>
```

Event delegation is used — works with dynamically added elements. The `closest()` API handles nested elements (e.g., icon inside a button).

If the target id does not match any element, or the matched element is not a `<hawc-auth0>`, the click is silently ignored.

This is a convenience feature.
In wc-bindable applications, **state-driven triggering via `trigger`** is usually the primary pattern.

## Elements

### `<hawc-auth0>`

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `domain` | `string` | — | Auth0 tenant domain |
| `client-id` | `string` | — | Auth0 application client ID |
| `redirect-uri` | `string` | — | Redirect URI after login |
| `audience` | `string` | — | API audience identifier |
| `scope` | `string` | `openid profile email` | OAuth scopes |
| `cache-location` | `"memory" \| "localstorage"` | `memory` | Token cache location |
| `use-refresh-tokens` | `boolean` | `true` | Use refresh tokens for silent renewal. Set `use-refresh-tokens="false"` to opt out |
| `popup` | `boolean` | `false` | Use popup instead of redirect for login |

| Property | Type | Bindable? | Description |
|----------|------|-----------|-------------|
| `authenticated` | `boolean` | yes | `true` when logged in |
| `user` | `AuthUser \| null` | yes | User profile |
| `loading` | `boolean` | yes | `true` during initialization or login |
| `error` | `AuthError \| Error \| null` | yes | Error info |
| `connected` | `boolean` | yes | Remote WebSocket transport open (remote deployments) |
| `trigger` | `boolean` | yes | Set to `true` to execute login |
| `token` | `string \| null` | **no — JS only** | Access token. Reachable as `authEl.token`; absent from the `data-wcs` bindable surface for security |
| `client` | `Auth0Client` | no — JS only | Underlying Auth0 client instance |

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize the Auth0 client (called automatically on connect) |
| `login(options?)` | Start login (redirect or popup based on `popup` attribute) |
| `logout(options?)` | Logout from Auth0 |
| `getToken(options?)` | Get access token silently |

### `<hawc-auth0-logout>`

Declarative logout element. Clicking it triggers logout on the associated `<hawc-auth0>`.

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | `string` | — | ID of the `<hawc-auth0>` element |
| `return-to` | `string` | — | URL to redirect after logout |

Target resolution:
- If `target` is set: resolve by ID only. If the ID does not match a `<hawc-auth0>`, the click is silently ignored (no fallback).
- If `target` is not set: closest ancestor `<hawc-auth0>`, then first `<hawc-auth0>` in the document.

## wc-bindable-protocol

Both `AuthCore` and `<hawc-auth0>` declare `wc-bindable-protocol` compliance, making them interoperable with any framework or component that supports the protocol.

### Core (`AuthCore`)

`AuthCore` declares the bindable auth state that any runtime can subscribe to:

```typescript
static wcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "authenticated", event: "hawc-auth0:authenticated-changed" },
    { name: "user",          event: "hawc-auth0:user-changed" },
    { name: "token",         event: "hawc-auth0:token-changed" },
    { name: "loading",       event: "hawc-auth0:loading-changed" },
    { name: "error",         event: "hawc-auth0:error" },
  ],
};
```

Headless consumers call `core.login()` / `core.logout()` directly — no `trigger` needed.

### Shell (`<hawc-auth0>`)

The Shell deliberately **omits `token`** from the bindable surface (security) and **adds `connected`** for remote-transport state. The custom element extends that with `trigger` so binding systems can execute login declaratively:

```typescript
// AuthShell.wcBindable — the shape exposed to remote / DOM binding.
// Note: no `token`; instead `connected` is included.
static wcBindable = {
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

// <hawc-auth0> custom element extends the Shell with `trigger`.
static wcBindable = {
  ...AuthShell.wcBindable,
  properties: [
    ...AuthShell.wcBindable.properties,
    { name: "trigger", event: "hawc-auth0:trigger-changed" },
  ],
};
```

## TypeScript Types

```typescript
import type {
  AuthUser, AuthError,
  AuthCoreValues, AuthShellValues, AuthValues,
  Auth0ClientOptions,
} from "@wc-bindable/hawc-auth0";
```

```typescript
// User profile
interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: any;
}

// Auth error
interface AuthError {
  error: string;
  error_description?: string;
  [key: string]: any;
}

// Core (headless) — includes `token` because the Core is the local-only
// JS API; consumers are expected to read it directly.
interface AuthCoreValues {
  authenticated: boolean;
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  error: AuthError | Error | null;
}

// Shell — the bindable surface exposed to remote / DOM binding.
// Token is intentionally absent; `connected` is included.
interface AuthShellValues {
  authenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
  error: AuthError | Error | null;
  connected: boolean;
}

// <hawc-auth0> custom element — extends the Shell with `trigger`.
interface AuthValues extends AuthShellValues {
  trigger: boolean;
}
```

## Why this works well with `@wcstack/state`

`@wcstack/state` uses path strings as the only contract between UI and state.
`<hawc-auth0>` fits this model naturally:

- `<hawc-auth0>` initializes and manages the Auth0 lifecycle
- auth results return as `authenticated`, `user`, `loading`, `error`, `connected` (token is JS-only — use `getToken()`)
- UI binds to those paths without writing auth glue code

This makes authentication look like ordinary state updates.

## Framework Integration

Since `<hawc-auth0>` is HAWC + `wc-bindable-protocol`, it works with any framework through thin adapters from `@wc-bindable/*`.

### React

```tsx
import { useWcBindable } from "@wc-bindable/react";
import type { AuthValues } from "@wc-bindable/hawc-auth0";

function AuthGuard() {
  const [ref, { authenticated, user, loading }] =
    useWcBindable<HTMLElement, AuthValues>();

  return (
    <>
      <hawc-auth0 ref={ref}
        domain="example.auth0.com"
        client-id="your-client-id" />
      {loading && <p>Loading...</p>}
      {authenticated ? (
        <p>Welcome, {user?.name}</p>
      ) : (
        <button onClick={() => ref.current?.login()}>Sign In</button>
      )}
    </>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { useWcBindable } from "@wc-bindable/vue";
import type { AuthValues } from "@wc-bindable/hawc-auth0";

const { ref, values } = useWcBindable<HTMLElement, AuthValues>();
</script>

<template>
  <hawc-auth0 :ref="ref"
    domain="example.auth0.com"
    client-id="your-client-id" />
  <p v-if="values.loading">Loading...</p>
  <p v-else-if="values.authenticated">Welcome, {{ values.user?.name }}</p>
  <button v-else @click="ref.value?.login()">Sign In</button>
</template>
```

### Svelte

```svelte
<script>
import { wcBindable } from "@wc-bindable/svelte";

let authenticated = $state(false);
let user = $state(null);
let loading = $state(true);
</script>

<hawc-auth0 domain="example.auth0.com" client-id="your-client-id"
  use:wcBindable={{ onUpdate: (name, v) => {
    if (name === "authenticated") authenticated = v;
    if (name === "user") user = v;
    if (name === "loading") loading = v;
  }}} />

{#if loading}
  <p>Loading...</p>
{:else if authenticated}
  <p>Welcome, {user?.name}</p>
{:else}
  <p>Please sign in</p>
{/if}
```

### Solid

```tsx
import { createWcBindable } from "@wc-bindable/solid";
import type { AuthValues } from "@wc-bindable/hawc-auth0";

function AuthGuard() {
  const [values, directive] = createWcBindable<AuthValues>();

  return (
    <>
      <hawc-auth0 ref={directive}
        domain="example.auth0.com"
        client-id="your-client-id" />
      <Show when={!values.loading} fallback={<p>Loading...</p>}>
        <Show when={values.authenticated}
          fallback={<button>Sign In</button>}>
          <p>Welcome, {values.user?.name}</p>
        </Show>
      </Show>
    </>
  );
}
```

### Vanilla — `bind()` directly

```javascript
import { bind } from "@wc-bindable/core";

const authEl = document.querySelector("hawc-auth0");

bind(authEl, (name, value) => {
  console.log(`${name} changed:`, value);
});
```

## Configuration

```javascript
import { bootstrapAuth } from "@wc-bindable/hawc-auth0";

bootstrapAuth({
  autoTrigger: true,
  triggerAttribute: "data-authtarget",
  tagNames: {
    auth: "hawc-auth0",
    authLogout: "hawc-auth0-logout",
  },
});
```

## Design Notes

- `authenticated`, `user`, `loading`, `error`, and `connected` are **bindable output state**
- `token` is **JS-only** (`authEl.token` / `await authEl.getToken()`) and is intentionally absent from the bindable surface for security
- `domain`, `client-id`, `trigger` are **input / command surface**
- `trigger` is intentionally one-way: writing `true` executes login, reset emits completion
- initialization happens once on `connectedCallback` — changing `domain` or `client-id` after connect does not re-initialize
- redirect callback is automatically detected and processed during initialization
- `<hawc-auth0-logout>` with explicit `target` resolves by ID only (no fallback); without `target`, it falls back to closest ancestor, then first-in-document
- `popup` mode uses `loginWithPopup` — no redirect required, state syncs after popup closes
- Shell methods (`login()`, `logout()`, `getToken()`) await initialization before executing — safe to call immediately after connect
- `@auth0/auth0-spa-js` is a peer dependency — bring your own version
- `AuthCore` requires browser globals — "headless" means without the Shell, not without a browser

## License

MIT
