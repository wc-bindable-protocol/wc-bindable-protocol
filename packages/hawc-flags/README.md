# @wc-bindable/hawc-flags

`@wc-bindable/hawc-flags` is a headless feature-flag observation component for the wc-bindable ecosystem.

It is not a visual UI widget. It is a **pure observation node** that connects server-side flag evaluation to reactive browser-side state:

- **input / command surface**: `identify(userId, attrs)`, `reload()`
- **output state surface**: `flags`, `identified`, `loading`, `error`

Feature-flag state can be expressed declaratively in HTML, without writing SDK integration, identify calls, or streaming glue code in your UI layer.

`@wc-bindable/hawc-flags` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/packages/hawc/README.md) architecture (Case B — **Core on server, thin Shell**):

- **Server** (`FlagsCore`) handles SDK interaction, targeting-rule evaluation, identity management, and change propagation.
- **Browser** (`<hawc-flags>`) subscribes to the session proxy and re-dispatches the flag-shaped bindable surface onto itself.
- Frameworks and binding systems consume it through [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol).

## Why server-side evaluation

Feature-flag services let you write targeting rules like *"enable this for users in the EU on plan=pro with role=admin"*. Running that evaluation in the browser has two problems:

1. **Rule leakage.** Anyone can read `window.LaunchDarkly.__rules` in DevTools and see the full rollout strategy, including experiment names and cohorts that may be confidential.
2. **Identity leakage.** Client-side SDKs need a per-user identity (email, plan, permissions) — that identity has to be serialized into the browser, widening the attack surface.

`@wc-bindable/hawc-flags` is remote-only. Every flag evaluation runs on the server inside `FlagsCore`; the browser only observes results. A future `mode="local"` could be added for non-sensitive flags, but v1 does not ship it.

## Three-layer composition

The canonical setup pairs `<hawc-flags>` with `@wc-bindable/hawc-auth0`:

```html
<hawc-auth0 id="auth"
  domain="your.auth0.domain"
  client-id="..."
  remote-url="wss://api.example.com/flags">
</hawc-auth0>

<hawc-auth0-session
  id="auth-session"
  target="auth"
  core="flags-core">
</hawc-auth0-session>

<hawc-flags
  target="auth-session"
  data-wcs="flags: currentFlags; identified: flagsReady">
</hawc-flags>

<template data-wcs="if: currentFlags.new_checkout_flow?.enabled">
  <new-checkout></new-checkout>
</template>
<template data-wcs="if: !currentFlags.new_checkout_flow?.enabled">
  <old-checkout></old-checkout>
</template>
```

- `<hawc-auth0>` owns the Auth0 SDK and the authenticated WebSocket.
- `<hawc-auth0-session>` collapses the three-stage readiness sequence (authenticated → connected → synced) into a single `ready` signal.
- `<hawc-flags>` subscribes to the session's `RemoteCoreProxy` and re-dispatches flag events onto itself so `data-wcs` works.

The WebSocket URL is defined by `<hawc-auth0>`'s `remote-url`. Use the standard `@wc-bindable/hawc-auth0/server` handshake — your `createCores` factory returns a `FlagsCore`.

## Schema-less design

Feature-flag sets are inherently schema-less: adding a new flag server-side should not require a client-side redeploy. `static wcBindable` is static by design, so we cannot declare each flag as its own property.

The choice: expose a **single `flags` property carrying `Record<string, FlagValue>`**. Consumers access individual flags via dotted paths:

```js
values.flags.new_checkout_flow.enabled   // ✅
values.new_checkout_flow                 // ❌ — not part of the bindable surface
```

Implications:

- **Updates are whole-map.** Every change emits a new frozen map, not a delta. At ~100 flags * ~64 bytes per entry the payload is still under 10 KB per update — well within the budget for HAWC's WebSocket plane.
- **No client schema required.** The server can add a flag and the next `flags-changed` event carries it. No migration.
- **Reference-equality-based reactive frameworks see honest changes** (`Object.freeze({ ...next })`).

## Install

```bash
npm install @wc-bindable/hawc-flags
```

Pick whichever flag-service SDK matches your deployment (both are optional peer deps):

```bash
npm install flagsmith-nodejs   # Flagsmith
# or
npm install unleash-client     # Unleash
```

Any transport-layer dependency already comes from `@wc-bindable/hawc-auth0` (via `@wc-bindable/remote`); `@wc-bindable/hawc-flags` does not open its own socket.

## Server setup (Flagsmith)

> **Always import from `@wc-bindable/hawc-flags/server` on Node.** The root entry re-exports the `<hawc-flags>` custom element, which extends `HTMLElement`; importing it in a Node-only runtime fails with `ReferenceError: HTMLElement is not defined`. The `/server` subpath exports only DOM-free artifacts (`FlagsCore`, providers, types) and loads cleanly under Node, Bun, Deno, and Cloudflare Workers.

```ts
import { createAuthenticatedWSS } from "@wc-bindable/hawc-auth0/server";
import { FlagsCore, FlagsmithProvider } from "@wc-bindable/hawc-flags/server";

const provider = new FlagsmithProvider({
  environmentKey: process.env.FLAGSMITH_ENV_KEY!,
  enableLocalEvaluation: true,            // evaluate in-process after pulling env
  environmentRefreshIntervalSeconds: 60,  // re-pull env every minute
  pollingIntervalMs: 30_000,              // re-fetch each live identity every 30s; onChange fires only on diff
});

createAuthenticatedWSS({
  port: 8080,
  auth0Domain: "your.auth0.domain",
  auth0Audience: "https://api.example.com/",
  createCores: (user) => new FlagsCore({
    provider,
    userContext: user,  // auto-identify using user.sub + traits
  }),
  onTokenRefresh: (core, user) =>
    (core as FlagsCore).updateUserContext(user),
});
```

