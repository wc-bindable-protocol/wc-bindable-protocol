# @wc-bindable/marko

Marko adapter for the **wc-bindable** protocol.

The adapter is a single framework-agnostic helper that wires `bind()` from
`@wc-bindable/core` into Marko's own mount/destroy lifecycle. It is
version-agnostic — the same import works in **Marko 5** (class components) and
**Marko 6** (Tags API).

## Install

```bash
npm install @wc-bindable/marko marko
```

## API

### `wcBindable(el, onUpdate, options?): unbind`

| Parameter | Type | Description |
|---|---|---|
| `el` | `HTMLElement` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called for each declared property on the initial sync and on every subsequent change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

## Marko 6 (Tags API)

Capture the element with a tag variable, then call the helper from `<lifecycle>`:

```marko
import { wcBindable } from "@wc-bindable/marko";

<let/state = { value: "" } />
<my-input/inputEl />
<lifecycle
  onMount() { this.unbind = wcBindable(inputEl, (n, v) => state = { ...state, [n]: v }); }
  onDestroy() { this.unbind?.(); }
/>
<output>${state.value}</output>
```

## Marko 5 (class components)

Use a `key=` ref + `getEl()` from `onMount`, release in `onDestroy`:

```marko
import { wcBindable } from "@wc-bindable/marko";

class {
  onCreate() { this.state = { value: "" }; }
  onMount() {
    this.unbind = wcBindable(this.getEl("input"), (name, value) => {
      this.state[name] = value;
    });
  }
  onDestroy() { if (this.unbind) this.unbind(); }
}

<my-input key="input" />
<output>${state.value}</output>
```

If your Web Component's tag name contains a hyphen, Marko 5 may try to resolve
it as a custom Marko component. Use the dynamic-tag syntax to render it as a
plain HTML element:

```marko
$ const TAG = "my-input";
<${TAG} key="input"/>
```

## Late-defined elements

`bind()` is called with `syncOn: "define"` by default, so an element whose custom element
definition arrives *after* this adapter runs — import-map autoloading, a CDN
`<script type="module">`, a code-split route — still binds once the definition lands. Nothing
has to re-run, and no re-render is needed.

Before this default, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the adapter returned early, and because the element keeps its identity across upgrade
nothing ever noticed. Opt back into that behavior with `syncOn: "call"`.

```ts
wcBindable(el, onUpdate, { syncOn: "call" });
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
