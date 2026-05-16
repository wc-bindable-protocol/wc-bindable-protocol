# wc-bindable-protocol

A minimal, framework-agnostic protocol that enables any `EventTarget`-based object — including Web Components, headless cores running in Node / Deno / Workers, and remote proxies — to declare its reactive outputs (and optionally its input properties and commands) so that any reactivity system can bind to them without framework-specific coupling.

The **core protocol has no runtime dependencies** — just `static` class fields and `CustomEvent`. Framework adapters depend only on their target framework (`@wc-bindable/react` on React, etc.); they do not pull in other frameworks.

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

// 2. Consumer side — call bind() and react.
import { bind } from "@wc-bindable/core";

const el = document.querySelector("my-input");
const unbind = bind(el, (name, value) => {
  console.log(`${name} =`, value); // fires for the initial value and every change
});
// later: unbind();
```

That's it. The framework adapters below (`@wc-bindable/react`, `@wc-bindable/vue`, ...) are 30–60 LOC wrappers that pipe the same `(name, value)` callbacks into their framework's reactivity primitive — they add no new protocol concepts.

## Why?

- **Write once, use everywhere** — A Web Component that implements this protocol works with React, Vue, Svelte, Angular, Solid, and any future framework without modification.
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

When the adapter binds to an element, it reads the current value of each declared property (using `name in target` so an explicitly-`undefined` value is still delivered) and then listens for subsequent change events. `bind()` returns an unbind function that removes every listener it registered; adapters re-expose this so consumers can tear down cleanly. For DOM elements that have not yet been connected when `bind()` is called, pass `{ syncOn: "connect" }` to defer the initial read until `connectedCallback` has run. Framework adapters that bind from a mounted-element lifecycle hook (React `useEffect`, Vue `onMounted`, Angular `AfterViewInit`, etc.) use the default `syncOn: "call"` because the host already guarantees the element is attached; imperative binders that hand you an `el` you append later (VanJS, MobX, RxJS, Signals) default to `syncOn: "connect"`. See [SPEC-extensions.md § Extension 3](SPEC-extensions.md) for the full guidance.

## Security model

wc-bindable assumes the target you bind to is **trusted code you intentionally loaded**. A custom-element `getter` is an arbitrary function executed in the consumer's JavaScript context on every event — do not bind to components whose `getter` implementations you did not vet.

**Treat a `static wcBindable` declaration like executable component code, not like inert metadata.** Because the `getter` field is a function, a wc-bindable declaration is fundamentally different from a JSON or schema artifact — loading a component from an untrusted source loads a function-valued field that will run with consumer-context privileges on every dispatched event. Threat models that allow "just serialized metadata" but disallow "third-party code" need to treat declarations as the latter.

For remote targets (`@wc-bindable/remote`), the proxy layer is a **protocol layer, not a security boundary**: authentication, authorization, rate limiting, and per-message payload validation are the responsibility of the layer that owns the transport. Do not expose a Core directly to an untrusted peer without those guardrails. `getter` functions are NEVER transported as code — they run on the trusted side and only extracted values cross the wire.

See [SPEC.md § Trust Boundaries](SPEC.md#trust-boundaries) and [packages/remote/README.md § Security model](packages/remote/README.md#security-model--trust-boundary) for the full contract.

## Non-goals

This protocol intentionally does **not** cover:

- **Automatic two-way synchronization** — The protocol can describe both outputs (`properties`) and inputs (`inputs`, `commands`), but it does not implement automatic synchronization between component and framework state. Setting input properties and invoking commands are always explicit actions by the consumer.
- **Form integration** — Integration with form libraries or `FormData` is outside the scope.
- **SSR / hydration** — The protocol operates at the DOM level and does not address server-side rendering or hydration strategies.
- **Validation or schema enforcement** — Property values are passed as-is. Type checking or validation is the consumer's responsibility.

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

### Vue.js

```vue
<script setup lang="ts">
import { useWcBindable } from "@wc-bindable/vue";
const { ref: inputRef, values } = useWcBindable<HTMLElement, { value: string }>({ value: "" });
</script>

<template>
  <my-input ref="inputRef" />
  <p>{{ values.value }}</p>
</template>
```

### Angular

```typescript
@Component({
  imports: [WcBindableDirective],
  template: `<my-input wcBindable (wcBindableChange)="onUpdate($event)" />`,
})
export class AppComponent {
  onUpdate(e: { name: string; value: unknown }) { /* ... */ }
}
```

### Svelte

```svelte
<script>
import { wcBindable } from "@wc-bindable/svelte";
let value = $state("");
</script>

<my-input use:wcBindable={{ onUpdate: (name, v) => { if (name === "value") value = v; } }} />
```

### Alpine.js

```html
<script type="module">
  import Alpine from "alpinejs";
  import wcBindable from "@wc-bindable/alpine";

  Alpine.plugin(wcBindable);
  Alpine.start();
</script>

<div x-data="{ value: '' }">
  <my-input x-wc-bindable></my-input>
  <p x-text="value"></p>
