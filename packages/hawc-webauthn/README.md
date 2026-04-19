# @wc-bindable/hawc-webauthn

Declarative **WebAuthn / Passkeys** component for Web Components. Framework-agnostic passwordless authentication via `wc-bindable-protocol`.

```html
<hawc-webauthn
  id="passkey"
  rp-id="example.com"
  mode="register"
  user-verification="required"
  user-id="user-42"
  user-name="alice@example.com"
  user-display-name="Alice"
  challenge-url="/api/webauthn/challenge"
  verify-url="/api/webauthn/verify"
  data-wcs="status: registrationStatus; error: registrationError">
</hawc-webauthn>
```

Flip `trigger` to run the ceremony; observe `status`, `credentialId`, `user`, `error` through any wc-bindable adapter (React / Vue / Svelte / Solid / Preact / Alpine / Angular / vanilla).

---

## Architecture (Case C: thick Shell, control / data split)

The same HAWC architecture as `@wc-bindable/hawc-s3`. Blob bytes are replaced by credential material, but the shape is identical.

| Plane | Where | Responsibility |
|-------|-------|----------------|
| **Decision** | Server (`WebAuthnCore`) | Challenge issuance (per-request nonce, server-stored), attestation / assertion verification, credential persistence |
| **Execution** | Browser (`<hawc-webauthn>`) | `navigator.credentials.create()` / `.get()` — anchored to browser platform, requires a user gesture, speaks directly to the authenticator (Touch ID / Windows Hello / YubiKey) |
| **Observation** | wcBindable | `status`, `credentialId`, `user`, `error` — reactive in every framework |

```
  browser                              server
┌────────────────────┐  POST          ┌─────────────────────┐
│ <hawc-webauthn>    │ ───────────►   │ WebAuthnCore        │
│  Shell (execution) │  challenge     │  (decision)         │
│                    │ ◄───────────── │                     │
│  navigator.        │                │  IChallengeStore    │
│  credentials.      │                │  ICredentialStore   │
│  create()/.get()   │                │  IWebAuthnVerifier  │
│                    │  POST          │                     │
│  authenticator UI  │ ───────────►   │                     │
│                    │  verify        │                     │
│                    │ ◄───────────── │                     │
└────────────────────┘                └─────────────────────┘
```

Neither side can do the other's work:

