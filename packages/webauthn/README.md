# @wc-bindable/webauthn

Declarative **WebAuthn / Passkeys** component for Web Components. Framework-agnostic passwordless authentication via `wc-bindable-protocol`.

```html
<!-- rpId / userVerification / attestation are server-authoritative and
     configured on WebAuthnCore — see "Server setup" and the
     "Server-authoritative fields" note below. They are intentionally
     NOT attributes on <passkey-auth>. -->
<passkey-auth
  id="passkey"
  mode="register"
  user-id="user-42"
  user-name="alice@example.com"
  user-display-name="Alice"
  challenge-url="/api/webauthn/challenge"
  verify-url="/api/webauthn/verify"
  data-wcs="status: registrationStatus; error: registrationError">
</passkey-auth>
```

Flip `trigger` to run the ceremony; observe `status`, `credentialId`, `user`, `error` through any wc-bindable adapter (React / Vue / Svelte / Solid / Preact / Alpine / Angular / vanilla).

---

## Architecture (Case C: browser-anchored execution Shell)

The same HAWC architecture as `@wc-bindable/s3`. Blob bytes are replaced by credential material, but the shape is identical: the Core owns decisions, while the Shell owns the browser-anchored execution the server cannot delegate.

| Plane | Where | Responsibility |
|-------|-------|----------------|
| **Decision** | Server (`WebAuthnCore`) | Challenge issuance (per-request nonce, server-stored), attestation / assertion verification, credential persistence |
| **Execution** | Browser (`<passkey-auth>`) | `navigator.credentials.create()` / `.get()` — anchored to browser platform, requires a user gesture, speaks directly to the authenticator (Touch ID / Windows Hello / YubiKey) |
| **Observation** | wcBindable | `status`, `credentialId`, `user`, `error` — reactive in every framework |

```
  browser                              server
┌────────────────────┐  POST          ┌─────────────────────┐
│ <passkey-auth>    │ ───────────►   │ WebAuthnCore        │
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

**Core vs. Shell status progression.** The Shell `<passkey-auth>` passes through the full sequence because it drives `navigator.credentials.*` itself. The server-side `WebAuthnCore` only sees the control plane: it emits `idle → challenging → verifying → completed | error` and **never** emits `creating` or `asserting` (those states describe work happening in the browser, which the Core cannot observe). Code bound directly to a Core instance (e.g. a remote-proxy debugging surface) should not assume `creating`/`asserting` will arrive.

---

## Server setup

> **SECURITY REQUIRED — CSRF defense is mandatory.** The shipped handlers do **not** perform CSRF token checks or `Origin` header validation. The Shell sends `credentials: "include"` (cookies flow automatically), which makes both endpoints cross-site-forgeable unless YOU enforce CSRF defense in front of — or inside — your `resolveSessionId` hook. Without it, any third-party page can force-authenticate a logged-in user against your endpoints. See [CSRF and Origin header verification](#csrf-and-origin-header-verification) below for the minimum required defenses before you ship this to production. The WebAuthn signature check inside the verifier is NOT a substitute — a forged request still burns a challenge slot and produces a DoS vector.

> **Always import from `@wc-bindable/webauthn/server` on Node.** The root entry (`@wc-bindable/webauthn`) re-exports the `<passkey-auth>` custom-element class, which extends `HTMLElement` and is evaluated at module-load time. In any Node-only runtime (server, Workers, build scripts, tests under `node:` environments) `HTMLElement` is undefined and the import fails immediately with `ReferenceError: HTMLElement is not defined`. The `/server` subpath exports the `WebAuthnCore`, stores, verifier adapter, `HttpError`, and `createWebAuthnHandlers` — none of those touch DOM globals, so they load cleanly under Node, Bun, Deno, and Cloudflare Workers. Browser code uses the root entry; Node code uses `/server`.

Install the optional peer dep for the reference verifier:

```sh
npm i @wc-bindable/webauthn @simplewebauthn/server
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
} from "@wc-bindable/webauthn/server";

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

