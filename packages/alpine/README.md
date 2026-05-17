# @wc-bindable/alpine

Alpine.js plugin adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/alpine alpinejs
```

## Usage

Register the plugin once, then use the `x-wc-bindable` directive on any element that implements the protocol.

```ts
import Alpine from "alpinejs";
import wcBindable from "@wc-bindable/alpine";

Alpine.plugin(wcBindable);
Alpine.start();
```

```html
<div x-data="{ count: 0 }">
  <my-counter x-wc-bindable></my-counter>
  <p x-text="count"></p>
</div>
```

Bindable properties are written directly onto the nearest Alpine `x-data` scope, so they become reactive without any extra wiring.

### Nesting under a target object

Pass an expression that evaluates to a key name to group all bound properties under a single object on the scope. This is handy when you have multiple components or want to avoid name collisions.

```html
<div x-data="{ fetcher: {} }">
  <my-fetch x-wc-bindable="'fetcher'" manual></my-fetch>
  <pre x-text="JSON.stringify(fetcher, null, 2)"></pre>
</div>
```

## API

### `wcBindable` (Alpine plugin)

Default export. Pass to `Alpine.plugin()` to register the `x-wc-bindable` directive globally.

### `x-wc-bindable[="<target>"]` (Alpine directive)

| Parameter | Type | Description |
|---|---|---|
| `<target>` (expression) | `string` *(optional)* | Name of an object on the surrounding `x-data` scope. When present, bound properties are written into that object; when omitted, they are written directly onto the scope. |

- Binds on directive setup and cleans up automatically via Alpine's `cleanup` hook.
- If the element does not implement `wc-bindable`, the directive is a no-op.

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