</div>
```

### Lit

```ts
import { LitElement, html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { WcBindableController } from "@wc-bindable/lit";

class App extends LitElement {
  private inputRef = createRef<HTMLElement>();
  private input = new WcBindableController<{ value: string }>(
    this, () => this.inputRef.value, { value: "" });

  render() {
    return html`<my-input ${ref(this.inputRef)}></my-input>
                <p>${this.input.values.value}</p>`;
  }
}
```

### Marko

```marko
import { wcBindable } from "@wc-bindable/marko";

<let/state = { value: "" } />
<my-input/inputEl />
<lifecycle
  onMount() { this.unbind = wcBindable(inputEl, (n, v) => state = { ...state, [n]: v }); }
  onDestroy() { this.unbind?.(); }
/>
<output>${state.value}</output>
```

### Mithril.js

```ts
import m from "mithril";
import { createWcBindable } from "@wc-bindable/mithril";

const Form = () => {
  const binder = createWcBindable<{ value: string }>({ value: "" });
  return {
    view: () => m("div", [
      m("my-input", { oncreate: binder.oncreate, onremove: binder.onremove }),
      m("p", `value: ${binder.values.value}`),
    ]),
  };
};
```

### Preact

```tsx
import { useWcBindable } from "@wc-bindable/preact";

function App() {
  const [ref, values] = useWcBindable<HTMLElement, { value: string }>({ value: "" });
  return <my-input ref={ref} />;
}
```

### Qwik

```tsx
import { component$ } from "@builder.io/qwik";
import { useWcBindable } from "@wc-bindable/qwik";

export const App = component$(() => {
  const { ref, values } = useWcBindable<HTMLElement, { value: string }>({ value: "" });
  return (
    <>
      <my-input ref={ref}></my-input>
      <p>{values.value}</p>
    </>
  );
});
```

### Riot.js

```html
<my-form>
  <my-input></my-input>
  <p>value: { binder.values.value }</p>

  <script>
    import { createWcBindable } from "@wc-bindable/riot";
    export default {
      onBeforeMount() {
        this.binder = createWcBindable({ value: "" }, { update: () => this.update() });
      },
      onMounted() { this.binder.bind(this.$("my-input")); },
    };
  </script>
</my-form>
```

### SolidJS

```tsx
import { createWcBindable } from "@wc-bindable/solid";

function App() {
  const [values, directive] = createWcBindable();
  return <my-input ref={directive} />;
}
```

### Stencil

```tsx
import { Component, h } from "@stencil/core";
import { WcBindableController } from "@wc-bindable/stencil";

@Component({ tag: "my-app" })
export class MyApp {
  private inputRef?: HTMLElement;
  private input = new WcBindableController<{ value: string }>(
    this, () => this.inputRef, { value: "" });

  connectedCallback() { this.input.connect(); }
  disconnectedCallback() { this.input.disconnect(); }
  componentDidRender() { this.input.update(); }

  render() {
    return (
      <div>
        <my-input ref={(el) => (this.inputRef = el)}></my-input>
        <p>{this.input.values.value}</p>
      </div>
    );
  }
}
```

### VanJS

```ts
import van from "vanjs-core";
import { createWcBindable } from "@wc-bindable/vanjs";

const binder = createWcBindable<{ count: number }>({ count: 0 });
const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected

van.add(document.body, el, van.tags.p(() => `count: ${binder.states.count.val}`));
```

### MobX

```ts
import { autorun } from "mobx";
import { createWcBindable } from "@wc-bindable/mobx";

const binder = createWcBindable<{ count: number }>({ count: 0 });
const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected
document.body.appendChild(el);

autorun(() => console.log(`count: ${binder.state.count}`));
```

### RxJS

```ts
import { createWcBindable } from "@wc-bindable/rxjs";

const binder = createWcBindable<{ count: number }>({ count: 0 });
const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected
document.body.appendChild(el);

binder.subjects.count.subscribe((count) => console.log(`count: ${count}`));
```

### TC39 Signals

```ts
import { Signal } from "signal-polyfill";
import { createWcBindable } from "@wc-bindable/signals";

const binder = createWcBindable<{ count: number }>({ count: 0 });
const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected
document.body.appendChild(el);

const view = new Signal.Computed(() => `count: ${binder.signals.count.get()}`);
// observe `view` via Signal.subtle.Watcher to drive rendering
```

### Remote (extracting Core to a server)

The `@wc-bindable/remote` package splits the wc-bindable Core/Shell boundary across a network. The server runs the real Core; the client gets a proxy `EventTarget` that works transparently with `bind()` and framework adapters.

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

proxy.set("url", "/api/users");
const result = await proxy.invoke("fetch");
// Caveat: `set` is fire-and-forget (at-most-once). The WebSocket
// transport preserves message *order*, so on a healthy connection
// `fetch` always observes `url = "/api/users"`. But order != delivery —
// during a transient outage the `set` can be silently dropped while the
// later `invoke` still lands, causing `fetch` to run against a stale
// `url` with no error. When `fetch` actually depends on `url` having
// been applied, use the acknowledged path:
//
//   await proxy.setWithAck("url", "/api/users");
//   const result = await proxy.invoke("fetch");
//
// Further nuance: `setWithAck` resolves once the JS-level assignment
// `core.url = "/api/users"` has run on the trusted side. It does NOT
// wait for any asynchronous side effects the setter may schedule
// (database write, network round-trip, validation pipeline, …). If the
// downstream command depends on that async work being complete, model
// the work as its own command and `await invoke(...)` it — `set` /
// `setWithAck` only guarantee the synchronous slice. See
// SPEC-extensions.md § Call-order preservation, § Transport lifecycle
// vocabulary, and the `setWithAck` row of the Methods table for the
// exact contracts.
```

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

### Headless Web Components

The `<my-fetch>` example demonstrates using Web Components as **invisible service layers** — not UI widgets. The component handles HTTP requests internally and exposes `value`, `loading`, `error`, and `status` via the protocol. Framework code contains zero async logic:

```tsx
// React — no fetch(), no async/await, no loading state management
const [ref, values] = useWcBindable<MyFetchElement, MyFetchValues>();
// values.loading, values.value, values.error — all reactive
```

## Development

```bash
npm install
npm test
```

## Specification

See [SPEC.md](SPEC.md) for the full protocol specification.

## License

MIT
