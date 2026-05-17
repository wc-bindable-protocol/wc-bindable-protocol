# v0.7.1

Patch release. Closes the long tail of review items raised against the
v0.7.0 PR, tightens the spec across every layer, and ships
[CONFORMANCE.md](CONFORMANCE.md) — a new test-vector document for
third-party implementers. All public surfaces from v0.7.0 remain
backward-compatible; additions are strictly additive.

## Spec & conformance

- **`CONFORMANCE.md` (new)** — first organized set of test vectors covering
  discovery, initial-sync, teardown, error codes, deferred-sync observer
  cleanup, remote dispose / reconnect / cache lifecycle, getter failures,
  malformed updates, set terminal/transient, and fingerprint mismatch
  handling.
- **SPEC.md** — clarifications across protocol model, roles, producer
  obligations, `bind()` state machine, layer-3 value model and `undefined`
  handling, JsonValue validation, `has`-trap contract scope, declaration
  fingerprint comparison rules, version-bump classification, minimum
  version policy, and normative naming for runtime entry points.
- **SPEC-extensions.md** — tightened on call-order preservation,
  microtask/macrotask semantics, duplicate pending-id rejection,
  at-most-once delivery wording for transport adapters, snapshotting
  during validation, safe-stringification, security notes around
  `setWithAck` / `invoke` and sensitive inputs, and Level 2 conformance
  for the "one snippet" demo.
- **Error code registry** — split code-emission rule by emission site;
  `WC_BINDABLE_DISPOSED` tightened to MUST; `set()` terminal throws
  pinned to `WC_BINDABLE_TERMINAL_FAILURE`; new
  `WC_BINDABLE_INVALID_ACK_OPTIONS` added; UNDECLARED registry broadened
  to cover consumer-side detection (RangeError-shaped).

## Added (additive only)

- **`@wc-bindable/core`** — new exports:
  - `getWcBindableDeclaration(target)` — sole discovery entry point that
    proxies / wrappers can implement isolated from `EventTarget`.
  - `MIN_COMPATIBLE_VERSION` (alias of `SUPPORTED_PROTOCOL_VERSION`) for
    forward-compat readers.
  - `isWcBindable()` parameter type broadened from `EventTarget` to
    `unknown` so it accepts proxies/non-EventTargets safely. Strictly
    broader, so existing call sites are unaffected.
- **`@wc-bindable/remote`** — new module and exports:
  - `buildDeclarationFingerprint`, `declarationFingerprintsEqual`, and the
    `DeclarationFingerprint` type for explicit producer/consumer
    declaration matching.
  - `DeclarationFingerprint` gains a `protocol` field so legacy producers
    that omit it continue to interoperate cleanly.

## Fixes

- **Core** — deferred-sync observer setup throw no longer leaks listeners
  (Issue C). The cleanup path now runs whether the observer setup throws
  before or after listener attachment.
- **Remote** — assorted internal-contradiction and gap fixes from the
  0.7.0 review queue (≥80 review items closed across spec / core /
  remote / docs).

## Tooling

- **`examples/stencil/components`** dep range bumped from `^0.6.0` to
  `^0.7.1` so the example resolves to the in-tree workspace instead of
  pulling a stale `0.6.1` from the registry. Example workspace only;
  not published.

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.7.1 |
| `@wc-bindable/react` | 0.7.1 |
| `@wc-bindable/vue` | 0.7.1 |
| `@wc-bindable/angular` | 0.7.1 |
| `@wc-bindable/svelte` | 0.7.1 |
| `@wc-bindable/alpine` | 0.7.1 |
| `@wc-bindable/lit` | 0.7.1 |
| `@wc-bindable/marko` | 0.7.1 |
| `@wc-bindable/mithril` | 0.7.1 |
| `@wc-bindable/preact` | 0.7.1 |
| `@wc-bindable/qwik` | 0.7.1 |
| `@wc-bindable/riot` | 0.7.1 |
| `@wc-bindable/solid` | 0.7.1 |
| `@wc-bindable/stencil` | 0.7.1 |
| `@wc-bindable/vanjs` | 0.7.1 |
| `@wc-bindable/mobx` | 0.7.1 |
| `@wc-bindable/rxjs` | 0.7.1 |
| `@wc-bindable/signals` | 0.7.1 |
| `@wc-bindable/remote` | 0.7.1 |

---

# v0.7.0

