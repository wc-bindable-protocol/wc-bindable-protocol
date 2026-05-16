# wc-bindable-protocol

**wc-bindable lets a component publish "these properties can be observed, and these events mean they changed" in one standard place** — and any reactivity system reads that same place to wire up bindings without per-component glue.

The minimal, framework-agnostic protocol works for any **EventTarget-compatible bind target** — Web Components, headless `EventTarget` cores running in Node / Deno / Workers, and relay / remote proxies that expose `addEventListener` / `removeEventListener` (without necessarily extending `EventTarget` themselves) — so the same **declared interface** can be adapted to React, Vue, Svelte, Lit, plain `bind()` calls, and across-the-wire proxying. (Remote proxies expose an *observation-equivalent* declaration — same property / input / command names, synthetic per-property event names internally — rather than the byte-equal original.)

The **core protocol has zero `npm` runtime dependencies** — it runs on the platform's standard event-handling primitives (`addEventListener` / `removeEventListener` on the consumer side, `dispatchEvent` + `CustomEvent` on the producer side, plus `static` class fields for the declaration). Framework adapters depend only on their target framework (`@wc-bindable/react` on React, etc.); they do not pull in other frameworks.

## The whole protocol in one snippet

The simplest possible end-to-end use, with no framework adapter at all:

```javascript
// 1. Component side — declare what's bindable and dispatch on change.
class MyInput extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "value", event: "my-input:value-changed" }],
  };
  set value(v) {
    this._value = v;
    this.dispatchEvent(new CustomEvent("my-input:value-changed", { detail: v }));
  }
  get value() { return this._value; }
}
customElements.define("my-input", MyInput);

// 2. Consumer side — instantiate, attach, bind.
import { bind } from "@wc-bindable/core";

const el = new MyInput();
el.value = "hello";              // optional initial state
document.body.appendChild(el);   // attach so the consumer can find it

const unbind = bind(el, (name, value) => {
  console.log(`${name} =`, value); // fires for the initial value and every change
});

el.value = "world"; // triggers a second log line: `value = world`
// later: unbind();
```