Register the `FlagsCore` declaration on the client:

```ts
import { registerCoreDeclaration, bootstrapAuth } from "@wc-bindable/hawc-auth0";
import { FlagsCore } from "@wc-bindable/hawc-flags/server";
import { bootstrapFlags } from "@wc-bindable/hawc-flags";

registerCoreDeclaration("flags-core", FlagsCore.wcBindable);
bootstrapAuth();
bootstrapFlags();
```

> The client-side `registerCoreDeclaration` call imports only the **declaration** (`FlagsCore.wcBindable`), not the Core's runtime — it is safe to import `FlagsCore` from the `/server` subpath in a browser bundle as long as your bundler tree-shakes the provider dependency. If that is a concern, copy the declaration into a shared `shared/flagsDecl.ts` and import it from both sides.

## Identity

`FlagsCore` derives the flag-service identity from the Auth0 `UserContext` passed to its constructor:

| Flagsmith trait | UserContext field |
|---|---|
| `email` | `user.email` |
| `name` | `user.name` |
| `org_id` | `user.orgId` |
| `permissions` | `user.permissions` (kept as array) |
| `roles` | `user.roles` (kept as array) |
| `userId` (identifier) | `user.sub` |

Flagsmith targeting rules can match `IN` / `NOT_IN` against array traits in local evaluation, so keeping `permissions` and `roles` as arrays (rather than joined strings) preserves rule expressiveness.

To override, call `flagsEl.identify(userId, attrs)` from the browser — this invokes `FlagsCore.identify()` over the session transport.

## Realtime updates

v1 ships with polling only. `pollingIntervalMs` (default 30 s) controls how often `FlagsmithProvider` re-fetches each identity's flags. Lower it for faster propagation; set to `0` to disable background polling and rely solely on explicit `reload()` calls.

The `realtime: true` option is accepted on `FlagsmithProviderOptions` for forward compatibility but currently logs a warning and falls back to polling. Full SSE integration against `realtime.flagsmith.com/sse` will land in a follow-up.

## Error contract

- **Provider failures** (`identify` / `subscribe` / `reload`) do not reject on the shell — they are published to `error` / `hawc-flags:error` and clear `loading`. Bind the state; do not `try / catch` these.
- **Transport failures** are handled one layer up by `<hawc-auth0-session>` — its `connected-changed: false` unwinds the subscription and the last-known flag map is retained until a fresh session lights up.
- **Precondition violations** (missing provider, dispose-after-use) throw synchronously.

## Server setup (Unleash)

Same shape as Flagsmith — just swap the Provider. Unleash's own SDK centralizes upstream polling on a single `refreshInterval`, so the Provider subscribes once to the SDK's `changed` event and fans out to every per-identity bucket. No per-identity timer.

```ts
import { createAuthenticatedWSS } from "@wc-bindable/hawc-auth0/server";
import { FlagsCore, UnleashProvider } from "@wc-bindable/hawc-flags/server";

const provider = new UnleashProvider({
  url: "https://unleash.example.com/api",
  appName: "web-frontend",
  clientKey: process.env.UNLEASH_SDK_KEY!,
  environment: "production",
  refreshInterval: 15_000,   // SDK re-fetches upstream every 15s; Provider fans out on `changed`
});

createAuthenticatedWSS({
  port: 8080,
  auth0Domain: "your.auth0.domain",
  auth0Audience: "https://api.example.com/",
  createCores: (user) => new FlagsCore({
    provider,
    userContext: user,
  }),
  onTokenRefresh: (core, user) =>
    (core as FlagsCore).updateUserContext(user),
});
```

`FlagIdentity` → `UnleashContext` mapping (default):

| UnleashContext field | FlagIdentity source |
|---|---|
| `userId` | `identity.userId` |
| `environment` | `options.environment` |
| `properties.<k>` | each `identity.attrs.<k>`, stringified (arrays joined with `,`, objects `JSON.stringify`-ed) |

Override with `options.contextBuilder: (identity) => UnleashContext` to produce a project-specific shape (e.g. mapping `orgId` to Unleash's `sessionId`, dropping attributes Unleash doesn't consume).

Each Unleash flag becomes `{ enabled, value }`, where `value` is `variant.payload.value` when the toggle is enabled with a variant payload, or the variant name otherwise, or `null`.

## Alternatives

For in-process tests and demos, swap `FlagsmithProvider` for `InMemoryFlagProvider`:

```ts
import { InMemoryFlagProvider, FlagsCore } from "@wc-bindable/hawc-flags/server";

const provider = new InMemoryFlagProvider({
  flags: [
    {
      key: "new_checkout_flow",
      defaultValue: { enabled: false, value: null },
      rules: [
        {
          key: "new_checkout_flow",
          value: { enabled: true, value: null },
          predicate: (id) => id.attrs?.roles instanceof Array && id.attrs.roles.includes("beta"),
        },
      ],
    },
  ],
});
```

`setFlag()` / `setFlags()` on the provider push changes to all subscribers synchronously — ideal for toggling UI state in browser tests.
