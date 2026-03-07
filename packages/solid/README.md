# @wc-bindable/solid

Solid adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/solid @wc-bindable/core
```

## Usage

### `createWcBindable` — signal + directive (recommended)

```tsx
import { createWcBindable } from "@wc-bindable/solid";

function App() {
  const [values, directive] = createWcBindable();

  return (
    <>
      <my-input ref={directive} />
      <p>Current value: {values().value as string}</p>
    </>
  );
}
```

### `use:wcBindable` — directive with callback

```tsx
import { wcBindable } from "@wc-bindable/solid";

function App() {
  const [value, setValue] = createSignal("");

  return (
    <my-input use:wcBindable={(name, v) => {
      if (name === "value") setValue(v as string);
    }} />
  );
}
```

## API

### `createWcBindable()`

**Returns:** `[values, directive]`

| Return | Type | Description |
|---|---|---|
| `values` | `Accessor<Record<string, unknown>>` | Signal with the latest property values |
| `directive` | `(el: HTMLElement) => void` | Pass to `ref` to bind the element |

### `wcBindable(el, accessor)`

Solid directive for use with `use:wcBindable`.

| Parameter | Type | Description |
|---|---|---|
| `el` | `HTMLElement` | The target element (provided by Solid) |
| `accessor` | `Accessor<(name, value) => void>` | Callback invoked on property changes |

## License

MIT
