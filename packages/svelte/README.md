# @wc-bindable/svelte

Svelte adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/svelte svelte
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
- If the element does not implement `wc-bindable` — and is not a custom element still waiting for its definition — the action is a no-op. See [Late-defined elements](#late-defined-elements).

## Late-defined elements

`bind()` is called with `syncOn: "define"` by default, so an element whose custom element
definition arrives *after* this adapter runs — import-map autoloading, a CDN
`<script type="module">`, a code-split route — still binds once the definition lands. Nothing
has to re-run, and no re-render is needed.

Before this default, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the adapter returned early, and because the element keeps its identity across upgrade
nothing ever noticed. Opt back into that behavior with `syncOn: "call"`.

```svelte
<my-input use:wcBindable={{ onUpdate, syncOn: "call" }} />
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