Any handler hook can short-circuit to a specific status code by throwing `HttpError(status, message)` or any Error with a numeric `.status` in `[400, 600)` (only 4xx / 5xx are honored — a thrown error cannot produce a 2xx/3xx response, preventing a compromised hook from masking auth failures as "ok"). Defaults are picked per failure phase so that infra alerts tuned on 5xx behave correctly:

| Endpoint | Failure source | Default status |
|----------|----------------|---------------:|
| `challenge` | `resolveSessionId` throws | 401 |
| `challenge` | other hook / Core throws | 500 |
| `verify` | `resolveSessionId` throws | 401 |
| `verify` | `core.verifyRegistration` / `verifyAuthentication` throws | 400 |
| `verify` | `resolveUser` throws | 500 |

The split inside `verify` matters: a Core verify failure is almost always client-caused (expired challenge, replay, wrong origin) and shouldn't page anyone, while a `resolveUser` failure is application territory (DB outage, IdP timeout) and must surface as 5xx. Authentication / authorization failures inside any hook should throw `HttpError(401)` or `HttpError(403)` so they neither pollute 5xx alerts nor get mis-classified as 400 client errors.

Caller-supplied `.status` overrides every default. `.status` values that are not integers in `[400, 600)` are ignored (the default for that phase applies) — this prevents an attacker-controlled error from downgrading a 500 to a 200 or emitting a redirect on a failure path.

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

### Timing side-channel note

`verifyAuthentication` has multiple early-return rejection paths (malformed credential id, missing challenge slot, expired challenge, unknown credential, userId mismatch) that complete in microseconds, while the success path runs a full ECDSA/RSA verify that takes tens of milliseconds. This timing delta is observable over the network and can support credential-id / user enumeration against a well-instrumented attacker. The implementation does NOT equalize these paths with a dummy verify — doing so would add a per-request ECDSA verify (DoS amplifier) and a poorly-chosen dummy credential leaks its own distinguishing timing. Deployments that treat credential-id secrecy as a security boundary should sit the Core behind a rate-limiter that rejects the Nth failed verify per client IP. The wire error strings are deliberately collapsed to a single "credential not recognized for this session" message across rejection reasons — that closes the message-content channel even though the timing channel remains.

### Duplicate-credential defense

Even with `listExistingCredentials` populating the browser's exclude list, the Core re-checks at verify time: a credential whose `credentialId` is already persisted is rejected (separate messages for "already registered to this user" vs "to a different user"). This prevents both duplicate-enrollment audit-log noise and silent ownership transfer if the store overwrites by `credentialId`.

### CSRF and Origin header verification

The Fetch-API handlers shipped here **do not themselves perform CSRF token checks or `Origin` / `Sec-Fetch-Site` header validation** — those are intentionally the responsibility of your `resolveSessionId` hook (and whatever middleware runs in front of the handlers). Two reasons:

1. Session-cookie decoding is already happening inside `resolveSessionId`, and CSRF defense is a property of that cookie surface (double-submit cookie, `SameSite=Strict|Lax`, sync token compare). Layering another CSRF scheme at the handler would duplicate — and potentially contradict — whatever the rest of your app does.
2. The Shell sets `credentials: "include"` on its fetch so cookie auth flows automatically. That same property makes the endpoints cross-site-forgeable if your session cookie does not opt into `SameSite` or your framework does not validate an anti-CSRF token.

Minimum recommended defenses (enforce inside `resolveSessionId` or a preceding middleware):

- `SameSite=Strict` (or at least `Lax`) on the session cookie, plus `Secure` and `HttpOnly`.
- Reject requests whose `Origin` header is neither the configured `origin` (passed to `WebAuthnCore`) nor same-site to the endpoint — matching the WebAuthn verifier's own origin check, but at the HTTP boundary.
- For frameworks that issue CSRF tokens (Rails / Django / Next.js Server Actions), require and validate the token in `resolveSessionId` before returning the sessionId. Throw `HttpError(403, "csrf")` on mismatch.