The console output is two lines: `value = hello` (the initial-sync read) followed by `value = world` (the change event). If you remove the `el.value = "hello"` line you will see `value = undefined` first — `"value" in el` is `true` because the getter is on the prototype, and the protocol delivers "the current value, even if it is `undefined`". This is by design; see [SPEC.md § Initial Value Synchronization](SPEC.md#initial-value-synchronization).

That's it. The framework adapters below (`@wc-bindable/react`, `@wc-bindable/vue`, ...) are typically small wrappers that pipe the same `(name, value)` callbacks into their framework's reactivity primitive — they add no new protocol concepts.

## The protocol in three layers

If the snippet above feels small and the remote / wire-format material later feels large, that is because they live at different layers. Most consumers only ever need Layer 1.

| Layer | What it adds | When you use it | Where it lives |
|---|---|---|---|
| **1. Local observation** | `static wcBindable` declaration + `bind()` callback. Discovers reactive outputs and delivers their values. Zero runtime dependencies. | Always — this is what every framework adapter wraps. | [`@wc-bindable/core`](packages/core/), [SPEC.md](SPEC.md) |
| **2. Interface declaration** | Optional `inputs` and `commands` arrays on the same declaration. Pure metadata — no behavior at this layer, just type / doc / tooling surface. | When a tool (devtools, codegen, remote proxy, docs generator) wants to know "what can I write to / call on this component". | [SPEC.md § Schema](SPEC.md#schema) |
| **3. Remote transport profile** | `set` / `setWithAck` / `invoke` call semantics, JSON-shape wire format, declaration fingerprint, transport adapter contract. Builds on Layers 1 + 2; turns the same declaration into a network protocol. | When the Core needs to run on a different process / runtime / machine than the consumer. | [`@wc-bindable/remote`](packages/remote/), [SPEC-extensions.md](SPEC-extensions.md) |

The "no runtime dependencies" claim refers to Layer 1, which is what `@wc-bindable/core` ships. Layers 2 and 3 are opt-in; loading them does not retroactively complicate a Layer-1-only consumer.

**You do not need `@wc-bindable/remote` to use wc-bindable with a framework.** Layer 3 is for the specific case of running the Core in a different process / runtime / machine than the consumer. The framework adapters in the [Packages](#packages) table below all operate at Layer 1 and require nothing from Layer 3.

## Why?

- **Write once, use everywhere** — A Web Component that implements this protocol can be adapted to React, Vue, Svelte, Angular, Solid, and future frameworks without per-component glue. The component itself never changes; only a thin per-framework adapter ports the protocol callback into that framework's reactivity primitive.
- **No more manual wrappers** — Framework adapters automatically discover bindable properties and wire up event listeners. No per-component glue code needed.
- **Clear separation of concerns** — Component authors declare *what* is bindable; framework consumers decide *how* to bind. Neither side needs to know about the other.

## How it works

A Web Component declares bindable properties via `static wcBindable`:

```javascript
class MyInput extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "my-input:value-changed" },
    ],
    inputs: [
      { name: "value", attribute: "value" },
    ],
    commands: [
      { name: "focus" },
    ],
  };
}
```

Any framework adapter can then automatically bind to those properties — no manual wiring needed. The optional `inputs` and `commands` fields declare the component's input interface for tooling, documentation, and remote proxying — they do not create automatic two-way synchronization. The *behavioral* semantics of those fields (`set`, `invoke`, the `attribute` and `async` hints) are defined in [SPEC-extensions.md](SPEC-extensions.md) — the core protocol itself is read-only on `properties`.

> **Behavior vs. schema validation.** Core does not execute or interpret `inputs` / `commands` at all — only `properties` drive `bind()`. Discovery still validates the schema of `inputs` / `commands` when present, however, so a malformed `attribute` or `async` field invalidates the declaration as a whole and — assuming `onUpdate` itself is valid (a non-function `onUpdate` throws a `TypeError` synchronously before discovery, per [SPEC.md § onUpdate validity](SPEC.md#onupdate-validity)) — `bind()` returns its no-op cleanup. The split is intentional: core stays narrow on *runtime behavior*, but the discovery contract is *well-formedness* — which has to be complete for downstream tools (codegen, remote proxy, devtools) to trust what they see.

When the adapter binds to an element, it reads the current value of each declared property (using `name in target` so an explicitly-`undefined` value is still delivered) and then listens for subsequent change events. `bind()` returns an unbind function that removes every listener it registered; adapters re-expose this so consumers can tear down cleanly.

For DOM elements that have not yet been connected when `bind()` is called, pass `{ syncOn: "connect" }` to defer the initial read until `connectedCallback` has run. Framework adapters that bind from a mounted-element lifecycle hook (React `useEffect`, Vue `onMounted`, Angular `AfterViewInit`, etc.) use the default `syncOn: "call"` because the host already guarantees the element is attached. The imperative binders this repository ships for VanJS / MobX / RxJS / Signals pass `syncOn: "connect"` internally so callers do not have to sequence `appendChild()` and `binder.bind(el)` manually; this is a guideline rather than a spec MUST.

> **Prefer `syncOn: "call"` whenever the adapter can observe a mounted lifecycle.** `syncOn: "connect"` is a fallback for imperative light-DOM insertion only — it does NOT replace a proper lifecycle hook. The deferred path installs a document-wide `MutationObserver` which does NOT traverse shadow roots (so a target appended into a shadow tree never fires the deferred sync), and N simultaneous deferred binds installs N document observers. If your adapter owns the element lifecycle, bind from inside that hook with the default `syncOn: "call"` and skip the deferred path entirely. See [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection) for the full caveat list.

### Runtime note

`@wc-bindable/core` ships **zero `npm` runtime dependencies**. The default `bind(target, onUpdate)` path uses only `static` class fields and standard `addEventListener` / `removeEventListener` calls, so it works unchanged in browsers, Node, Deno, and Cloudflare Workers. The optional `{ syncOn: "connect" }` path additionally touches three DOM globals — `HTMLElement`, `document`, `MutationObserver` — through `typeof` guards; in non-browser runtimes where these are undefined, that path silently degrades to the synchronous `"call"` behavior. The package-manifest no-dependency posture is unaffected either way.

### Security at-a-glance

> **`getter` is executable JavaScript.** A `wcBindable` declaration's optional `getter` field is an arbitrary function that runs in the consumer's JS context on every dispatched event. Bind only to components you intentionally loaded and trust. Remote transports do NOT send `getter` over the wire — it runs on the trusted side and only the extracted value crosses the network. Full treatment in [§ Security model](#security-model) below.

## Non-goals

This protocol intentionally does **not** cover:

- **Automatic two-way synchronization** — The protocol can describe both outputs (`properties`) and inputs (`inputs`, `commands`), but it does not implement automatic synchronization between component and framework state. Setting input properties and invoking commands are always explicit actions by the consumer.
- **Form integration** — Integration with form libraries or `FormData` is outside the scope.
- **SSR / hydration** — The protocol operates at the DOM level and does not address server-side rendering or hydration strategies.
- **Application-level schema enforcement** — The core protocol passes property values to consumers as-is; it does not type-check or business-validate them. Type checking is the consumer's responsibility. (Transport-level extensions DO validate transport-shape: `@wc-bindable/remote` enforces JSON-serializability of every payload before it crosses the wire, see [SPEC-extensions.md § Extension 2](SPEC-extensions.md). That is wire-shape validation, not application validation — the value's *application* meaning still passes through unexamined.)

## Packages

| Package | Description |
|---|---|
| [@wc-bindable/core](packages/core/) | Protocol type definitions, `bind()` utility, `getWcBindableDeclaration()` and `isWcBindable()` discovery primitives |
| [@wc-bindable/react](packages/react/) | React hook — `useWcBindable()` |
| [@wc-bindable/vue](packages/vue/) | Vue.js composable — `useWcBindable()` |
| [@wc-bindable/angular](packages/angular/) | Angular directive — `wcBindable` |
| [@wc-bindable/svelte](packages/svelte/) | Svelte action — `use:wcBindable` |
| [@wc-bindable/alpine](packages/alpine/) | Alpine.js plugin — `x-wc-bindable` directive |
| [@wc-bindable/lit](packages/lit/) | Lit ReactiveController — `WcBindableController` |
| [@wc-bindable/marko](packages/marko/) | Marko helper — `wcBindable()` (Marko 5 + 6) |
| [@wc-bindable/mithril](packages/mithril/) | Mithril.js helper — `wcBindable()` / `createWcBindable()` |
| [@wc-bindable/preact](packages/preact/) | Preact hook — `useWcBindable()` |
| [@wc-bindable/qwik](packages/qwik/) | Qwik composable — `useWcBindable()` (Qwik 1.x; Qwik 2.x via `/v2`, experimental) |
| [@wc-bindable/riot](packages/riot/) | Riot.js helper — `wcBindable()` / `createWcBindable()` |
| [@wc-bindable/solid](packages/solid/) | SolidJS primitive — `createWcBindable()` / `use:wcBindable` |
| [@wc-bindable/stencil](packages/stencil/) | Stencil controller — `WcBindableController` |
| [@wc-bindable/vanjs](packages/vanjs/) | VanJS helper — `wcBindable()` / `createWcBindable()` |
| [@wc-bindable/mobx](packages/mobx/) | MobX helper — `wcBindable()` / `createWcBindable()` |
| [@wc-bindable/rxjs](packages/rxjs/) | RxJS helper — `wcBindable()` / `createWcBindable()` (one `BehaviorSubject` per property) |
| [@wc-bindable/signals](packages/signals/) | TC39 Signals (`signal-polyfill`) helper — `wcBindable()` / `createWcBindable()` |
| [@wc-bindable/remote](packages/remote/) | Remote proxy — connect Core and Shell over a network via WebSocket or custom transport |

## Quick start

```bash
# Install core + your framework adapter
npm install @wc-bindable/core @wc-bindable/react
```

### Vanilla (`@wc-bindable/core` alone)

For a target you already hold a reference to, call `bind()` directly — every adapter below is a thin wrapper around this same primitive:

```ts
import { bind } from "@wc-bindable/core";

const el = document.querySelector("my-input");
const unbind = bind(el, (name, value) => {
  // fires once for every declared property's initial value, then once per change event
  console.log(`${name} =`, value);
});

// later, when the view is torn down:
unbind();
```

### React

```tsx
import { useWcBindable } from "@wc-bindable/react";

function App() {
  const [ref, values] = useWcBindable<HTMLElement, { value: string }>({ value: "" });
  return (
    <>
      <my-input ref={ref} />
      <p>{values.value}</p>
    </>
  );
}
```

### Other framework adapters

Every other adapter follows the same pattern (`useWcBindable` / `createWcBindable` / `WcBindableController` / `use:wcBindable` — exact name varies). The detailed snippet for each lives in its own README; click through for the idiomatic call shape.

| Adapter | Quick reference |
|---|---|
| [@wc-bindable/vue](packages/vue/README.md) | `useWcBindable()` composable returning `{ ref, values }` |
| [@wc-bindable/angular](packages/angular/README.md) | `wcBindable` directive emitting `(wcBindableChange)` |
| [@wc-bindable/svelte](packages/svelte/README.md) | `use:wcBindable={{ onUpdate }}` action |
| [@wc-bindable/preact](packages/preact/README.md) | `useWcBindable()` hook (React-shaped) |
| [@wc-bindable/solid](packages/solid/README.md) | `createWcBindable()` returning `[values, directive]` |
| [@wc-bindable/lit](packages/lit/README.md) | `WcBindableController` (Lit ReactiveController) |
| [@wc-bindable/stencil](packages/stencil/README.md) | `WcBindableController` (Stencil controller) |
| [@wc-bindable/alpine](packages/alpine/README.md) | `x-wc-bindable` directive (Alpine plugin) |
| [@wc-bindable/marko](packages/marko/README.md) | `wcBindable()` helper (Marko 5 + 6) |
| [@wc-bindable/mithril](packages/mithril/README.md) | `createWcBindable()` with `oncreate` / `onremove` |
| [@wc-bindable/qwik](packages/qwik/README.md) | `useWcBindable()` (Qwik 1.x; Qwik 2.x via `/v2`, experimental) |
| [@wc-bindable/riot](packages/riot/README.md) | `createWcBindable()` with `{ update }` callback |
| [@wc-bindable/vanjs](packages/vanjs/README.md) | `createWcBindable()` exposing `binder.states.<name>` |
| [@wc-bindable/mobx](packages/mobx/README.md) | `createWcBindable()` exposing `binder.state.<name>` (one observable) |
| [@wc-bindable/rxjs](packages/rxjs/README.md) | `createWcBindable()` exposing `binder.subjects.<name>` (BehaviorSubject per property) |
| [@wc-bindable/signals](packages/signals/README.md) | `createWcBindable()` exposing `binder.signals.<name>` (TC39 Signals via `signal-polyfill`) |

## Examples

The `examples/` directory contains working demos that verify the protocol across environments:

| Example | Description |
|---|---|
| [Vanilla — Counter](examples/vanilla/counter/) | Basic counter using `bind()` directly |
| [Vanilla — Fetch](examples/vanilla/fetch/) | Headless `<my-fetch>` component with async state |
| [React — Counter](examples/react/counter/) | Counter bound via `useWcBindable` hook |
| [React — Fetch](examples/react/fetch/) | Fetch bound via `useWcBindable` hook |
| [Vue — Counter](examples/vue/counter/) | Counter bound via `useWcBindable` composable |
| [Vue — Fetch](examples/vue/fetch/) | Fetch bound via `useWcBindable` composable |

### Running the examples

```bash
npm run examples
```

Open `http://localhost:5173` to see the example index.

### Web Components as invisible service layers

> Terminology note: this section talks about DOM-mounted Web Components that have no visual surface (e.g. `<my-fetch>`). It is **not** the same as the "headless target" concept in SPEC.md, which refers to plain `EventTarget` subclasses that run with no DOM at all (Node / Deno / Workers). Both patterns benefit from the protocol; they differ in whether the target is in the document tree.

The `<my-fetch>` example demonstrates using Web Components as **invisible service layers** — not UI widgets. The component handles HTTP requests internally and exposes `value`, `loading`, `error`, and `status` via the protocol. Framework code contains zero async logic:

```tsx
// React — no fetch(), no async/await, no loading state management
import type { MyFetchValues } from "./my-fetch/types.js";
const [ref, values] = useWcBindable<HTMLElement, MyFetchValues>();
// values.loading, values.value, values.error — all reactive
```

## Security model

wc-bindable assumes the target you bind to is **trusted code you intentionally loaded**. A custom-element `getter` is an arbitrary function executed in the consumer's JavaScript context on every event — do not bind to components whose `getter` implementations you did not vet.

**Treat a `static wcBindable` declaration like executable component code, not like inert metadata.** Because the `getter` field is a function, a wc-bindable declaration is fundamentally different from a JSON or schema artifact — loading a component from an untrusted source loads a function-valued field that will run with consumer-context privileges on every dispatched event. Threat models that allow "just serialized metadata" but disallow "third-party code" need to treat declarations as the latter.

For remote targets (`@wc-bindable/remote`), the proxy layer is a **protocol layer, not a security boundary**: authentication, authorization, rate limiting, and per-message payload validation are the responsibility of the layer that owns the transport. Do not expose a Core directly to an untrusted peer without those guardrails. `getter` functions are NEVER transported as code — they run on the trusted side and only extracted values cross the wire.

See [SPEC.md § Trust Boundaries](SPEC.md#trust-boundaries) and [packages/remote/README.md § Security model](packages/remote/README.md#security-model--trust-boundary) for the full contract.

## Advanced: extracting Core to a server

For most use cases, ignore this section — the local-binding examples above are the protocol's main path. Read on only if you want to run the Core on a server and have the client interact with it through a network transport.

The `@wc-bindable/remote` package splits the wc-bindable Core/Shell boundary across a network. The server runs the real Core; the client gets a proxy `EventTarget` that works transparently with `bind()` and every framework adapter — the consumer-side code is identical to the local case.

```typescript
// Server
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
const core = new MyFetchCore();
const shell = new RemoteShellProxy(core, new WebSocketServerTransport(socket));
```

```typescript
// Client
import { createRemoteCoreProxy, WebSocketClientTransport } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";

const proxy = createRemoteCoreProxy(
  MyFetchCore.wcBindable,
  new WebSocketClientTransport(new WebSocket("ws://localhost:3000")),
);

bind(proxy, (name, value) => {
  console.log(name, value); // works exactly as if Core were local
});

// `setWithAck` is the safe default whenever a later `invoke` depends on
// a prior `set` — it waits for the assignment `core.url = "/api/users"`
// to actually execute on the trusted side before resolving.
await proxy.setWithAck("url", "/api/users");
const result = await proxy.invoke("fetch");
```

> **When to use the fire-and-forget `proxy.set()` instead.** `set` is a faster, non-acknowledged write — at-most-once delivery, no round-trip wait. The WebSocket transport preserves message *order*, so on a healthy connection `fetch` after `set` always observes the new value. But order ≠ delivery — during a transient outage the `set` can be silently dropped while the later `invoke` still lands, causing `fetch` to run against a stale `url` with no error returned. Reach for `set` only when the downstream call does NOT depend on this assignment having been applied (e.g. an update-only-side-effect input, or a write that is naturally re-driven by a later event). When in doubt, prefer `setWithAck`. (Canonical statement: [SPEC-extensions.md § Methods](SPEC-extensions.md#methods), the `set` row.)
>
> **Further nuance.** `setWithAck` resolves once the JS-level assignment has executed on the trusted side. It does **not** wait for any asynchronous side effects the setter may schedule (database write, network round-trip, validation pipeline, …). If the downstream command depends on that async work completing, model the work as its own command and `await invoke(...)` it.
>
> **Remote payloads are JSON-shape only.** Every value that crosses the wire — `set` / `setWithAck` arguments, `invoke` arguments, command return values, property update values — MUST be a `JsonValue`: plain objects, arrays, strings, finite numbers, booleans, `null`. Producers and consumers reject `Date`, `Map`, `Set`, `BigInt`, typed arrays, class instances (including custom `Error` subclasses), functions, symbols, cyclic references, non-finite numbers, sparse arrays, arrays with extra string keys, and objects with non-enumerable string keys. Encode them into plain JSON objects at the application boundary before returning them from a command or passing them as an argument (e.g. `date.toISOString()`, `[...map.entries()]`, `error.message` instead of the `Error` object itself). The full algorithm with worked examples is in [SPEC-extensions.md § Design invariants](SPEC-extensions.md#extension-2--wire-format-remote-proxying) invariant 3.

For the full wire format, error envelope, back-pressure controls, transport adapter contract, and security model, see [SPEC-extensions.md](SPEC-extensions.md) and [packages/remote/README.md](packages/remote/README.md).

## Development

```bash
npm install
npm test
```

## Specification

See [SPEC.md](SPEC.md) for the full protocol specification.

## License

MIT
