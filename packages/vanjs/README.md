# @wc-bindable/vanjs

VanJS adapter for the **wc-bindable** protocol.

Bridges the protocol's `bind()` into VanJS's `van.state()` primitive, so each
declared property of a Web Component is exposed as a reactive state you can
read inside any VanJS template — including a derived expression like
`() => states.value.val`.

## Install

```bash
npm install @wc-bindable/vanjs vanjs-core
```

## API

### `wcBindable(el, onUpdate): unbind`

Low-level helper. Call it with the DOM node and a callback that receives every
property update. The adapter does no reactivity wiring — you decide what to do
with each update (typically writing to a `van.state` you control).

| Parameter | Type | Description |
|---|---|---|
| `el` | `Element` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called once per declared property on initial sync, and again on every change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

### `createWcBindable<V>(initialValues?): WcBindableBinder<V>`

Stateful helper. Pre-creates one `van.state` per key in `initialValues` and
keeps each state's `.val` in sync with the component's matching declared
property.

Returns `{ states, bind, unbind }`. Call `bind(el)` to attach to the element
(safe to call before or after it is connected to the DOM — the initial-value
read is deferred via `syncOn: "connect"`); call `unbind()` when you're
tearing the view down. Inside a VanJS template, read `states.<name>.val`
from a function expression to get reactive updates.

```ts
const binder = createWcBindable<{ value: string; checked: boolean }>({
  value: "",
  checked: false,
});

const el = document.querySelector("my-input")!;
binder.bind(el);

// In a template:
van.tags.p(() => binder.states.value.val);
```

Properties emitted by the component that are not in `initialValues` are
created lazily on first event, accessible via `binder.states[name]`.

## Usage

VanJS has no "after mount" lifecycle hook — you compose DOM nodes directly,
and `van.add()` connects them synchronously. `binder.bind()` is safe to call
either before or after the element is connected: it forwards
`{ syncOn: "connect" }` to the underlying `bind()`, so the initial-value
read is automatically deferred until the element is attached to the
document.

```ts
import van from "vanjs-core";
import { createWcBindable } from "@wc-bindable/vanjs";
import "./my-counter.js";

const { div, p, pre } = van.tags;

function App() {
  const binder = createWcBindable<{ count: number }>({ count: 0 });

  const myCounter = document.createElement("my-counter");
  binder.bind(myCounter); // initial-sync waits until van.add() connects it

  return div(
    myCounter,
    p(() => `count: ${binder.states.count.val}`),
    pre(() => JSON.stringify({ count: binder.states.count.val }, null, 2)),
  );
}

van.add(document.body, App());
```

> The deferred initial sync covers the case where a component only populates
> its bindable values inside `connectedCallback()` without dispatching an
> event for that initial assignment. For components that initialize in the
> constructor and dispatch on every later mutation, immediate or deferred
> binding produces the same result.

### Low-level usage

When you want to manage your own `van.state` objects (e.g. to merge multiple
bindable elements into one piece of state), use the low-level helper:

```ts
import van from "vanjs-core";
import { wcBindable } from "@wc-bindable/vanjs";

const value = van.state("");

const el = document.createElement("my-input");
const unbind = wcBindable(el, (name, v) => {
  if (name === "value") value.val = v as string;
});

// later
unbind();
```

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
