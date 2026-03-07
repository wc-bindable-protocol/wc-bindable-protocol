# wc-bindable-protocol

A minimal, framework-agnostic protocol that enables any Web Component to declare its reactive properties so that any reactivity system can bind to them without framework-specific coupling.

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
  };
}
```

Any framework adapter can then automatically bind to those properties — no manual wiring needed.

When the adapter binds to an element, it reads the current value of each declared property for initial synchronization, then listens for subsequent change events. This means your framework state is populated immediately, even if the component was initialized before binding.

## Non-goals

This protocol intentionally does **not** cover:

- **Two-way binding** — The protocol is one-way (component to framework). Writing back to the component is left to the consumer via standard DOM property assignment.
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

## Development

```bash
npm install
npm test
```

## Specification

See [SPEC.md](SPEC.md) for the full protocol specification.

## License

MIT
