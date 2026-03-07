# wc-bindable-protocol Specification

**Protocol:** `wc-bindable`  
**Version:** 1  

---

## Overview

`wc-bindable-protocol` is a minimal, framework-agnostic protocol that enables any Web Component to declare its reactive properties so that any reactivity system (React, Vue, Svelte, etc.) can bind to them without framework-specific coupling.

The protocol requires no dependencies and relies solely on browser-native APIs: `static` class fields and `CustomEvent`.

---

## Goals

- Allow Web Component authors to declare bindable properties once
- Allow any reactivity system to consume those declarations without prior knowledge of the component
- Remain zero-dependency and runtime-only
- Be simple enough to implement in tens of lines of code

---

## Protocol Declaration

A Web Component declares its bindable properties by defining a `static wcBindable` field on the class.

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
      {
        name: "checked",
        event: "my-input:checked-changed",
        getter: (e) => e.detail.checked,
      },
    ],
  };
}
```

---

## Schema

### Root

| Field        | Type     | Required | Description                          |
|--------------|----------|----------|--------------------------------------|
| `protocol`   | `string` | ✅       | Must be `"wc-bindable"`              |
| `version`    | `number` | ✅       | Must be integer `1`                  |
| `properties` | `array`  | ✅       | List of bindable property descriptors |

### Property Descriptor

| Field    | Type       | Required | Description                                              |
|----------|------------|----------|----------------------------------------------------------|
| `name`   | `string`   | ✅       | The property name on the element                         |
| `event`  | `string`   | ✅       | The CustomEvent name dispatched when the property changes |
| `getter` | `function` | ❌       | Extracts the new value from the event. Defaults to `e => e.detail` |

---

## Event Naming Convention

Event names should follow the `namespace:property-changed` pattern.

```
my-input:value-changed
^^^^^^^^ ^^^^^^^^^^^^^
  │         └─ property identifier
  └─ component namespace (chosen by author)
```

The namespace is chosen freely by the component author. It is recommended to match the custom element tag name.

---

## Default Getter

When `getter` is omitted, the protocol defines the default getter as:

```javascript
(e) => e.detail
```

Reactivity system adapters **must** implement this default. Component authors **should** dispatch `CustomEvent` with the new value set directly as `detail`:

```javascript
this.dispatchEvent(new CustomEvent('my-input:value-changed', { detail: this._value }));
```

---

## Custom Getter

When the event payload is nested or the component reuses an existing DOM event, a custom `getter` can be specified:

```javascript
// detail is an object
getter: (e) => e.detail.value

// reusing a native DOM event
getter: (e) => e.target.value
```

---

## Adapter Implementation Guide

A reactivity system that supports this protocol should:

1. Read `element.constructor.wcBindable`
2. Verify `protocol === "wc-bindable"` and `version === 1`
3. For each property descriptor:
   a. Read the current value of `element[prop.name]` — if it is not `undefined`, deliver it to the consumer immediately (initial value synchronization)
   b. Attach an event listener for subsequent changes

```javascript
const DEFAULT_GETTER = (e) => e.detail;

function bind(element, onUpdate) {
  const { protocol, version, properties } = element.constructor.wcBindable;

  if (protocol !== "wc-bindable" || version !== 1) return;

  for (const prop of properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    element.addEventListener(prop.event, (event) => {
      onUpdate(prop.name, getter(event));
    });

    // Initial value synchronization
    const current = element[prop.name];
    if (current !== undefined) {
      onUpdate(prop.name, current);
    }
  }
}
```

### Initial Value Synchronization

Initial value synchronization is a **required** part of the protocol (not merely an adapter implementation suggestion). Adapters **must** read `element[prop.name]` at bind time for each declared property. If the value is not `undefined`, the adapter delivers it to the consumer immediately — before any events fire.

This ensures that components whose properties are set before the adapter binds (e.g., server-rendered attributes, programmatic initialization) are correctly reflected in the consuming framework's state from the start.

Component authors **should** ensure that the property named in `name` is readable on the element instance and reflects the current state at any point in time.

### Repeated Events for the Same Property

When a component dispatches the same event multiple times, the adapter calls `onUpdate` for each occurrence. There is no batching, deduplication, or equality check — every event produces a callback. Consumers that need deduplication (e.g., skipping no-op re-renders) are responsible for implementing it on their side.

### Getter Errors

If a `getter` function throws during event handling, the adapter **must not** swallow the error silently. The error should propagate naturally (i.e., be thrown from the event listener). This preserves normal JavaScript error semantics and allows component authors to detect bugs in their getter implementations.

Adapters **should not** wrap getter calls in try/catch unless they re-throw the error after performing cleanup.

### Undeclared or Missing Properties

The `name` field in a property descriptor serves two purposes:

1. It is passed to `onUpdate` as the property identifier.
2. It is used to read `element[name]` for initial value synchronization.

If `element[name]` is `undefined` at bind time (including when the property does not exist on the element), the adapter simply skips the initial synchronization for that property. This is not an error — the adapter proceeds normally and will still listen for the declared event.

Component authors **should** ensure that every `name` in the declaration corresponds to a readable property on the element instance. However, adapters **must not** throw or warn if the property is absent.

---

## Versioning

The protocol version is an integer. Breaking changes increment the version.  
Adapters should check the version field before binding.

| Version | Status  | Notes            |
|---------|---------|------------------|
| `1`     | ✅ Current | Initial specification |

---

## FAQ

**Why `static` field?**  
Static fields are accessible without instantiation, allowing adapters to inspect the protocol before mounting the element.

**Why not JSON / custom attribute?**  
Functions (getters) cannot be expressed in JSON. A `static` field keeps everything in one place with full JavaScript expressiveness.

**Is this a W3C standard?**  
No. This is a community protocol. Any Web Component or framework can adopt it independently.

---

## License

MIT
