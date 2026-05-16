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

### `wcBindable(el, onUpdate): unbind`

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

## License

MIT
