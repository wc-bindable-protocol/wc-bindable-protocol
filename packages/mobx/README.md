# @wc-bindable/mobx

[MobX](https://mobx.js.org/) adapter for the **wc-bindable** protocol.

Bridges the protocol's `bind()` into a MobX observable object, so each declared
property of a Web Component is exposed as a reactive field you can read from
any `autorun`, `reaction`, `computed`, or `observer`-wrapped component.

## Install

```bash
npm install @wc-bindable/mobx mobx
```

## API

### `wcBindable(el, onUpdate, options?): unbind`

Low-level helper. Call it with the DOM node and a callback that receives every
property update. The adapter does no reactivity wiring — you decide what to do
with each update (typically writing into your own observable).

| Parameter | Type | Description |
|---|---|---|
| `el` | `Element` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called once per declared property on initial sync, and again on every change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

### `createWcBindable<V>(initialValues?, options?): WcBindableBinder<V>`

Stateful helper. Creates a single MobX observable object whose fields are kept
in sync with the component's declared properties.

Returns `{ state, bind, unbind }`. Call `bind(el)` to attach to the element
(safe to call before or after it is connected to the DOM — the initial-value
read is deferred via `syncOn: "connect"`); call `unbind()` when you're
tearing the view down. Read the current value with `state.<name>`;
reactions, autoruns, and computeds that touch those fields re-run
automatically when the component dispatches an update.

```ts
import { autorun } from "mobx";
import { createWcBindable } from "@wc-bindable/mobx";

const binder = createWcBindable<{ value: string; checked: boolean }>({
  value: "",
  checked: false,
});

const el = document.querySelector("my-input")!;
binder.bind(el);

autorun(() => {
  console.log(`value=${binder.state.value} checked=${binder.state.checked}`);
});
```

Properties emitted by the component that are not in `initialValues` are added
as observable fields lazily on first event (via MobX `set`), so reactions on
them fire correctly even though the key was unknown at binder creation time.

Writes are wrapped in `runInAction`, so a single bindable event produces a
single MobX transaction.

The state object is created with `{ deep: false }`, so MobX does **not**
deep-enhance assigned arrays or plain objects. This preserves the wc-bindable
contract that property values are passed as-is — `state.items === emittedArray`
holds — at the cost that mutating a nested array/object will not trigger
reactions on its own. Replace the whole value (the component already does this
when it dispatches a change event) and reactions fire normally.

## Usage

```ts
import { autorun } from "mobx";
import { createWcBindable } from "@wc-bindable/mobx";
import "./my-counter.js";

const binder = createWcBindable<{ count: number }>({ count: 0 });

const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected
document.body.appendChild(el);

const out = document.createElement("p");
document.body.appendChild(out);

autorun(() => {
  out.textContent = `count: ${binder.state.count}`;
});
```

### Low-level usage

When you want to manage your own observable (e.g. to merge multiple bindable
elements into one piece of state), use the low-level helper:

```ts
import { observable, runInAction } from "mobx";
import { wcBindable } from "@wc-bindable/mobx";

const store = observable({ value: "" });

const el = document.createElement("my-input");
document.body.appendChild(el);
const unbind = wcBindable(el, (name, v) => {
  if (name === "value") {
    runInAction(() => {
      store.value = v as string;
    });
  }
});

// later
unbind();
```

## Late-defined elements

This package binds with a deferral by default, so an element whose custom element definition
arrives *after* the binder runs — import-map autoloading, a CDN `<script type="module">`, a
code-split route — still binds once the definition lands.

| Entry point | Default `syncOn` | Why |
|---|---|---|
| `wcBindable(el, onUpdate)` | `"define"` | Wait for the definition, then register as usual |
| `createWcBindable().bind(el)` | `["define", "connect"]` | This binder is handed a **detached** element, so it also has to defer the initial-value read until the element is attached — the two deferrals compose |

Before these defaults, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the binder returned early, and because the element keeps its identity across upgrade
nothing ever noticed. `syncOn: "connect"` alone did not help — the discovery gate runs first.

Opt back into the historical behavior with `syncOn`:

```ts
wcBindable(el, onUpdate, { syncOn: "call" });
createWcBindable({ value: "" }, { syncOn: "connect" });
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition)
and [§ Composing `syncOn` modes](../../SPEC.md#composing-syncon-modes).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