Substantial pre-1.0 minor release. Tightens the core protocol contract on
five long-standing gaps identified during review (initial-sync semantics,
teardown contract, version forward-compatibility, `set` / `invoke`
ordering, name-collision behavior) and adds a new `SPEC-extensions.md`
spec document for the input/command invocation surface and the remote
wire format (Extensions 1 and 2). All 19 packages stay lockstep
on `0.7.0`.

## Behavior changes (pre-1.0 minor — review before upgrading)

These are technically observable changes from `0.6.x`. Most consumers won't
notice; a couple of edge-case integrations might.

1. **Initial sync now uses the `in` operator** instead of
   `target[name] !== undefined`. A property that is explicitly assigned
   `undefined` on the target is now delivered to `onUpdate` on first sync
   (previously skipped). Properties that the target does not declare at
   all remain silently ignored — that case is unchanged. Frameworks that
   shallow-equal compare `undefined → undefined` will re-render once
   extra in this edge case.
2. **`vanjs` / `mobx` / `rxjs` / `signals` binders default to
   `syncOn: "connect"`.** `binder.bind(el)` no longer reads pre-connect
   state if `el` is not yet in the DOM — it defers the initial-value read
   until `el` is connected (observed via `MutationObserver` on
   `document`). For already-connected elements and headless targets, the
   behavior is unchanged. The previously-required pattern of "always call
   `bind()` after `appendChild()`" is no longer necessary; either order
   works.
3. **`@wc-bindable/remote` `RemoteCoreProxy` adds a `has` trap.**
   `"name" in proxy` now returns `true` for declared properties that the
   proxy has cached a value for (previously always `false` for declared
   properties). This is what makes core's new `in`-operator initial sync
   work transparently against a remote proxy. Code that uses `in` to
   detect "is this a non-proxy property" on a `RemoteCoreProxy` should
   migrate to an explicit check.
4. **`isWcBindable()` now accepts `version >= 1`** instead of
   `version === 1`. v1 adapters will accept declarations from future v2+
   components (per the new forward-compatibility policy: breaking
   changes require a new `protocol` identifier, not a version bump).
   Acceptance is strictly broader, so existing code is unaffected.

## Spec changes

- **SPEC.md** restructured:
  - Teardown contract is now normative — `bind()` MUST return a function
    that removes every listener and observer it installed, including the
    no-op return for non-bindable targets.
  - Initial-value synchronization mandates the `in` operator and explains
    why the previous `!== undefined` gate is insufficient.
  - Versioning section defines the forward-compatibility policy (`version
    >= N` accept, additive-only bumps, new `protocol` identifier required
    for breaks).
  - Property / input / command descriptors gain `name` uniqueness rules,
    explicit "ignore unknown fields" tolerance, and shared-event allowance
    documentation.
  - **Discovery Contract** section codifies that `target.constructor.wcBindable`
    is the sole discovery path and that proxies/wrappers MUST expose an
    equivalent isolated `constructor.wcBindable`.
  - **Trust Boundaries** section documents that `getter` runs on the
    consumer side and cannot cross a trust boundary as code.
  - **Event detail vs Property Read** documents that the event payload is
    authoritative when it diverges from a property re-read.
  - Reference implementation guards `HTMLElement` / `document` /
    `MutationObserver` with `typeof` so the code runs unmodified in
    Node / Deno / Workers.

- **SPEC-extensions.md** (new) extracts the optional input/command
  invocation contract from core:
  - `set` / `setWithAck` / `invoke` semantics, including explicit
    at-most-once / no-at-least-once rationale (non-idempotent inputs).
  - **Call-order preservation**: proxies MUST preserve caller order onto
    a single logical channel; wire-level ordering is the transport's
    responsibility (WebSocket inherits TCP order, so the documented
    `set` → `await invoke` pattern is safe on it).
  - `attribute` / `async` are declarative hints — core does not interpret
    them.
  - Initial-sync `undefined`-enumeration on the wire is explicitly tied
    to core's `in`-operator semantics.

## Added

- **`bind(target, onUpdate, options?)`** accepts a `BindOptions` third
  argument with `syncOn: "call" | "connect"`. `"call"` (default) is
  backward-compatible; `"connect"` defers the initial-value read for
  unconnected `HTMLElement`s.
- **`UnbindFn`** and **`SUPPORTED_PROTOCOL_VERSION`** are now exported
  from `@wc-bindable/core`.
- **Shadow DOM limitation** for `syncOn: "connect"` is documented in
  both SPEC.md and the `BindOptions` JSDoc — `MutationObserver` does not
  traverse shadow roots, so ref-owning adapters SHOULD use their own
  framework lifecycle hook with the default `syncOn: "call"`.

