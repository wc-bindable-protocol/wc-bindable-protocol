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

### `useWcBindable<T, V>(initialValues?, options?)`

| Parameter | Type | Description |
|---|---|---|
| `T` | generic | The element type (e.g. `HTMLElement`) |
| `V` | generic | Optional shape of the bindable values object |
| `initialValues` | `Partial<V>` | Optional initial values for bindable properties |
| `options` | `{ syncOn? }` | Forwarded to `bind()`. Defaults to `syncOn: "define"` — see [Late-defined elements](#late-defined-elements) |

**Returns:** `[ref, values]`

| Return | Type | Description |
|---|---|---|
| `ref` | `(node: T \| null) => void` | Callback ref to attach to the target element |
| `values` | `V` | Reactive object containing the latest property values |

- Automatically calls `bind()` on mount and cleans up on unmount.
- If the element does not implement `wc-bindable` — and is not a custom element still waiting for its definition — the hook is a no-op. See [Late-defined elements](#late-defined-elements).

## Late-defined elements

`bind()` is called with `syncOn: "define"` by default, so an element whose custom element
definition arrives *after* this adapter runs — import-map autoloading, a CDN
`<script type="module">`, a code-split route — still binds once the definition lands. Nothing
has to re-run, and no re-render is needed.

Before this default, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the adapter returned early, and because the element keeps its identity across upgrade
nothing ever noticed. Opt back into that behavior with `syncOn: "call"`.

```ts
const [ref, values] = useWcBindable<HTMLElement>({ value: "" }, { syncOn: "call" });
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
