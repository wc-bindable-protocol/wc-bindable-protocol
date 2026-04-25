# @wc-bindable/auth0 — Local mode

This document covers **local mode**: `<auth0-gate>` drives Auth0 in the browser and exposes the access token to application JS so it can attach `Authorization: Bearer` headers to outbound HTTP requests.

In the HAWC taxonomy this is the **Case A** shape: the Core remains in the browser because the Auth0 SPA SDK, redirect callback handling, and token lifecycle are browser-anchored.

For WebSocket-backed remote deployments where the token stays inside the element and is never handed to application code, see [README-REMOTE.md](README-REMOTE.md).

For the protocol / server-side details of the remote variant, see [SPEC-REMOTE.md](SPEC-REMOTE.md).

## Mode

Local mode is the default. It is selected when:

- no `mode` attribute is set **and** `remote-url` is absent **or** the empty string `""` (empty is treated as unset — see [README-REMOTE.md §Mode](README-REMOTE.md#mode)), or
- `mode="local"` is set explicitly.

In local mode:

- `authEl.token` returns the current access token (or `null`).
- `await authEl.getToken()` returns a fresh token.
- The token is **still omitted** from the wcBindable surface — it is JS-only, never reachable via `data-wcs` / `bind()`.

## Why this exists

Authentication is one of the most common cross-cutting concerns in SPAs. Login flows, token refresh, user profile retrieval, and route protection require significant imperative code.

`@wc-bindable/auth0` moves authentication logic into a reusable component and exposes the result as bindable state.

With `@wcstack/state`, the flow becomes:

1. `<auth0-gate>` initializes the Auth0 client on connect
2. redirect callback is handled automatically
3. auth results return as `authenticated`, `user`, `loading`, `error`
4. UI binds to those paths with `data-wcs` (access token is JS-only — see §State Surface)

## Install

```bash
npm install @wc-bindable/auth0
```

### Peer dependency

`@wc-bindable/auth0` requires the Auth0 SPA SDK:

```bash
npm install @auth0/auth0-spa-js
```

## Quick Start

### 1. Basic authentication with state binding

When `<auth0-gate>` connects to the DOM, it initializes the Auth0 client, handles any pending redirect callback, and syncs authentication state.

```html
<script type="module" src="https://esm.run/@wcstack/state/auto"></script>
<script type="module" src="https://esm.run/@wc-bindable/auth0/auto"></script>

<wcs-state>
  <script type="module">
    export default {
      isLoggedIn: false,
      currentUser: null,
      authLoading: true,
    };
  </script>

  <auth0-gate
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
  </auth0-gate>

  <template data-wcs="if: authLoading">
    <p>Authenticating...</p>
  </template>

  <template data-wcs="if: isLoggedIn">
    <p data-wcs="textContent: currentUser.name"></p>
    <auth0-logout target="auth">Sign Out</auth0-logout>
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

  <auth0-gate
    domain="example.auth0.com"
    client-id="your-client-id"
    data-wcs="
      authenticated: isLoggedIn;
      user: currentUser;
      trigger: shouldLogin
    ">
  </auth0-gate>

  <template data-wcs="if: !isLoggedIn">
    <button data-wcs="onclick: login">Sign In</button>
  </template>
</wcs-state>
```

`trigger` is a **one-way command surface**:

- writing `true` starts `login()`
- it resets itself to `false` after completion
- the reset emits `auth0-gate:trigger-changed`

```
external write:  false → true   No event (triggers login)
auto-reset:      true  → false  Dispatches auth0-gate:trigger-changed
```

### 3. Popup login mode

Use the `popup` attribute to open a popup window instead of redirecting:

```html
<auth0-gate
  domain="example.auth0.com"
  client-id="your-client-id"
  popup
  data-wcs="authenticated: isLoggedIn; user: currentUser">
</auth0-gate>
```

### 4. Authenticated API requests

This is the core reason to use local mode. The access token is omitted from the bindable surface (security — see §State Surface), so you drive outbound fetches from an imperative bridge: the `auth0-gate:authenticated-changed` event plus the `getToken()` method.

```html
<auth0-gate
  id="auth"
  domain="example.auth0.com"
  client-id="your-client-id"
  audience="https://api.example.com">
</auth0-gate>

<script type="module">
  const auth = document.getElementById("auth");
  await auth.connectedCallbackPromise;

  // Re-run on every login / logout transition.
  auth.addEventListener("auth0-gate:authenticated-changed", async (e) => {
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

> **Remote mode note:** if your deployment uses remote mode, `authEl.token` returns `null` and `authEl.getToken()` throws by design — application code does not see the token. See [README-REMOTE.md](README-REMOTE.md).

## State Surface vs Command Surface

`<auth0-gate>` exposes two different kinds of properties.

### Output state (bindable auth state)

These properties represent the current authentication state and are the main HAWC surface:

| Property | Type | Description |
|----------|------|-------------|
| `authenticated` | `boolean` | `true` when the user is logged in |
| `user` | `AuthUser \| null` | User profile from Auth0 |
| `loading` | `boolean` | `true` during initialization or login |
| `error` | `AuthError \| Error \| null` | Authentication error |

> In remote mode, `connected` is also part of the bindable surface (WebSocket transport state). See [README-REMOTE.md](README-REMOTE.md).

The access **token** is intentionally NOT in the bindable surface. In local mode it is exposed as a JS-only getter (`authEl.token`) and via `await authEl.getToken()` for code paths that genuinely need to attach it to outbound requests.

### Input / command surface

These properties control authentication from HTML, JS, or `@wcstack/state` bindings:

| Property | Type | Description |
|----------|------|-------------|
| `domain` | `string` | Auth0 tenant domain |
| `client-id` | `string` | Auth0 application client ID |
| `redirect-uri` | `string` | Redirect URI after login |
| `audience` | `string` | API audience identifier. Optional; when omitted, Auth0 issues an opaque access token usable only for the ID-token flow. Set this whenever application code attaches `Authorization: Bearer` headers to a backend, or when RBAC `permissions` / `roles` are needed. |
| `scope` | `string` | OAuth scopes (default: `openid profile email`) |
| `trigger` | `boolean` | One-way login trigger |
| `popup` | `boolean` | Use popup instead of redirect |

## Error contract

`@wc-bindable/auth0` follows an **observable error** contract: errors raised by the Auth0 SDK surface as state you bind to, not as rejected promises. This keeps UI code declarative — you render from `error` / `loading`, rather than wrapping every call in `try / catch`.

### Default: Auth0 SDK failures resolve, not reject

`await` on the following methods **resolves** even when the underlying Auth0 SDK call fails. The error is published to the `error` property and dispatched as `auth0-gate:error`, and `loading` is reliably cleared:

| Method | On Auth0 SDK failure |
|--------|----------------------|
| `authEl.initialize()` | resolves; `error` set, `loading` cleared |
| `authEl.login(options?)` | resolves; `error` set, `loading` cleared |
| `authEl.logout(options?)` | resolves; `error` set |
| `authEl.getToken(options?)` | resolves with `null`; `error` set |

```js
await authEl.login();          // does NOT throw on Auth0 errors
if (authEl.error) { ... }      // observe via state instead
```

The `trigger` one-way command follows the same contract — triggering a failed login leaves the failure in `authEl.error` and still resets `trigger` / dispatches `auth0-gate:trigger-changed`.

### Exceptions: these paths DO reject

A small set of failures are programmer / I/O errors that cannot be meaningfully represented as UI state, so they reject:

- **Precondition violations** (synchronous throw): calling `getToken()` before `initialize()`, calling `getToken()` in remote mode, missing `domain` / `client-id`, missing `remote-url` for `connect()`.
- **WebSocket I/O** (remote mode only): `connect()` / `reconnect()` reject on handshake failure; `refreshToken()` rejects on timeout, close, or send error. See [README-REMOTE.md](README-REMOTE.md).

### Practical rule

- Binding to UI → read `error` / `loading` / `authenticated`. Never rely on `await authEl.login()` throwing.
- Calling `connect()` / `reconnect()` / `refreshToken()` directly → wrap in `try / catch` or `.catch()`. The same error is also visible via `error`, so UI and caller-side handling can co-exist without double-reporting (pick one as authoritative in your code).

## Architecture

`@wc-bindable/auth0` follows the HAWC architecture.

### Core: `AuthCore`

`AuthCore` is a pure `EventTarget` class. It contains:

- Auth0 SPA SDK client initialization
- redirect callback handling
- login / logout / token management
- auth state transitions
- `wc-bindable-protocol` declaration

"Headless" here means **without the Shell element**, not without a browser. `AuthCore` depends on `@auth0/auth0-spa-js`, `globalThis.location`, and `globalThis.history`, so it requires a browser-like environment — it will not run under bare Node.js / Deno / Cloudflare Workers. The HAWC pattern is runtime-agnostic; this particular Core implementation is bound to the browser by its Auth0 SDK and redirect-callback dependencies. See §Headless Usage and the Design Notes at the end of this file for the full caveat.

### Shell: `<auth0-gate>`

`<auth0-gate>` is a thin `HTMLElement` wrapper around `AuthShell` (which itself wraps `AuthCore`). It adds:

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
import { AuthCore } from "@wc-bindable/auth0";
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

When the user returns from Auth0's login page, the URL contains `code` and `state` query parameters. `<auth0-gate>` automatically detects and processes this callback during initialization:

1. Calls `handleRedirectCallback()` on the Auth0 client
2. Removes `code` and `state` from the URL via `history.replaceState()`
3. Syncs authentication state (`authenticated`, `user`, `token`)

No additional configuration or route handling is required.

### Caveats

- **Only `code` and `state` are stripped.** Auth0 may also append `session_state` on success or `error` / `error_description` on failure. Those parameters are intentionally **left in place** so application code can inspect them — `error` / `error_description` in particular are useful for surfacing OIDC-level failures that never reach `handleRedirectCallback()`. If you don't want them visible in the address bar, strip them yourself after `await authEl.connectedCallbackPromise`.
- **SPA routers may not see the URL change.** `history.replaceState()` does not fire a `popstate` event, so React Router / Vue Router / TanStack Router will not re-evaluate routes after the strip. In practice this is fine — the strip only removes query parameters, not the path — but if your route depends on `useSearchParams()` / `useRoute().query`, force a re-read after `connectedCallbackPromise` resolves, or take ownership of the redirect URL yourself by intercepting before `<auth0-gate>` initializes.

## Programmatic Usage

```javascript
const authEl = document.querySelector("auth0-gate");

// Wait for initialization
await authEl.connectedCallbackPromise;

// Read state
console.log(authEl.authenticated); // boolean
console.log(authEl.user);          // user profile or null
console.log(authEl.token);         // access token or null (local mode only)
console.log(authEl.loading);       // boolean
console.log(authEl.error);         // error or null

// Access underlying Auth0 client
console.log(authEl.client);        // Auth0Client instance

// Methods
await authEl.login();
await authEl.logout();
const token = await authEl.getToken();  // local mode only
```

## Optional DOM Triggering

If `autoTrigger` is enabled (default), clicking an element with `data-authtarget` triggers the corresponding `<auth0-gate>` element's login:

```html
<button data-authtarget="auth">Sign In</button>
<auth0-gate id="auth" domain="example.auth0.com" client-id="your-client-id"></auth0-gate>
```

Event delegation is used — works with dynamically added elements. The `closest()` API handles nested elements (e.g., icon inside a button).

If the target id does not match any element, or the matched element is not a `<auth0-gate>`, the click is silently ignored.

This is a convenience feature. In wc-bindable applications, **state-driven triggering via `trigger`** is usually the primary pattern.

## Elements

### `<auth0-gate>`

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `domain` | `string` | — | Auth0 tenant domain |
| `client-id` | `string` | — | Auth0 application client ID |
| `redirect-uri` | `string` | — | Redirect URI after login |
| `audience` | `string` | — | API audience identifier (optional — omit for ID-token-only flows; required for Bearer-token API calls and for remote mode) |
| `scope` | `string` | `openid profile email` | OAuth scopes |
| `cache-location` | `"memory" \| "localstorage"` | `memory` | Token cache location |
| `use-refresh-tokens` | `boolean` | `true` | Use refresh tokens for silent renewal. Set `use-refresh-tokens="false"` to opt out |
| `popup` | `boolean` | `false` | Use popup instead of redirect for login |
| `mode` | `"local" \| "remote"` | inferred | Explicit deployment mode. Defaults to `local` unless `remote-url` is set to a non-empty value (empty `remote-url=""` is treated as unset — see [README-REMOTE.md](README-REMOTE.md)) |

| Property | Type | Bindable? | Description |
|----------|------|-----------|-------------|
| `authenticated` | `boolean` | yes | `true` when logged in |
| `user` | `AuthUser \| null` | yes | User profile |
| `loading` | `boolean` | yes | `true` during initialization or login |
| `error` | `AuthError \| Error \| null` | yes | Error info |
| `trigger` | `boolean` | yes | Set to `true` to execute login |
| `token` | `string \| null` | **no — JS only** | Access token. Reachable as `authEl.token`; absent from the `data-wcs` bindable surface for security. **Remote mode: always `null`.** |
| `client` | `Auth0Client` | no — JS only | Underlying Auth0 client instance |
| `mode` | `"local" \| "remote"` | no | Resolved mode (see attribute) |

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize the Auth0 client (called automatically on connect) |
| `login(options?)` | Start login (redirect or popup based on `popup` attribute) |
| `logout(options?)` | Logout from Auth0 |
| `getToken(options?)` | Get access token silently. **Remote mode: throws.** |

### `<auth0-logout>`

Declarative logout element. Clicking it triggers logout on the associated `<auth0-gate>`.

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | `string` | — | ID of the `<auth0-gate>` element |
| `return-to` | `string` | — | URL to redirect after logout |

Target resolution:
- If `target` is set: resolve by ID only — there is no fallback. If the ID does not match a `<auth0-gate>`, the click is ignored **and `console.warn` is emitted** so the misconfiguration is visible (mistyped ID, target removed from the DOM, etc.). The fallback chain is intentionally suppressed in this branch so a typo silently logging out the wrong element cannot happen.
- If `target` is not set: closest ancestor `<auth0-gate>`, then first `<auth0-gate>` in the document. When even those return nothing the click is silently ignored — the page legitimately has no auth element on screen (SSR, unrelated routes that still load the script), and warning would noise up unrelated logs.

## wc-bindable-protocol

Both `AuthCore` and `<auth0-gate>` declare `wc-bindable-protocol` compliance, making them interoperable with any framework or component that supports the protocol.

### Core (`AuthCore`)

`AuthCore` declares the bindable auth state that any runtime can subscribe to:

```typescript
static wcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "authenticated", event: "auth0-gate:authenticated-changed" },
    { name: "user",          event: "auth0-gate:user-changed" },
    { name: "token",         event: "auth0-gate:token-changed" },
    { name: "loading",       event: "auth0-gate:loading-changed" },
    { name: "error",         event: "auth0-gate:error" },
  ],
};
```

Headless consumers call `core.login()` / `core.logout()` directly — no `trigger` needed.

> Note: `AuthCore.wcBindable` includes `token`, but `AuthShell.wcBindable` and the `<auth0-gate>` element intentionally omit it (security). Binding systems work against the Shell, not the Core.

### Shell (`<auth0-gate>`)

The Shell deliberately **omits `token`** from the bindable surface and **adds `connected`** for remote-transport state. The custom element extends that with `trigger` so binding systems can execute login declaratively:

```typescript
// AuthShell.wcBindable — the shape exposed to remote / DOM binding.
// Note: no `token`; instead `connected` is included.
static wcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "authenticated", event: "auth0-gate:authenticated-changed" },
    { name: "user",          event: "auth0-gate:user-changed" },
    { name: "loading",       event: "auth0-gate:loading-changed" },
    { name: "error",         event: "auth0-gate:error" },
    { name: "connected",     event: "auth0-gate:connected-changed" },
  ],
};