## Tooling

- **`.gitattributes`** (`* text=auto eol=lf` + binary list) and
  **`.editorconfig`** added to lock line endings to LF across platforms
  and enforce consistent indentation / final-newline / UTF-8. Pre-existing
  files were already LF in the index; the new files prevent future
  CRLF / LF drift from contributor-side `core.autocrlf` settings.

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.7.0 |
| `@wc-bindable/react` | 0.7.0 |
| `@wc-bindable/vue` | 0.7.0 |
| `@wc-bindable/angular` | 0.7.0 |
| `@wc-bindable/svelte` | 0.7.0 |
| `@wc-bindable/alpine` | 0.7.0 |
| `@wc-bindable/lit` | 0.7.0 |
| `@wc-bindable/marko` | 0.7.0 |
| `@wc-bindable/mithril` | 0.7.0 |
| `@wc-bindable/preact` | 0.7.0 |
| `@wc-bindable/qwik` | 0.7.0 |
| `@wc-bindable/riot` | 0.7.0 |
| `@wc-bindable/solid` | 0.7.0 |
| `@wc-bindable/stencil` | 0.7.0 |
| `@wc-bindable/vanjs` | 0.7.0 |
| `@wc-bindable/mobx` | 0.7.0 |
| `@wc-bindable/rxjs` | 0.7.0 |
| `@wc-bindable/signals` | 0.7.0 |
| `@wc-bindable/remote` | 0.7.0 |

---

# v0.6.1

Patch release. No source changes from v0.6.0.

## Why

The v0.6.0 npm publish completed cleanly for 17 of 19 packages, but `@wc-bindable/qwik` and `@wc-bindable/stencil` ended up in an inconsistent state on the registry: their `0.6.0` tarballs were uploaded, but the package metadata index was missing (`npm view` returned 404 while `registry.npmjs.org/<pkg>/0.6.0` returned 200). npm permanently reserves a version slot once a tarball lands, so `0.6.0` cannot be re-published for those two scopes.

To restore lockstep alignment across the family, **all 19 packages were re-cut at `0.6.1`**.

## Notes

- `^0.6.0` dep ranges in adapters already accept `0.6.1` (npm caret rule for `0.x.y` with `x > 0`), so inter-package specifiers were left untouched.
- The v0.6.0 git tag remains in place, but users should install `0.6.1` or newer.

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.6.1 |
| `@wc-bindable/react` | 0.6.1 |
| `@wc-bindable/vue` | 0.6.1 |
| `@wc-bindable/angular` | 0.6.1 |
| `@wc-bindable/svelte` | 0.6.1 |
| `@wc-bindable/alpine` | 0.6.1 |
| `@wc-bindable/lit` | 0.6.1 |
| `@wc-bindable/marko` | 0.6.1 |
| `@wc-bindable/mithril` | 0.6.1 |
| `@wc-bindable/preact` | 0.6.1 |
| `@wc-bindable/qwik` | 0.6.1 |
| `@wc-bindable/riot` | 0.6.1 |
| `@wc-bindable/solid` | 0.6.1 |
| `@wc-bindable/stencil` | 0.6.1 |
| `@wc-bindable/vanjs` | 0.6.1 |
| `@wc-bindable/mobx` | 0.6.1 |
| `@wc-bindable/rxjs` | 0.6.1 |
| `@wc-bindable/signals` | 0.6.1 |
| `@wc-bindable/remote` | 0.6.1 |

---

# v0.6.0

Substantial minor release. Adds **10 new adapter packages**, bringing the family to 19 total. Existing adapters from v0.5.0 are unchanged at the API level — no source-level migration is required.

