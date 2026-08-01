# @wc-bindable/mithril

Mithril.js adapter for the **wc-bindable** protocol.

Bridges the protocol's `bind()` into Mithril's `oncreate` / `onremove` lifecycle
and Mithril's `redraw()` cycle, so a Web Component's declared properties show up
as plain state you can read inside `view()`.

## Install

```bash
npm install @wc-bindable/mithril mithril
```

## API

### `wcBindable(el, onUpdate, options?): unbind`

Low-level helper. Call it from any lifecycle hook that gives you the DOM node;
the adapter does no redraw — you decide what to do with each update.

| Parameter | Type | Description |
|---|---|---|
| `el` | `HTMLElement` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called once per declared property on initial sync, and again on every change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

### `createWcBindable<V>(initialValues?, options?): WcBindableState<V>`

Stateful helper. Holds a values object, mutates it as events arrive, and calls
`m.redraw()` so your `view()` rerenders automatically.

Returns `{ values, oncreate, onremove }` — wire those directly into your
component.

| Option | Type | Default |
|---|---|---|
| `redraw` | `() => void` | `() => m.redraw()` — override to use `m.redraw.sync()` or batch redraws |

## Usage

`oncreate` and `onremove` must run on the bindable element itself — Mithril
hands the hook the vnode whose DOM node it is attached to, and the adapter only
binds if that node implements the protocol. So always attach the hooks to the
`<my-input>` vnode, not to a wrapping component or `<div>`:

```ts
import m from "mithril";
import { createWcBindable } from "@wc-bindable/mithril";

const Form = () => {
  const binder = createWcBindable<{ value: string; checked: boolean }>({
    value: "",
    checked: false,
  });

  return {
    view: () =>
      m("div", [
        m("my-input", {
          oncreate: binder.oncreate,
          onremove: binder.onremove,
        }),
        m("output", `value: ${binder.values.value}`),
        m("output", `checked: ${binder.values.checked}`),
      ]),
  };
};

m.mount(document.body, Form);
```

If your component's view root **is** the bindable element (no wrapper), you can
attach the hooks at the component level instead — `vnode.dom` will then be the
bindable element:

```ts
const Input = () => {
  const binder = createWcBindable<{ value: string }>({ value: "" });
  return {
    oncreate: binder.oncreate,
    onremove: binder.onremove,
    view: () => m("my-input"),
  };
};
```

### Low-level usage

```ts
import m from "mithril";
import { wcBindable } from "@wc-bindable/mithril";

const Form = () => {
  const state: Record<string, unknown> = { value: "" };
  let unbind: (() => void) | null = null;

  return {
    view: () =>
      m("div", [
        m("my-input", {
          oncreate(vnode) {
            unbind = wcBindable(vnode.dom as HTMLElement, (name, value) => {
              state[name] = value;
              m.redraw();
            });
          },
          onremove() {
            unbind?.();
          },
        }),
        m("output", state.value as string),
      ]),
  };
};
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
createWcBindable({ value: "" }, { syncOn: "call" });
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
