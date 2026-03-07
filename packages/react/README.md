# @wc-bindable/react

React adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/react @wc-bindable/core
```

## Usage

```tsx
import { useWcBindable } from "@wc-bindable/react";

function App() {
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

### `useWcBindable<T>(initialValues?)`

| Parameter | Type | Description |
|---|---|---|
| `T` | generic | The element type (e.g. `HTMLElement`) |
| `initialValues` | `Record<string, unknown>` | Optional initial values for bindable properties |

**Returns:** `[ref, values]`

| Return | Type | Description |
|---|---|---|
| `ref` | `RefObject<T>` | Attach this to the target element |
| `values` | `Record<string, unknown>` | Reactive object containing the latest property values |

- Automatically calls `bind()` on mount and cleans up on unmount.
- If the element does not implement `wc-bindable`, the hook is a no-op.

## License

MIT
