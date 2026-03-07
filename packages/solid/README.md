# @wc-bindable/solid

Solid adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/solid @wc-bindable/core
```

## Usage

```tsx
import { useWcBindable } from "@wc-bindable/solid";

function App() {
  let inputEl!: HTMLElement;
  const values = useWcBindable(inputEl, { value: "" });

  return (
    <>
      <my-input ref={inputEl} />
      <p>Current value: {values().value as string}</p>
    </>
  );
}
```

## API

### `useWcBindable(element, initialValues?)`

| Parameter | Type | Description |
|---|---|---|
| `element` | `HTMLElement` | The target element |
| `initialValues` | `Record<string, unknown>` | Optional initial values for bindable properties |

**Returns:** `Accessor<Record<string, unknown>>`

A signal accessor containing the latest property values.

- Binds immediately and cleans up via `onCleanup` when the reactive scope is disposed.
- If the element does not implement `wc-bindable`, the hook is a no-op.

## License

MIT
