# wc-bindable-protocol Specification

**Protocol:** `wc-bindable`  
**Version:** 1  

---

## Overview

`wc-bindable-protocol` is a minimal, framework-agnostic protocol that enables any class extending `EventTarget` to declare its reactive properties so that any reactivity system (React, Vue, Svelte, etc.) can bind to them without framework-specific coupling. Optionally, components can also declare their input properties and commands, providing a complete interface description that enables tooling, documentation generation, and remote proxying.

The minimum requirement is `EventTarget` — any object that supports `addEventListener` and `dispatchEvent` can participate in the protocol. `HTMLElement` (a subclass of `EventTarget`) is the most common implementation target, as it enables DOM integration and framework binding via refs, but it is not required. This means the protocol works equally well in non-browser runtimes (Node.js, Deno, Cloudflare Workers, etc.) where `EventTarget` is available.

The protocol requires no dependencies and relies solely on standard APIs: `static` class fields and `CustomEvent`.

---

## Goals

- Allow any EventTarget-based class to declare bindable properties once
- Optionally allow declaration of input properties and commands for a complete interface description
- Allow any reactivity system to consume those declarations without prior knowledge of the component
- Remain zero-dependency and runtime-only
- Be simple enough to implement in tens of lines of code

---

## Protocol Declaration

Any class extending `EventTarget` declares its bindable properties by defining a `static wcBindable` field on the class.

### Headless (EventTarget only)

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs: [
      { name: "url" },
      { name: "method" },
    ],
    commands: [
      { name: "fetch", async: true },
      { name: "abort" },
    ],
  };
}
```

This form works in any runtime that provides `EventTarget` and `CustomEvent` (browsers, Node.js, Deno, Cloudflare Workers, etc.).

The `inputs` and `commands` fields are optional. When present, they declare the component's input interface — settable properties and callable methods — enabling tooling, documentation generation, and remote proxying. They do **not** create any implicit data flow; the consumer is responsible for explicitly setting properties and invoking methods. The semantics for *how* a consumer sets inputs and invokes commands (delivery guarantees, error handling, the role of `attribute` / `async`) are described in [SPEC-extensions.md](SPEC-extensions.md) — the core protocol itself does not interpret these fields.

### Web Component (HTMLElement)

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
    inputs: [
      { name: "value", attribute: "value" },
      { name: "placeholder", attribute: "placeholder" },
    ],
    commands: [
      { name: "focus" },
      { name: "clear" },
    ],
  };
}
```

`HTMLElement` extends `EventTarget`, so Web Components are fully compatible. This form is required when the component needs to be mounted in the DOM and accessed via framework refs.

When declaring inputs for a Shell (HTMLElement), the optional `attribute` field indicates the corresponding HTML attribute. This information is purely declarative — see [SPEC-extensions.md](SPEC-extensions.md) for how tooling can use it.

---

## Schema

### Root

