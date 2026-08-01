# @wc-bindable/signals

TC39 [Signals proposal](https://github.com/tc39/proposal-signals) adapter for the
**wc-bindable** protocol, built on [`signal-polyfill`](https://www.npmjs.com/package/signal-polyfill).

Bridges the protocol's `bind()` into `Signal.State`, so each declared property
of a Web Component is exposed as a reactive signal you can read from any
`Signal.Computed` or `Signal.subtle.Watcher` — including frameworks and
libraries that already consume the polyfill.

> The Signals proposal is at Stage 1. The polyfill API and this adapter will
> likely change as the proposal advances.

## Install

```bash
npm install @wc-bindable/signals signal-polyfill
```

## API

### `wcBindable(el, onUpdate, options?): unbind`

Low-level helper. Call it with the DOM node and a callback that receives every
property update. The adapter does no reactivity wiring — you decide what to do
with each update (typically writing to a `Signal.State` you control).

| Parameter | Type | Description |
|---|---|---|
| `el` | `Element` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called once per declared property on initial sync, and again on every change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

### `createWcBindable<V>(initialValues?, options?): WcBindableBinder<V>`

Stateful helper. Pre-creates one `Signal.State` per key in `initialValues` and
keeps each signal's value in sync with the component's matching declared
property.

Returns `{ signals, bind, unbind }`. Call `bind(el)` to attach to the
element (safe to call before or after it is connected to the DOM — the
initial-value read is deferred via `syncOn: "connect"`); call `unbind()`
when you're tearing the view down. Read the current value with
`signals.<name>.get()`; observe changes by wrapping that read in a
`Signal.Computed` and attaching a `Signal.subtle.Watcher`.

```ts
import { Signal } from "signal-polyfill";
import { createWcBindable } from "@wc-bindable/signals";

const binder = createWcBindable<{ value: string; checked: boolean }>({
  value: "",
  checked: false,
});

const el = document.querySelector("my-input")!;
binder.bind(el);

const derived = new Signal.Computed(
  () => `value=${binder.signals.value.get()} checked=${binder.signals.checked.get()}`,
);

const watcher = new Signal.subtle.Watcher(() => {
  queueMicrotask(() => {
    for (const s of watcher.getPending()) s.get();
    console.log(derived.get());
    watcher.watch();
  });
});

watcher.watch(derived);
derived.get(); // prime
```

Properties emitted by the component that are not in `initialValues` are
created lazily on first event, accessible via `binder.signals[name]`.

## Usage

```ts
import { Signal } from "signal-polyfill";
import { createWcBindable } from "@wc-bindable/signals";
import "./my-counter.js";

const binder = createWcBindable<{ count: number }>({ count: 0 });

const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected
document.body.appendChild(el);

const out = document.createElement("p");
document.body.appendChild(out);

const view = new Signal.Computed(() => `count: ${binder.signals.count.get()}`);

const watcher = new Signal.subtle.Watcher(() => {
  queueMicrotask(() => {
    for (const s of watcher.getPending()) s.get();
    out.textContent = view.get();
    watcher.watch();
  });
});

watcher.watch(view);
out.textContent = view.get(); // initial render
```

### Low-level usage

When you want to manage your own `Signal.State` objects (e.g. to merge multiple
bindable elements into one piece of state), use the low-level helper:

```ts
import { Signal } from "signal-polyfill";
import { wcBindable } from "@wc-bindable/signals";

const value = new Signal.State("");

const el = document.createElement("my-input");
document.body.appendChild(el);
const unbind = wcBindable(el, (name, v) => {
  if (name === "value") value.set(v as string);
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
