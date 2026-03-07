# @wc-bindable/svelte

Svelte adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/svelte @wc-bindable/core
```

## Usage

```svelte
<script>
  import { wcBindable } from "@wc-bindable/svelte";

  let value = $state("");

  function onUpdate(name, newValue) {
    if (name === "value") value = newValue;
  }
</script>

<my-input use:wcBindable={{ onUpdate }} />
<p>Current value: {value}</p>
```

## API

### `wcBindable` (Svelte action)

Used via the `use:` directive.

| Parameter | Type | Description |
|---|---|---|
| `onUpdate` | `(name: string, value: unknown) => void` | Callback invoked when a bindable property changes |

- Automatically binds on mount and cleans up on destroy.
- Supports `update` — if params change, listeners are rebound.
- If the element does not implement `wc-bindable`, the action is a no-op.

## License

MIT