| Field        | Type     | Required | Description                          |
|--------------|----------|----------|--------------------------------------|
| `protocol`   | `string` | ✅       | Must be `"wc-bindable"`              |
| `version`    | `number` | ✅       | Integer `>= 1`. See [Versioning](#versioning). |
| `properties` | `array`  | ✅       | List of bindable property descriptors |
| `inputs`     | `array`  | ❌       | List of input property descriptors (see [SPEC-extensions.md](SPEC-extensions.md)) |
| `commands`   | `array`  | ❌       | List of command descriptors (see [SPEC-extensions.md](SPEC-extensions.md)) |

Adapters **MUST** ignore unknown top-level fields. Future versions of this specification may add new optional root keys; older adapters that do not recognize them must still bind successfully to `properties`.

### Property Descriptor

| Field    | Type       | Required | Description                                              |
|----------|------------|----------|----------------------------------------------------------|
| `name`   | `string`   | ✅       | The property name on the target                          |
| `event`  | `string`   | ✅       | The CustomEvent name dispatched when the property changes |
| `getter` | `function` | ❌       | Extracts the new value from the event. Defaults to `e => e.detail` |

Within a single `properties` array, every `name` MUST be unique. Behavior is undefined if duplicate names appear. Multiple property descriptors MAY share the same `event` name — adapters dispatch each one independently. The same `name` MAY appear in both `properties` (as an observable output) and `inputs` (as a settable input); this is a common pattern for two-way-bindable values (e.g. `value`).

Adapters **MUST** ignore unknown fields on a property descriptor.

### Input Descriptor

| Field       | Type     | Required | Description                                          |
|-------------|----------|----------|------------------------------------------------------|
| `name`      | `string` | ✅       | The settable property name on the target             |
| `attribute` | `string` | ❌       | Declarative hint, see [SPEC-extensions.md](SPEC-extensions.md). Not interpreted by core. |

Within `inputs`, every `name` MUST be unique. Adapters **MUST** ignore unknown fields on an input descriptor.

### Command Descriptor

| Field   | Type      | Required | Description                                            |
|---------|-----------|----------|--------------------------------------------------------|
| `name`  | `string`  | ✅       | The method name on the target                          |
| `async` | `boolean` | ❌       | Declarative hint, see [SPEC-extensions.md](SPEC-extensions.md). Not interpreted by core. |

Within `commands`, every `name` MUST be unique. Adapters **MUST** ignore unknown fields on a command descriptor.

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

1. Read `target.constructor.wcBindable`
2. Verify `protocol === "wc-bindable"` and `version >= SUPPORTED_VERSION` (see [Versioning](#versioning))
3. For each property descriptor:
   a. Attach an event listener for subsequent changes
   b. Perform the initial-value synchronization (see below)
4. Return a function that removes every listener registered above (the **teardown contract**, see below)

The `target` parameter accepts any `EventTarget` — this includes `HTMLElement` instances as well as headless `EventTarget` subclasses.

```javascript
const DEFAULT_GETTER = (e) => e.detail;
const SUPPORTED_VERSION = 1;

// DOM globals are referenced through these locals so that the reference
// implementation runs unmodified in headless runtimes (Node, Deno,
// Workers) where `HTMLElement` / `document` / `MutationObserver` are not
// defined as globals. In a headless runtime all three are `undefined`,
// `syncOn: "connect"` silently falls back to the synchronous `"call"`
// path, and only `EventTarget`-based targets are touched.
const HTMLElementCtor = typeof HTMLElement !== "undefined" ? HTMLElement : undefined;
const documentRef = typeof document !== "undefined" ? document : undefined;
const MutationObserverCtor =
  typeof MutationObserver !== "undefined" ? MutationObserver : undefined;

function bind(target, onUpdate, options) {
  const decl = target.constructor.wcBindable;
  if (decl?.protocol !== "wc-bindable") return () => {};
  if (!Number.isInteger(decl.version) || decl.version < SUPPORTED_VERSION) return () => {};

  const cleanups = [];
  for (const prop of decl.properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    const handler = (event) => onUpdate(prop.name, getter(event));
    target.addEventListener(prop.event, handler);
    cleanups.push(() => target.removeEventListener(prop.event, handler));
  }

  // Initial value synchronization — use `in` so that an explicitly-undefined
  // property is still reported on first sync.
  const initialSync = () => {
    for (const prop of decl.properties) {
      if (prop.name in target) onUpdate(prop.name, target[prop.name]);
    }
  };

  const syncOn = options?.syncOn ?? "call";
  const canDefer =
    syncOn === "connect" &&
    HTMLElementCtor !== undefined &&
    target instanceof HTMLElementCtor &&
    !target.isConnected &&
    documentRef !== undefined &&
    MutationObserverCtor !== undefined;

  if (canDefer) {
    const observer = new MutationObserverCtor(() => {
      if (target.isConnected) { observer.disconnect(); initialSync(); }
    });
    observer.observe(documentRef, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  } else {
    initialSync();
  }

  return () => cleanups.forEach((fn) => fn());
}
```

### Teardown Contract

`bind()` **MUST** return a function that, when called, removes every event listener (and any other resource — e.g. `MutationObserver`) the adapter installed during the call. This applies whether or not the target was actually bindable: a no-op cleanup function (`() => {}`) is the correct return value for non-`wc-bindable` targets.

Long-lived headless `Core` instances may outlive multiple consumers; without an explicit teardown contract, listener leaks are guaranteed. Component-side `disconnectedCallback` cannot be relied on because headless Cores have no DOM lifecycle, and Web Components bound via framework refs may be reattached.

### Initial Value Synchronization

Initial value synchronization is a **required** part of the protocol (not merely an adapter implementation suggestion). For each declared property at bind time:

- If `prop.name in target` is `true`, the adapter **MUST** read `target[prop.name]` and deliver the value (including when it is `undefined`) to the consumer immediately, before any events fire.
- If `prop.name in target` is `false` (the property does not exist on the target), the adapter **MUST** skip the initial synchronization for that property. This is not an error.

The `in` operator is mandated specifically so that `undefined` can be distinguished from "property not declared on target". An earlier revision of this spec used `target[prop.name] !== undefined` as the gate; that gate cannot deliver a legitimately-`undefined` initial value, and is now superseded.

Component authors **should** ensure that every `name` in the declaration corresponds to a readable property on the target instance.

#### Deferring the Initial Sync Until Connection

When `target` is an `HTMLElement` and `bind()` is called before the element has been inserted into a document (so `connectedCallback` has not yet run), reading properties synchronously may observe pre-connection state. To address this, `bind()` accepts an optional third argument:

```typescript
bind(target, onUpdate, { syncOn: "connect" })
```

- `syncOn: "call"` (default): perform the initial sync synchronously inside `bind()`. Backward-compatible behavior.
- `syncOn: "connect"`: if the target is an `HTMLElement` that is not yet connected, defer the initial sync until the element becomes connected. The reference implementation observes the top-level `document` via a `MutationObserver`. For headless `EventTarget`s and already-connected elements, behaves like `"call"`. The DOM globals (`HTMLElement`, `document`, `MutationObserver`) are referenced through `typeof` guards so that the reference implementation runs unmodified in non-browser runtimes where these globals are undefined — in that case `syncOn: "connect"` silently falls back to the `"call"` path.

The returned unbind function tears down the `MutationObserver` as well, so cancelling a deferred bind is safe.

> **Shadow DOM limitation.** A `MutationObserver` attached to `document` with `subtree: true` does **not** traverse shadow roots, so a target that is appended into another element's shadow tree will have `target.isConnected === true` without firing the observer — the deferred initial sync never runs. This is a structural limitation of `MutationObserver`, not a bug. Adapters that **own** the element (i.e. hold a ref to it via a framework lifecycle hook such as React `useEffect`, Vue `onMounted`, Stencil `componentDidLoad`, or a custom element's own `connectedCallback`) **SHOULD** call `bind(target, onUpdate)` (with the default `syncOn: "call"`) from inside that hook rather than relying on `syncOn: "connect"`. The deferred path is intended for callers who construct elements imperatively and append them into the light DOM in a separate step (e.g. the VanJS / MobX / RxJS / Signals binder pattern). Adapters that deferred-bind a large number of elements simultaneously should also be aware that each deferred bind installs one document-wide observer.

### Repeated Events for the Same Property

When a component dispatches the same event multiple times, the adapter calls `onUpdate` for each occurrence. There is no batching, deduplication, or equality check — every event produces a callback. Consumers that need deduplication (e.g., skipping no-op re-renders) are responsible for implementing it on their side.

### Event detail vs Property Read

The protocol uses two independent reads of the property value:

- **Initial sync** reads `target[prop.name]` directly.
- **Subsequent updates** read `getter(event)`, defaulting to `event.detail`.

The two **SHOULD** be kept in agreement by the component author. If they diverge (e.g. a `detail` payload differs from the current property value), the **event payload is authoritative** — adapters do not re-read the property after an event fires. Component authors who cannot guarantee parity should derive `detail` from the property at dispatch time.

### Getter Errors

If a `getter` function throws during event handling, the adapter **must not** swallow the error silently. The error should propagate naturally (i.e., be thrown from the event listener). This preserves normal JavaScript error semantics and allows component authors to detect bugs in their getter implementations.

Adapters **should not** wrap getter calls in try/catch unless they re-throw the error after performing cleanup.

---

## Versioning

The protocol version is an integer. Future versions **MUST** remain backward-compatible at the `properties` binding contract level:

- An adapter built for version `N` **MUST** accept any declaration whose `version` is `>= N`.
- New optional fields (on the root, on property/input/command descriptors, or new root-level keys entirely) may be added in later versions. Older adapters **MUST** ignore fields they do not recognize.
- Breaking changes to the `properties` binding contract (the shape of property descriptors, the meaning of `event` / `getter`, the initial-sync rule, the teardown contract) require a new `protocol` identifier (e.g. `"wc-bindable-2"`), **not** a version bump. This guarantees that a v1 adapter never silently misinterprets a future declaration.

| Version | Status  | Notes            |
|---------|---------|------------------|
| `1`     | ✅ Current | Initial specification. Required: `protocol`, `version`, `properties`. Optional: `inputs`, `commands`. Initial sync uses `in` operator. `bind()` returns an unbind function. |

---

## TypeScript Support

### Value Type Declaration

Component authors **should** export a TypeScript interface describing the shape of their bindable values:

```typescript
// my-counter/types.ts
export interface MyCounterValues {
  count: number;
}
```

```typescript
// my-fetch/types.ts
export interface MyFetchValues {
  value: unknown;
  loading: boolean;
  error: { status: number; statusText: string; body: string } | null;
  status: number;
}
```

This interface represents the compile-time contract that complements the runtime contract (`static wcBindable`).

### Adapter Usage

Framework adapters **should** accept an optional generic type parameter for the values object. The first type parameter constrains the target type — use `EventTarget` for headless targets or `HTMLElement` (default) for DOM-mounted components:

```typescript
// React — DOM component
const [ref, values] = useWcBindable<HTMLElement, MyCounterValues>();
values.count   // number — type-checked

// Vue — DOM component
const { ref, values } = useWcBindable<HTMLElement, MyFetchValues>();
values.loading // boolean — type-checked

// Headless (non-DOM) — bind directly to an EventTarget
const core = new MyFetchCore();
bind(core, (name, value) => { /* ... */ });
```

When the type parameter is omitted, the values type defaults to `Record<string, unknown>`, preserving backward compatibility.

### Two-Layer Contract

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| Runtime | `static wcBindable` + `CustomEvent` on `EventTarget` | Protocol detection, event binding, input/command declaration |
| Compile-time | `export interface ...Values` | Type-safe access to bound values |

The type declaration is a **recommendation**, not a requirement. Components without type exports still work — consumers simply receive `unknown` values. The `import type` syntax ensures type declarations have zero runtime cost.

---

## Trust Boundaries

The protocol assumes the `target` is trusted by the consumer: `getter` is an arbitrary function executed in the consumer's JavaScript context every time an event fires. Components should not declare a `getter` that performs anything other than pure extraction of the new value from the event.

When the protocol is proxied across a trust boundary (for example, `@wc-bindable/remote`, which connects a server-side Core to a client-side proxy), the `getter` cannot be transported as code — it is applied on the trusted side and only the extracted value crosses the wire. Implementations that bridge trust boundaries **MUST** document how `getter`, `set`, and `invoke` are translated; see [SPEC-extensions.md](SPEC-extensions.md) for one such treatment.

---

## FAQ

**Why `static` field?**  
Static fields are accessible without instantiation, allowing adapters to inspect the protocol before mounting the element.

**Why not JSON / custom attribute?**  
Functions (getters) cannot be expressed in JSON. A `static` field keeps everything in one place with full JavaScript expressiveness.

**Why EventTarget and not HTMLElement?**
`EventTarget` is the minimal interface that provides `addEventListener` and `dispatchEvent`. By targeting `EventTarget`, the protocol works in non-browser runtimes (Node.js, Deno, Cloudflare Workers) and enables headless components that encapsulate business logic without any DOM dependency. `HTMLElement` is a subclass of `EventTarget`, so all Web Components are automatically compatible.

**Why are `inputs` and `commands` optional?**
The protocol's primary purpose is reactive property binding (`properties`). The `inputs` and `commands` fields are an opt-in extension for components that wish to declare their full interface — for example, to enable remote proxying, tooling, or documentation generation. Components that only need one-way state observation can omit them entirely. Importantly, these fields are purely declarative — they do not create any automatic two-way synchronization between the component and the framework.

**Why doesn't `bind()` interpret `inputs` and `commands` directly?**
Doing so would require the core to take a position on call semantics (synchronous? batched? acked? error-mapped?) that varies wildly across runtimes. The core stays small by reading only `properties`; downstream specs build call semantics on top — see [SPEC-extensions.md](SPEC-extensions.md).

**Is this a W3C standard?**
No. This is a community protocol. Any EventTarget-based class or framework can adopt it independently.

---

## License

MIT
