# @wc-bindable/preact

Preact adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/preact preact
```

## Usage

```tsx
import { useWcBindable } from "@wc-bindable/preact";

export function App() {
  const [ref, values] = useWcBindable<HTMLElement>({ value: "" });

  return (
    <>
      <my-input ref={ref} />
      <p>Current value: {values.value as string}</p>
    </>
  );
}
```

## API

### `useWcBindable<T, V>(initialValues?)`

| Parameter | Type | Description |
|---|---|---|
| `T` | generic | The element type (e.g. `HTMLElement`) |
| `V` | generic | Optional shape of the bindable values object |
| `initialValues` | `Partial<V>` | Optional initial values for bindable properties |

**Returns:** `[ref, values]`

| Return | Type | Description |
|---|---|---|
| `ref` | `(node: T \| null) => void` | Callback ref to attach to the target element |
| `values` | `V` | Reactive object containing the latest property values |

- Automatically calls `bind()` on mount and cleans up on unmount.
- If the element does not implement `wc-bindable`, the hook is a no-op.

## License

MIT
