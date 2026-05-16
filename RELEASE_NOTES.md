# v0.5.0

## `@wc-bindable/remote` — API additions

- **Acknowledged delivery**: new `setWithAck()` / `setWithAckOptions()` on `RemoteCoreProxy` for input writes that need server-side validation feedback. The fire-and-forget `set()` is unchanged. Servers advertise support via `capabilities.setAck` in the initial sync response; legacy servers without that capability cause `setWithAck` calls to reject cleanly instead of hanging.
- **Cancellation and timeouts**: `invokeWithOptions()` accepts `AbortSignal` and `timeoutMs`. `invoke()` and `setWithAck()` apply a default 30s client-side timeout (`timeoutMs: 0` disables it). The legacy `invokeWithOptions(name, options, ...args)` overload is **deprecated** in favor of the explicit `invokeWithOptions(name, args, options)` form, and scheduled for removal in v1.0.
- **Opt-in back-pressure**:
  - `createRemoteCoreProxy(decl, transport, { maxPendingInvocations })` — bound the in-flight `setWithAck`/`invoke` map.
  - `new WebSocketClientTransport(ws, { maxPreOpenQueue })` — bound the pre-open send buffer.
  - `new RemoteShellProxy(core, transport, { maxSyncUpdateBuffer })` — warn when sync-time getter side-effects flood the update buffer.
  - All defaults remain `Infinity` for backward compatibility.
- **Pluggable logger**: every remote class accepts `{ logger }`, and `Logger` / `consoleLogger` are exported so structured loggers (pino, winston, bunyan, …) can replace the default `console.warn` / `console.error` routing.
- **Sync robustness**: getter failures during the initial sync are reported via `getterFailures[]` so the client preserves its cached value instead of reverting to `undefined`. Properties whose getter returns `undefined` are explicitly enumerated in `undefinedProperties[]` so reset events fire correctly even on the very first sync. Older servers that omit either field continue to interoperate.

## Documentation

- Removed legacy HAWC references from README, the examples landing page, and `@wc-bindable/remote`'s README. RELEASE_NOTES retains historical mentions intact.
- Added `CLAUDE.md` describing the monorepo structure, the protocol contract, remote-package invariants, and test environment quirks for AI coding assistants.
- Added `.claude/skills/release.md` codifying the lockstep release procedure.

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.5.0 |
| `@wc-bindable/react` | 0.5.0 |
| `@wc-bindable/vue` | 0.5.0 |
| `@wc-bindable/svelte` | 0.5.0 |
| `@wc-bindable/angular` | 0.5.0 |
| `@wc-bindable/solid` | 0.5.0 |
| `@wc-bindable/preact` | 0.5.0 |
| `@wc-bindable/alpine` | 0.5.0 |
| `@wc-bindable/remote` | 0.5.0 |

---

# v0.4.0

## New Package

- **Remote** (`@wc-bindable/remote`) — Splits the HAWC Core/Shell boundary across a network. The server runs the real Core via `RemoteShellProxy`; the client gets a proxy `EventTarget` via `RemoteCoreProxy` that works transparently with `bind()` and all framework adapters.
  - `WebSocketClientTransport` / `WebSocketServerTransport` — Built-in WebSocket transport (browsers, Node.js, Deno, Bun)
  - Pluggable transport interface — Any FIFO channel (MessagePort, BroadcastChannel, WebTransport, etc.)
  - `set()` / `setWithAck()` — Fire-and-forget or acknowledged input setting
  - `invoke()` / `invokeWithOptions()` — Remote command invocation with timeout and AbortSignal support
  - `reconnect()` — Reattach transport after disconnect without losing `bind()` subscribers
  - Sync protocol — Atomic initial state snapshot with getter failure reporting
  - Error serialization — Server errors reconstructed on client with stack traces preserved

## Documentation

- **README**: Added `@wc-bindable/remote` to package table and Remote usage section
- **HAWC article**: Added "Remote: Core/Shell Separation Over the Network" section covering the network boundary as the third axis alongside runtime and framework boundaries

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.4.0 |
| `@wc-bindable/react` | 0.4.0 |
| `@wc-bindable/vue` | 0.4.0 |
| `@wc-bindable/svelte` | 0.4.0 |
| `@wc-bindable/angular` | 0.4.0 |
| `@wc-bindable/solid` | 0.4.0 |
| `@wc-bindable/preact` | 0.4.0 |
| `@wc-bindable/alpine` | 0.4.0 |
| `@wc-bindable/remote` | 0.4.0 (new) |

---

# v0.3.0

## New Framework Adapters

- **Preact** (`@wc-bindable/preact`) — `useWcBindable` hook, same API as React adapter
- **Alpine.js** (`@wc-bindable/alpine`) — `x-wc-bindable` directive plugin, binds properties directly into `x-data`

## Improvements

- **Callback ref pattern**: Switched React and Preact adapters from `useRef` to callback ref, fixing edge cases where element swaps in conditional rendering were not detected
- **Vue type fix**: Resolved build errors with `reactive()` type casting

## Examples — Full Framework Coverage

All 8 frameworks now have complete examples across 3 demo components (Counter, Fetch, Lit Todo):

| Framework | Counter | Fetch | Lit Todo |
|-----------|---------|-------|----------|
| Vanilla JS | o | o | o |
| React | o | o | o |
| Angular | o | o | o |
| Vue.js | o | o | o |
| Svelte | o | o | o |
| Alpine.js | o | o | o |
| Preact | o | o | o |
| SolidJS | o | o | o |

- Each example page includes a **Source Code** viewer showing the framework-specific binding code
- Examples index page organized as a framework x sample matrix table

## Node.js Support

- Added `examples/node/fetch/` — `MyFetchCore` (EventTarget) + `bind()` running in Node.js with zero DOM dependencies
- Validates HAWC Core/Shell separation: Core components are runtime-agnostic

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.3.0 |
| `@wc-bindable/react` | 0.3.0 |
| `@wc-bindable/vue` | 0.3.0 |
| `@wc-bindable/svelte` | 0.3.0 |
| `@wc-bindable/angular` | 0.3.0 |
| `@wc-bindable/solid` | 0.3.0 |
| `@wc-bindable/preact` | 0.3.0 (new) |
| `@wc-bindable/alpine` | 0.3.0 (new) |

---

# v0.2.0

## Features

- **Improved type safety**: Added generic type parameter `V` to `useWcBindable` (React / Vue) and `createWcBindable` (Solid), allowing explicit typing of bound values
- **Examples and documentation**: Added Vanilla, React, and Vue examples (Counter & Fetch), along with README usage guide and SPEC document

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.2.0 |
| `@wc-bindable/react` | 0.2.0 |
| `@wc-bindable/vue` | 0.2.0 |
| `@wc-bindable/svelte` | 0.2.0 |
| `@wc-bindable/angular` | 0.2.0 |
| `@wc-bindable/solid` | 0.2.0 |
