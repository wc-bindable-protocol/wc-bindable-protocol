# wc-bindable-protocol

A minimal, framework-agnostic protocol that enables any Web Component to declare its reactive properties so that any reactivity system can bind to them without framework-specific coupling.

No dependencies. Just `static` class fields and `CustomEvent`.

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

## Packages

| Package | Description |
|---|---|
| [@wc-bindable/core](packages/core/) | Protocol type definitions, `bind()` utility, and `isWcBindable()` type guard |
| [@wc-bindable/react](packages/react/) | React hook — `useWcBindable()` |
| [@wc-bindable/vue](packages/vue/) | Vue composable — `useWcBindable()` |
| [@wc-bindable/svelte](packages/svelte/) | Svelte action — `use:wcBindable` |
| [@wc-bindable/angular](packages/angular/) | Angular directive — `wcBindable` |
| [@wc-bindable/solid](packages/solid/) | Solid primitive — `useWcBindable()` |

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
import { useWcBindable } from "@wc-bindable/solid";

function App() {
  let el!: HTMLElement;
  const values = useWcBindable(el, { value: "" });
  return <my-input ref={el} />;
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