// <auth0-gate> custom element extends the Shell with `trigger`.
static wcBindable = {
  ...AuthShell.wcBindable,
  properties: [
    ...AuthShell.wcBindable.properties,
    { name: "trigger", event: "auth0-gate:trigger-changed" },
  ],
};
```

## TypeScript Types

```typescript
import type {
  AuthUser, AuthError,
  AuthCoreValues, AuthShellValues, AuthValues,
  Auth0ClientOptions,
  AuthMode,
} from "@wc-bindable/auth0";
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
```

> `AuthShellValues` and `AuthValues` are used by the remote-capable Shell — see [README-REMOTE.md](README-REMOTE.md).

## Why this works well with `@wcstack/state`

`@wcstack/state` uses path strings as the only contract between UI and state. `<auth0-gate>` fits this model naturally:

- `<auth0-gate>` initializes and manages the Auth0 lifecycle
- auth results return as `authenticated`, `user`, `loading`, `error`
- UI binds to those paths without writing auth glue code

This makes authentication look like ordinary state updates.

## Framework Integration

Since `<auth0-gate>` is HAWC + `wc-bindable-protocol`, it works with any framework through thin adapters from `@wc-bindable/*`.

### TypeScript: declaring the custom elements in JSX / templates

Custom elements are not in the default JSX / Vue intrinsic-element table, so TypeScript flags `<auth0-gate ref={ref}>` as "no such element" even though the runtime works. Add a one-time module augmentation per project — typically in `src/types/auth0-gate.d.ts`:

```ts
// React (any version that exposes JSX.IntrinsicElements)
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { Auth, AuthLogout, AuthSession } from "@wc-bindable/auth0";

type Custom<T> = DetailedHTMLProps<HTMLAttributes<T>, T> & {
  // Attribute-style props you intend to write in JSX. All optional.
  domain?: string;
  "client-id"?: string;
  "redirect-uri"?: string;
  audience?: string;
  scope?: string;
  "remote-url"?: string;
  mode?: "local" | "remote";
  "cache-location"?: "memory" | "localstorage";
  "use-refresh-tokens"?: string | boolean;
  popup?: string | boolean;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "auth0-gate": Custom<Auth>;
      "auth0-logout": Custom<AuthLogout> & { target?: string; "return-to"?: string };
      "auth0-session": Custom<AuthSession> & {
        target?: string;
        core?: string;
        url?: string;
        "auto-connect"?: string | boolean;
      };
    }
  }
}
```

For Vue, augment `@vue/runtime-core`'s `GlobalComponents` instead:

```ts
import type { Auth, AuthLogout, AuthSession } from "@wc-bindable/auth0";

declare module "@vue/runtime-core" {
  interface GlobalComponents {
    "auth0-gate": Auth;
    "auth0-logout": AuthLogout;
    "auth0-session": AuthSession;
  }
}
```

Without this, the JSX / template type checker rejects the element at compile time even though the browser-side behaviour is correct. The augmentation file ships once per app, not per component.

### React

```tsx
import { useWcBindable } from "@wc-bindable/react";
import type { AuthValues } from "@wc-bindable/auth0";

function AuthGuard() {
  const [ref, { authenticated, user, loading }] =
    useWcBindable<HTMLElement, AuthValues>();

  return (
    <>
      <auth0-gate ref={ref}
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
import type { AuthValues } from "@wc-bindable/auth0";

const { ref, values } = useWcBindable<HTMLElement, AuthValues>();
</script>

<template>
  <auth0-gate :ref="ref"
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

<auth0-gate domain="example.auth0.com" client-id="your-client-id"
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
import type { AuthValues } from "@wc-bindable/auth0";

function AuthGuard() {
  const [values, directive] = createWcBindable<AuthValues>();

  return (
    <>
      <auth0-gate ref={directive}
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

const authEl = document.querySelector("auth0-gate");

bind(authEl, (name, value) => {
  console.log(`${name} changed:`, value);
});
```

## Configuration

```javascript
import { bootstrapAuth } from "@wc-bindable/auth0";

bootstrapAuth({
  autoTrigger: true,
  triggerAttribute: "data-authtarget",
  tagNames: {
    auth: "auth0-gate",
    authLogout: "auth0-logout",
  },
});
```

## Design Notes

- `authenticated`, `user`, `loading`, `error` are **bindable output state**
- `token` is **JS-only** in local mode (`authEl.token` / `await authEl.getToken()`) and is intentionally absent from the bindable surface for security
- `domain`, `client-id`, `trigger` are **input / command surface**
- `trigger` is intentionally one-way: writing `true` executes login, reset emits completion
- initialization happens once on `connectedCallback` — changing `domain` or `client-id` after connect does not re-initialize
- redirect callback is automatically detected and processed during initialization
- `<auth0-logout>` with explicit `target` resolves by ID only (no fallback); without `target`, it falls back to closest ancestor, then first-in-document
- `popup` mode uses `loginWithPopup` — no redirect required, state syncs after popup closes. **Failure modes** (popup blocked by browser, user closes the popup without authenticating, popup times out) all surface the same way: `error` is set to the raw `loginWithPopup` rejection (typically a `PopupCancelledError`, `PopupTimeoutError`, or `Error("Unable to open a popup for loginWithPopup")`) and `loading` is cleared. The promise from `authEl.login()` does **not** reject — the contract is observable via `error` / `auth0-gate:error`. Inspect `error.message` / `error.error` if you need to branch on the specific cause
- Shell methods (`login()`, `logout()`, `getToken()`) await initialization before executing — safe to call immediately after connect
- `@auth0/auth0-spa-js` is a peer dependency — bring your own version
- `AuthCore` requires browser globals — "headless" means without the Shell, not without a browser. The HAWC architecture's general claim that "Core is runtime-agnostic" is a property of the *pattern*, not a guarantee of every Core implementation: `AuthCore` depends on `@auth0/auth0-spa-js`, `globalThis.location`, and `globalThis.history`, so it will **not** run under Node.js / Deno / Cloudflare Workers. A different authentication backend with a Node-compatible SDK could be wrapped as a Core that does cross runtimes; this particular Core does not
- `connectedCallbackPromise` (also exposed on `<auth0-session>`) is a wc-bindable-protocol convention, not part of the Web Components standard. The element opts in via the `static hasConnectedCallbackPromise = true` marker, and the promise resolves once `initialize()` has settled. Treat it as a stable part of this package's public API; do not assume other custom-element libraries expose the same property
