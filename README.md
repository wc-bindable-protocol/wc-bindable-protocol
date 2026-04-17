# wc-bindable-protocol

A minimal, framework-agnostic protocol that enables any Web Component to declare its reactive properties — and optionally its input properties and commands — so that any reactivity system can bind to them without framework-specific coupling.

No dependencies. Just `static` class fields and `CustomEvent`.

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

Any framework adapter can then automatically bind to those properties — no manual wiring needed. The optional `inputs` and `commands` fields declare the component's input interface for tooling, documentation, and remote proxying — they do not create automatic two-way synchronization.

When the adapter binds to an element, it reads the current value of each declared property for initial synchronization, then listens for subsequent change events. This means your framework state is populated immediately, even if the component was initialized before binding.

## Non-goals

This protocol intentionally does **not** cover:

- **Automatic two-way synchronization** — The protocol can describe both outputs (`properties`) and inputs (`inputs`, `commands`), but it does not implement automatic synchronization between component and framework state. Setting input properties and invoking commands are always explicit actions by the consumer.
- **Form integration** — Integration with form libraries or `FormData` is outside the scope.
- **SSR / hydration** — The protocol operates at the DOM level and does not address server-side rendering or hydration strategies.
- **Validation or schema enforcement** — Property values are passed as-is. Type checking or validation is the consumer's responsibility.

## Packages

| Package | Description |
|---|---|
| [@wc-bindable/core](packages/core/) | Protocol type definitions, `bind()` utility, and `isWcBindable()` type guard |
| [@wc-bindable/react](packages/react/) | React hook — `useWcBindable()` |
| [@wc-bindable/vue](packages/vue/) | Vue composable — `useWcBindable()` |
| [@wc-bindable/svelte](packages/svelte/) | Svelte action — `use:wcBindable` |
| [@wc-bindable/angular](packages/angular/) | Angular directive — `wcBindable` |
| [@wc-bindable/solid](packages/solid/) | Solid primitive — `createWcBindable()` / `use:wcBindable` |
| [@wc-bindable/remote](packages/remote/) | Remote proxy — connect Core and Shell over a network via WebSocket or custom transport |
| [@wc-bindable/hawc-ai](packages/hawc-ai/) | Headless AI inference component — OpenAI, Anthropic, Azure OpenAI, and Google (Gemini) with SSE streaming, no provider SDK |
| [@wc-bindable/hawc-auth0](packages/hawc-auth0/) | Headless Auth0 authentication component — local (token in DOM for `fetch`) and remote (gatekeeper over authenticated WebSocket) modes |
| [@wc-bindable/hawc-s3](packages/hawc-s3/) | Headless S3 / S3-compatible blob store component — server-side signing + browser-direct upload, no AWS SDK |

## Quick start

```bash
# Install core + your framework adapter
npm install @wc-bindable/core @wc-bindable/react
```

### React

```tsx
import { useWcBindable } from "@wc-bindable/react";

function App() {
  const [ref, values] = useWcBindable<HTMLElement>({ value: "" });
  return <my-input ref={ref} />;
}
```

### Vue

```vue
<script setup>
import { useWcBindable } from "@wc-bindable/vue";
const { ref, values } = useWcBindable({ value: "" });
</script>

<template>
  <my-input :ref="ref" />
  <p>{{ values.value }}</p>
</template>
```

### Svelte

```svelte
<script>
import { wcBindable } from "@wc-bindable/svelte";
let value = $state("");
</script>

<my-input use:wcBindable={{ onUpdate: (name, v) => { if (name === "value") value = v; } }} />
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

### Solid

```tsx
import { createWcBindable } from "@wc-bindable/solid";

function App() {
  const [values, directive] = createWcBindable();
  return <my-input ref={directive} />;
}
```

### Remote (extracting Core to a server)

The `@wc-bindable/remote` package splits the HAWC Core/Shell boundary across a network. The server runs the real Core; the client gets a proxy `EventTarget` that works transparently with `bind()` and framework adapters.

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
```

## Examples

The `examples/` directory contains working demos that verify the protocol across environments:

| Example | Description |
|---|---|
| [Vanilla — Counter](examples/vanilla/counter/) | Basic counter using `bind()` directly |
| [Vanilla — Fetch](examples/vanilla/fetch/) | Headless `<my-fetch>` component with async state |
| [React — Counter](examples/react-counter/) | Counter bound via `useWcBindable` hook |
| [React — Fetch](examples/react-fetch/) | Fetch bound via `useWcBindable` hook |
| [Vue — Counter](examples/vue-counter/) | Counter bound via `useWcBindable` composable |
| [Vue — Fetch](examples/vue-fetch/) | Fetch bound via `useWcBindable` composable |

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
