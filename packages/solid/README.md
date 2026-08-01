# @wc-bindable/solid

Solid adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/solid solid-js
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

### `createWcBindable(initialValues?, options?)`

**Returns:** `[values, directive]`

| Return | Type | Description |
|---|---|---|
| `values` | `Accessor<Record<string, unknown>>` | Signal with the latest property values |
| `directive` | `(el: HTMLElement) => void` | Pass to `ref` to bind the element |

### `wcBindable(el, accessor, options?)`

Solid directive for use with `use:wcBindable`.

| Parameter | Type | Description |
|---|---|---|
| `el` | `HTMLElement` | The target element (provided by Solid) |
| `accessor` | `Accessor<(name, value) => void>` | Callback invoked on property changes |

## Late-defined elements

`bind()` is called with `syncOn: "define"` by default, so an element whose custom element
definition arrives *after* this adapter runs — import-map autoloading, a CDN
`<script type="module">`, a code-split route — still binds once the definition lands. Nothing
has to re-run, and no re-render is needed.

Before this default, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the adapter returned early, and because the element keeps its identity across upgrade
nothing ever noticed. Opt back into that behavior with `syncOn: "call"`.

```ts
wcBindable(el, () => onUpdate, { syncOn: "call" });
const [values, directive] = createWcBindable({ value: "" }, { syncOn: "call" });
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
