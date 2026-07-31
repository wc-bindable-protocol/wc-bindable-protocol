# @wc-bindable/core

Core type definitions and bind utility for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/core
```

## Usage

### Declaring a bindable Web Component

```javascript
class MyInput extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      {
        name: "value",
        event: "my-input:value-changed",
      },
    ],
  };
}
```

### Binding to a component

```javascript
import { bind } from "@wc-bindable/core";

const unbind = bind(element, (name, value) => {
  console.log(`${name} changed to`, value);
});

// Clean up when done
unbind();
```

### Type guard

```javascript
import { isWcBindable } from "@wc-bindable/core";

if (isWcBindable(element)) {
  // element.constructor.wcBindable is available
}
```

## API

| Export | Description |
|---|---|
| `bind(target, onUpdate, options?)` | Attaches listeners for every declared property and reads each property's current value. Returns an `UnbindFn` that removes every listener it installed. `options.syncOn` is `"call"` (default), `"connect"` (defer the initial-value read until `connectedCallback` for unmounted `HTMLElement`s), or `"define"` (defer *discovery* until `customElements.whenDefined()` resolves, for elements whose definition may load later). |
| `getWcBindableDeclaration(target)` | Returns the validated declaration or `undefined`. MUST NOT throw, even on hostile targets — see [SPEC.md § Discovery API](../../SPEC.md#discovery-api). |
| `isWcBindable(target)` | Type guard wrapping `getWcBindableDeclaration() !== undefined`. Narrows `target` to `WcBindableElement`. |
| `WcBindableDeclaration` | Type for the `static wcBindable` field. |
| `WcBindableProperty` | Type for a single property descriptor (`{ name, event, getter? }`). |
| `WcBindableInput` | Type for a single input descriptor (`{ name, attribute? }`). |
| `WcBindableCommand` | Type for a single command descriptor (`{ name, async? }`). |
| `WcBindableElement` | Structural type for a protocol-compliant target (`add/removeEventListener` + `constructor.wcBindable`). Does NOT require `dispatchEvent` so relay-only proxies fit. |
| `WcBindableConstructor` | The constructor side of `WcBindableElement`. |
| `UnbindFn` | `() => void` — the cleanup function returned by `bind()`. |
| `BindOptions` | Options object for `bind()`. |
| `MIN_COMPATIBLE_VERSION` | Lowest protocol version any declaration may carry (fixed at `1`). See [SPEC.md § Versioning](../../SPEC.md#versioning). |
| `SUPPORTED_PROTOCOL_VERSION` | Deprecated alias for `MIN_COMPATIBLE_VERSION`. Removed in v1.0. |

The normative TypeScript surface lives in [SPEC.md § Normative TypeScript surface](../../SPEC.md#typescript-support). The exports above match it 1:1; the names here are authoritative when reading the implementation.

## License

MIT