> **Publish note:** v0.6.0 only made it cleanly to 17 of 19 packages on npm. See [v0.6.1](#v061) for the fix. Users should install `0.6.1` or newer.

## New Framework Adapters

- **Lit** (`@wc-bindable/lit`) — `WcBindableController` (Lit ReactiveController integration)
- **Marko** (`@wc-bindable/marko`) — `wcBindable()` helper, supports both Marko 5 (class components) and Marko 6 (Tags API via `<lifecycle>`)
- **Mithril.js** (`@wc-bindable/mithril`) — `createWcBindable()` with `oncreate` / `onremove` hooks; hooks must attach to the bindable element vnode directly
- **Qwik** (`@wc-bindable/qwik`) — `useWcBindable()`. Qwik 1.x via the main export; Qwik 2.x via the experimental `/v2` export
- **Riot.js** (`@wc-bindable/riot`) — `createWcBindable()` with `{ update }` callback to trigger re-renders; bind from `onMounted` with `this.$("my-input")`
- **Stencil** (`@wc-bindable/stencil`) — `WcBindableController` (Stencil custom-element controller)
- **VanJS** (`@wc-bindable/vanjs`) — `createWcBindable()` exposes `binder.states.<name>` (one `van.state` per declared property). `bind()` should be deferred with `queueMicrotask` after `van.add()` so initial-sync sees post-connect values

## New Non-Framework Reactivity Adapters

- **MobX** (`@wc-bindable/mobx`) — `createWcBindable()` exposes `binder.state.<name>`, backed by a single `observable.object`. Writes are wrapped in `runInAction`; lazy keys are added with `set()`.
  - **Design note**: state is created with `{ deep: false }` so MobX does *not* deep-enhance assigned arrays or plain objects. This preserves the wc-bindable contract that property values are passed as-is (`state.items === emittedArray` holds for any value the component dispatches). The trade-off — mutating a nested array/object in place will not trigger reactions — matches the protocol's intent: components publish whole values, consumers don't mutate them.
- **RxJS** (`@wc-bindable/rxjs`) — `createWcBindable()` exposes `binder.subjects.<name>` (one `BehaviorSubject` per declared property), subscribable with standard RxJS operators.
- **TC39 Signals** (`@wc-bindable/signals`) — `createWcBindable()` exposes `binder.signals.<name>` (one `Signal.State` per declared property) via `signal-polyfill`. Observe by wrapping reads in `Signal.Computed` and attaching `Signal.subtle.Watcher`.

## Documentation

- `README.md` Packages table and Quick-start snippets reorganized into a consistent tier order:
  1. Vanilla / `@wc-bindable/core`
  2. Major frameworks by share: React → Vue.js → Angular → Svelte
  3. Other frameworks alphabetically: Alpine.js → Lit → Marko → Mithril.js → Preact → Qwik → Riot.js → SolidJS → Stencil → VanJS
  4. Non-framework reactivity libs alphabetically: MobX → RxJS → TC39 Signals
  5. `@wc-bindable/remote`
- `examples/index.html` rows reordered to match the same tier order.
- Framework display names normalized to their official forms: `Vue` → `Vue.js`, `Mithril` → `Mithril.js`, `Solid` → `SolidJS`.
- Quick-start snippets added for the 7 packages that previously had only a Packages-table entry: Marko, Mithril.js, Riot.js, VanJS, TC39 Signals, MobX, RxJS.

## Tooling

- `CLAUDE.md` notes that `npm install` now requires `--legacy-peer-deps`. `@qwik.dev/core@2.0.0-beta.35` declares a peer of `vitest@">=2 <4"` but the workspace runs `vitest@^4`. The conflict is benign for the test suite, but plain `npm install` ERESOLVE-fails without the flag.

## Compatibility

- Existing v0.5.0 adapters (`@wc-bindable/core`, `react`, `vue`, `svelte`, `angular`, `solid`, `preact`, `alpine`, `remote`) are unchanged at the API level. No code changes required for v0.5.0 → v0.6.x migration.
- All packages stay on the lockstep version line.

## Packages

| Package | Version |
|---------|---------|
| `@wc-bindable/core` | 0.6.0 |
| `@wc-bindable/react` | 0.6.0 |
| `@wc-bindable/vue` | 0.6.0 |
| `@wc-bindable/angular` | 0.6.0 |
| `@wc-bindable/svelte` | 0.6.0 |
| `@wc-bindable/alpine` | 0.6.0 |
| `@wc-bindable/lit` | 0.6.0 (new) |
| `@wc-bindable/marko` | 0.6.0 (new) |
| `@wc-bindable/mithril` | 0.6.0 (new) |
| `@wc-bindable/preact` | 0.6.0 |
| `@wc-bindable/qwik` | 0.6.0 (new) |
| `@wc-bindable/riot` | 0.6.0 (new) |
| `@wc-bindable/solid` | 0.6.0 |
| `@wc-bindable/stencil` | 0.6.0 (new) |
| `@wc-bindable/vanjs` | 0.6.0 (new) |
| `@wc-bindable/mobx` | 0.6.0 (new) |
| `@wc-bindable/rxjs` | 0.6.0 (new) |
| `@wc-bindable/signals` | 0.6.0 (new) |
| `@wc-bindable/remote` | 0.6.0 |

---

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