- The **Core cannot** invoke the browser authenticator (the user-gesture requirement and the CTAP wire protocol are platform-anchored).
- The **Shell cannot** be trusted to generate or verify challenges (it would trivially accept its own attestations and the authenticator's signature would be worthless).

So the data plane lives in the browser and the control plane lives on the server — exactly as with S3 direct-upload.

---

## Status surface

```ts
type WebAuthnStatus =
  | "idle"
  | "challenging"   // Shell is fetching the challenge + option blob
  | "creating"      // browser is running navigator.credentials.create()
  | "asserting"     // browser is running navigator.credentials.get()
  | "verifying"     // server is verifying the attestation/assertion
  | "completed"
  | "error";
```

---

## Server setup

> **Always import from `@wc-bindable/hawc-webauthn/server` on Node.** The root entry (`@wc-bindable/hawc-webauthn`) re-exports the `<hawc-webauthn>` custom-element class, which extends `HTMLElement` and is evaluated at module-load time. In any Node-only runtime (server, Workers, build scripts, tests under `node:` environments) `HTMLElement` is undefined and the import fails immediately with `ReferenceError: HTMLElement is not defined`. The `/server` subpath exports the `WebAuthnCore`, stores, verifier adapter, `HttpError`, and `createWebAuthnHandlers` — none of those touch DOM globals, so they load cleanly under Node, Bun, Deno, and Cloudflare Workers. Browser code uses the root entry; Node code uses `/server`.

Install the optional peer dep for the reference verifier:

```sh
npm i @wc-bindable/hawc-webauthn @simplewebauthn/server
```

Wire up a core + the two Fetch-API handlers. Mount them on whatever HTTP framework you use — they speak the platform `Request` / `Response` so Node 18+, Bun, Deno, Cloudflare Workers, Hono, and Next.js route handlers all work.

```ts
import {
  WebAuthnCore,
  InMemoryChallengeStore,
  InMemoryCredentialStore,
  SimpleWebAuthnVerifier,
  createWebAuthnHandlers,
  HttpError,
} from "@wc-bindable/hawc-webauthn/server";

const core = new WebAuthnCore({
  rpId: "example.com",
  rpName: "Example Inc.",
  origin: "https://example.com",
  challengeStore: new InMemoryChallengeStore(),
  credentialStore: new InMemoryCredentialStore(),
  verifier: new SimpleWebAuthnVerifier(),
  userVerification: "required",
});

const handlers = createWebAuthnHandlers(core, {
  resolveSessionId: (req) => getSessionIdFromCookie(req),
  resolveUser: (userId) => db.users.get(userId),
  normalizeRegistrationUser: (req, proposed) => {
    const session = getSession(req);
    // Throwing HttpError(401) (or any Error with `.status`) becomes a
    // 401 response — without this convention auth failures collapse
    // into 500 and pollute infra alerts. See "Hook errors" below.
    if (!session) throw new HttpError(401, "sign in to register a passkey");
    return { ...proposed, id: session.userId };  // never trust client-supplied user.id
  },
  // Surface the user's existing credentialIds so the browser refuses
  // re-enrollment of the same authenticator instead of producing a
  // fresh attestation the Core would later reject.
  listExistingCredentials: async (_req, userId) =>
    (await db.credentials.byUser(userId)).map(c => c.credentialId),
});

// e.g. with Hono
app.post("/api/webauthn/challenge", (c) => handlers.challenge(c.req.raw));
app.post("/api/webauthn/verify",    (c) => handlers.verify(c.req.raw));
```

### Hook errors → HTTP status

Any handler hook can short-circuit to a specific status code by throwing `HttpError(status, message)` or any Error with a numeric `.status` in `[100, 600)`. Defaults are picked per failure phase so that infra alerts tuned on 5xx behave correctly:

| Endpoint | Failure source | Default status |
|----------|----------------|---------------:|
| `challenge` | `resolveSessionId` throws | 401 |
| `challenge` | other hook / Core throws | 500 |
| `verify` | `resolveSessionId` throws | 401 |
| `verify` | `core.verifyRegistration` / `verifyAuthentication` throws | 400 |
| `verify` | `resolveUser` throws | 500 |

The split inside `verify` matters: a Core verify failure is almost always client-caused (expired challenge, replay, wrong origin) and shouldn't page anyone, while a `resolveUser` failure is application territory (DB outage, IdP timeout) and must surface as 5xx. Authentication / authorization failures inside any hook should throw `HttpError(401)` or `HttpError(403)` so they neither pollute 5xx alerts nor get mis-classified as 400 client errors.

Caller-supplied `.status` overrides every default. `.status` values that are not integers in `[100, 600)` are ignored (the default for that phase applies) — this prevents an attacker-controlled error from downgrading a 500 to a 200.

### Authenticate enumeration defense

The handler **ignores client-supplied `userId` by default** in `mode: "authenticate"`. Without this, an unauthenticated caller could POST `{ mode: "authenticate", userId: "alice@example.com" }` to the challenge endpoint and read back Alice's `allowCredentials` — leaking which userIds have passkeys, the credential ids, and transports (e.g. presence of a platform authenticator). The default falls through to the usernameless / discoverable-credential flow (`allowCredentials: []`).

Opt in to userId-targeted authentication via `resolveAuthenticationUserId` — typical for step-up flows where the userId must match the signed-in session:

```ts
resolveAuthenticationUserId: (req, requested) => {
  const me = requireSignedInUser(req).id;
  if (requested && requested !== me) throw new HttpError(403, "step-up requires the same user");
  return me;
},
```

Return `null` to keep the request usernameless even when the client sent an id; throw `HttpError(...)` to refuse with a specific status.

### Duplicate-credential defense

Even with `listExistingCredentials` populating the browser's exclude list, the Core re-checks at verify time: a credential whose `credentialId` is already persisted is rejected (separate messages for "already registered to this user" vs "to a different user"). This prevents both duplicate-enrollment audit-log noise and silent ownership transfer if the store overwrites by `credentialId`.

### Swap the defaults for production

The in-memory stores are **single-process only** and lose state on restart. For any horizontally-scaled deployment, implement `IChallengeStore` against Redis/Memcached (challenges are short-lived) and `ICredentialStore` against your primary database (credentials are long-lived). Both interfaces are tiny — four methods each.

### Bring your own verifier

`SimpleWebAuthnVerifier` is an optional adapter. Any class that implements `IWebAuthnVerifier` works:

```ts
import type { IWebAuthnVerifier } from "@wc-bindable/hawc-webauthn/server";

class MyVerifier implements IWebAuthnVerifier {
  async verifyRegistration(params) { /* ... */ }
  async verifyAuthentication(params) { /* ... */ }
}
```

This mirrors how `hawc-s3` accepts a pluggable `IS3Provider`.

---

## Browser setup

Register the element (typically in your app entry). The **root entry is browser-only** — it pulls in the `<hawc-webauthn>` custom-element class, which extends `HTMLElement` and cannot be evaluated in Node. If you import this from a Node-only module (server boot, build script, isomorphic helper running under SSR) you will get `ReferenceError: HTMLElement is not defined` at module load. Server / Node code must use `@wc-bindable/hawc-webauthn/server` instead — see the boundary note in [Server setup](#server-setup).

```ts
import { bootstrapWebAuthn } from "@wc-bindable/hawc-webauthn";
bootstrapWebAuthn();  // defines <hawc-webauthn>
```

### Attributes

| Attribute | Required | Notes |
|-----------|----------|-------|
| `mode` | yes | `"register"` or `"authenticate"` |
| `challenge-url` | yes | POST endpoint backed by `handlers.challenge` |
| `verify-url` | yes | POST endpoint backed by `handlers.verify` |
| `rp-id` | no | Informational; server-returned `rpId` is authoritative |
| `user-verification` | no | `"required" | "preferred" | "discouraged"` (default `"preferred"`) |
| `attestation` | no | `"none" | "indirect" | "direct" | "enterprise"` (default `"none"`) |
| `user-id` | `register`: yes | Stable identifier for the credential owner |
| `user-name` | `register`: yes | Typically email |
| `user-display-name` | `register`: yes | Human-readable display name |
| `timeout` | no | Milliseconds (default `60000`) |

### Commands

- `element.start()` — run the ceremony (fetch challenge → call `navigator.credentials.*` → POST verify). Returns a `Promise<void>` that resolves on `completed` or rejects on `error`.
- `element.abort()` — cancel the in-flight ceremony. The browser's authenticator UI dismisses.
- Setting `element.trigger = true` runs `start()` declaratively and resets the flag when the ceremony ends — use this from any wc-bindable binding system (`data-wcs="trigger: submitClicked"`, React `useWcBindable` input, etc.).

---

## Wire format

**`POST challenge-url`** body
```json
{ "mode": "register", "user": { "id": "…", "name": "…", "displayName": "…" } }
```
or
```json
{ "mode": "authenticate", "userId": "…" }   // userId optional
```
Response is a `PublicKeyCredentialCreationOptionsJSON` or `PublicKeyCredentialRequestOptionsJSON` (base64url-encoded binary fields).

**`POST verify-url`** body
```json
{ "mode": "register" | "authenticate", "credential": { /* PublicKeyCredential serialized */ } }
```
Response: `{ "credentialId": "…", "user": { … } | null }`.

Both endpoints expect a session cookie / header the server-side `resolveSessionId` hook can decode; the Shell uses `credentials: "include"` on the fetch so cookies flow automatically.

---

## Why this component exists

Passkey adoption is being driven by every major SaaS right now. Integrating WebAuthn correctly requires the ceremony to straddle the browser and the server in a very specific way — and every framework's auth library reimplements that coordination from scratch.

With `hawc-webauthn`, the integration is declarative HTML plus two server handlers. The element exposes the same reactive surface through React, Vue, Svelte, Solid, Preact, Alpine, and Angular adapters because it speaks `wc-bindable-protocol` — the same 20-line protocol that backs every other HAWC component.

---

## Pairs naturally with `@wc-bindable/hawc-auth0`

Passkeys as a passwordless second factor fit cleanly inside an `<hawc-auth0>` session: once the Auth0 flow completes, a `<hawc-webauthn mode="register">` ceremony attaches a platform authenticator to the user's Auth0 profile, and subsequent `<hawc-webauthn mode="authenticate">` gates high-value actions.

---

## License

MIT
