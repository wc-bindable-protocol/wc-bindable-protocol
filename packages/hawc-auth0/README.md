# @wc-bindable/hawc-auth0

`@wc-bindable/hawc-auth0` is a headless authentication component for the wc-bindable ecosystem.

It is not a visual UI widget. It is an **I/O node** that connects Auth0 authentication to reactive state:

- **input / command surface**: `domain`, `client-id`, `trigger`
- **output state surface**: `authenticated`, `user`, `loading`, `error` (+ `connected` in remote mode)

Authentication state can be expressed declaratively in HTML, without writing OAuth flows, token management, or login/logout glue code in your UI layer.

`@wc-bindable/hawc-auth0` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/docs/articles/HAWC.md) architecture:

- **Core** (`AuthCore`) handles Auth0 SDK interaction, token management, and auth state
- **Shell** (`<hawc-auth0>`) connects that state to the DOM
- frameworks and binding systems consume it through [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol)

## Two deployment modes

`<hawc-auth0>` supports two distinct modes. They share the same element and the same bindable surface, but they differ in **where the access token lives** and **what application code can do with it**.

### Local mode — [README-LOCAL.md](README-LOCAL.md)

Auth0 runs in the browser. Your application reads the token from the element to attach `Authorization: Bearer` headers to outbound HTTP requests.

- `authEl.token` returns the current access token.
- `await authEl.getToken()` returns a fresh token.
- Token is still omitted from the wcBindable surface (not reachable via `data-wcs` / `bind()`).

Selected when no `mode` attribute is set and no `remote-url` attribute is set, or explicitly via `mode="local"`. This is the default.

### Remote mode — [README-REMOTE.md](README-REMOTE.md) · [SPEC-REMOTE.md](SPEC-REMOTE.md)

`<hawc-auth0>` acts as a gatekeeper to server-side Cores over an authenticated WebSocket. The token is sent only at the WebSocket handshake and during in-band `auth:refresh`. **Application code does not see the token.**

- `authEl.token` returns `null`.
- `authEl.getToken()` throws.
- `authEl.getTokenExpiry()` returns the `exp` claim for refresh scheduling without exposing token material.
- `connected` is added to the wcBindable surface (WebSocket transport state).

Selected by `mode="remote"` or implicitly by setting `remote-url`.

Paired with `<hawc-auth0-session target="auth" core="app-core">`, which owns the three-stage readiness sequence (authenticated → connected → initial sync) and exposes a single `ready` signal for `data-wcs`. Core declarations are looked up via `registerCoreDeclaration("app-core", decl)` at bootstrap.

## Install

```bash
npm install @wc-bindable/hawc-auth0 @auth0/auth0-spa-js
```

Remote deployments additionally need `@wc-bindable/remote`.

## Which doc should I read?

| If you… | Read |
|---------|------|
| Call `fetch('/api/...')` from browser JS with a Bearer token | [README-LOCAL.md](README-LOCAL.md) |
| Connect to a WebSocket backend that constructs server-side Cores after auth | [README-REMOTE.md](README-REMOTE.md) |
| Need the full remote protocol / server handler / error codes / threat model | [SPEC-REMOTE.md](SPEC-REMOTE.md) |
