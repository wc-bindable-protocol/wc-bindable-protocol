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
| `bind(element, onUpdate)` | Attaches listeners for all bindable properties. Returns an unbind function. |
| `isWcBindable(element)` | Type guard that checks if an element implements the protocol. |
| `WcBindableDeclaration` | Type for the `static wcBindable` field. |
| `WcBindableProperty` | Type for a single property descriptor. |
| `WcBindableElement` | Type for a protocol-compliant element. |
| `UnbindFn` | Type alias for the cleanup function returned by `bind()`. |

## License

MIT