The `challenge` endpoint's default status for `resolveSessionId` throws is 401, but you can throw `HttpError(403, ...)` from the hook to surface a specific CSRF-failure status. Every WebAuthn ceremony also has an intrinsic origin check inside the verifier: `expectedOrigin` passed to `WebAuthnCore` is matched against the assertion's `clientDataJSON.origin`, so even if a CSRF bypass smuggled a request through, the authenticator signature would fail to verify — but relying on that as the only defense means the challenge slot still gets burned on every forged request, which is a DoS vector you want to close earlier.

### Swap the defaults for production

The in-memory stores are **single-process only** and lose state on restart. For any horizontally-scaled deployment, implement `IChallengeStore` against Redis/Memcached (challenges are short-lived) and `ICredentialStore` against your primary database (credentials are long-lived). Both interfaces are tiny — four methods each.

### Bring your own verifier

`SimpleWebAuthnVerifier` is an optional adapter. Any class that implements `IWebAuthnVerifier` works:

```ts
import type { IWebAuthnVerifier } from "@wc-bindable/webauthn/server";

class MyVerifier implements IWebAuthnVerifier {
  async verifyRegistration(params) { /* ... */ }
  async verifyAuthentication(params) { /* ... */ }
}
```

This mirrors how `s3-uploader` accepts a pluggable `IS3Provider`.

---

## Browser setup

Register the element (typically in your app entry). The **root entry is browser-only** — it pulls in the `<passkey-auth>` custom-element class, which extends `HTMLElement` and cannot be evaluated in Node. If you import this from a Node-only module (server boot, build script, isomorphic helper running under SSR) you will get `ReferenceError: HTMLElement is not defined` at module load. Server / Node code must use `@wc-bindable/webauthn/server` instead — see the boundary note in [Server setup](#server-setup).

```ts
import { bootstrapWebAuthn } from "@wc-bindable/webauthn";
bootstrapWebAuthn();  // defines <passkey-auth>
```

### Attributes

| Attribute | Required | Notes |
|-----------|----------|-------|
| `mode` | yes | `"register"` or `"authenticate"` |
| `challenge-url` | yes | POST endpoint backed by `handlers.challenge` |
| `verify-url` | yes | POST endpoint backed by `handlers.verify` |
| `user-id` | `register`: yes | Stable identifier for the credential owner |
| `user-name` | `register`: yes | Typically email |
| `user-display-name` | `register`: yes | Human-readable display name |
| `timeout` | no | Milliseconds (default `60000`) |

**Server-authoritative fields (intentionally not Shell attributes).** `rpId`, `userVerification`, and `attestation` are configured on the server-side `WebAuthnCore` (see [Server setup](#server-setup)) and returned to the browser inside the challenge option blob. There is deliberately no `rp-id` / `user-verification` / `attestation` attribute on `<passkey-auth>`: letting a page override server-issued values would let a compromised Shell downgrade `userVerification` from `"required"` to `"discouraged"`, or force `attestation` to `"none"` to hide a swapped authenticator. The Shell consumes the server's values verbatim.

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

With `passkey-auth`, the integration is declarative HTML plus two server handlers. The element exposes the same reactive surface through React, Vue, Svelte, Solid, Preact, Alpine, and Angular adapters because it speaks `wc-bindable-protocol` — the same 20-line protocol that backs every other HAWC component.

---

## Pairs naturally with `@wc-bindable/auth0`

Passkeys as a passwordless second factor fit cleanly inside an `<auth0-gate>` session: once the Auth0 flow completes, a `<passkey-auth mode="register">` ceremony attaches a platform authenticator to the user's Auth0 profile, and subsequent `<passkey-auth mode="authenticate">` gates high-value actions.

---

## License

MIT
