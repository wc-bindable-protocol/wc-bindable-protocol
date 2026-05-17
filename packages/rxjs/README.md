# @wc-bindable/rxjs

[RxJS](https://rxjs.dev/) adapter for the **wc-bindable** protocol.

Bridges the protocol's `bind()` into `BehaviorSubject`, so each declared
property of a Web Component is exposed as an observable you can `subscribe` to,
combine, transform, or feed into any RxJS pipeline.

## Install

```bash
npm install @wc-bindable/rxjs rxjs
```

## API

### `wcBindable(el, onUpdate): unbind`

Low-level helper. Call it with the DOM node and a callback that receives every
property update. The adapter does no reactivity wiring — you decide what to do
with each update (typically calling `.next()` on a `Subject` you control).

| Parameter | Type | Description |
|---|---|---|
| `el` | `Element` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called once per declared property on initial sync, and again on every change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

### `createWcBindable<V>(initialValues?): WcBindableBinder<V>`

Stateful helper. Pre-creates one `BehaviorSubject` per key in `initialValues`
and keeps each subject's value in sync with the component's matching declared
property.

Returns `{ subjects, bind, unbind }`. Call `bind(el)` to attach to the
element (safe to call before or after it is connected to the DOM — the
initial-value read is deferred via `syncOn: "connect"`); call `unbind()`
when you're tearing the view down. Subscribe to changes with
`subjects.<name>.subscribe(...)`; read the current value synchronously with
`subjects.<name>.getValue()`.

```ts
import { createWcBindable } from "@wc-bindable/rxjs";
import { combineLatest, map } from "rxjs";

const binder = createWcBindable<{ value: string; checked: boolean }>({
  value: "",
  checked: false,
});

const el = document.querySelector("my-input")!;
binder.bind(el);

const derived$ = combineLatest([binder.subjects.value, binder.subjects.checked]).pipe(
  map(([value, checked]) => `value=${value} checked=${checked}`),
);

derived$.subscribe(console.log);
```

Properties emitted by the component that are not in `initialValues` are
created lazily on first event, accessible via `binder.subjects[name]`. Because
they did not exist before the first event, they have no replayed initial value
for subscribers attached earlier — subscribe after `bind()` if you need to
catch lazy properties.

`unbind()` stops listening to DOM events but does **not** complete the
subjects, so you can rebind to a different element or keep them around for
downstream subscribers. If you want to terminate them, call `.complete()` on
each subject yourself or compose with `takeUntil`.

## Usage

```ts
import { createWcBindable } from "@wc-bindable/rxjs";
import "./my-counter.js";

const binder = createWcBindable<{ count: number }>({ count: 0 });

const el = document.createElement("my-counter");
binder.bind(el); // initial-sync is deferred until the element is connected
document.body.appendChild(el);

const out = document.createElement("p");
document.body.appendChild(out);

binder.subjects.count.subscribe((count) => {
  out.textContent = `count: ${count}`;
});
```

### Low-level usage

When you want to manage your own `Subject`s (e.g. to merge multiple bindable
elements into one stream), use the low-level helper:

```ts
import { Subject } from "rxjs";
import { wcBindable } from "@wc-bindable/rxjs";

const value$ = new Subject<string>();

const el = document.createElement("my-input");
document.body.appendChild(el);
const unbind = wcBindable(el, (name, v) => {
  if (name === "value") value$.next(v as string);
});

// later
unbind();
```

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
