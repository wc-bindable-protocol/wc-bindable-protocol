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

When `inputs` or `commands` is absent (`undefined`), consumers **MUST** treat it as an empty array (`[]`) — semantically equivalent to declaring "no inputs" / "no commands". An absent field and an explicit `[]` MUST behave identically for every consumer concern (e.g. Extension 1's "name MUST be declared in inputs/commands before a `set` / `invoke` reaches the producer" check rejects every name under both encodings).

### Property Descriptor

| Field    | Type       | Required | Description                                              |
|----------|------------|----------|----------------------------------------------------------|
| `name`   | `string`   | ✅       | The property name on the target                          |
| `event`  | `string`   | ✅       | The CustomEvent name dispatched when the property changes |
| `getter` | `function` | ❌       | Extracts the new value from the event. Defaults to `e => e.detail` |

Within a single `properties` array, every `name` MUST be unique. A declaration that violates this rule is **invalid**: adapters MUST treat such a target as non-bindable (`bind()` returns its no-op cleanup, `isWcBindable()` MAY return `false` if the adapter checks; at minimum, no event listeners are installed). Adapters MAY warn or throw in development mode. Multiple property descriptors MAY share the same `event` name — adapters dispatch each one independently. The same `name` MAY appear in both `properties` (as an observable output) and `inputs` (as a settable input); this is a common pattern for two-way-bindable values (e.g. `value`).

Adapters **MUST** ignore unknown fields on a property descriptor.

### Input Descriptor

| Field       | Type     | Required | Description                                          |
|-------------|----------|----------|------------------------------------------------------|
| `name`      | `string` | ✅       | The settable property name on the target             |
| `attribute` | `string` | ❌       | Declarative hint, see [SPEC-extensions.md](SPEC-extensions.md). Not interpreted by core. |

Within `inputs`, every `name` MUST be unique. Duplicate names make the declaration **invalid** under the same rule given for properties above. Adapters **MUST** ignore unknown fields on an input descriptor.

### Command Descriptor

| Field   | Type      | Required | Description                                            |
|---------|-----------|----------|--------------------------------------------------------|
| `name`  | `string`  | ✅       | The method name on the target                          |
| `async` | `boolean` | ❌       | Declarative hint, see [SPEC-extensions.md](SPEC-extensions.md). Not interpreted by core. |

Within `commands`, every `name` MUST be unique. Duplicate names make the declaration **invalid** under the same rule given for properties above. Adapters **MUST** ignore unknown fields on a command descriptor.

---

## Discovery Contract

Protocol detection (`isWcBindable(target)`) and binding (`bind(target, ...)`) both reach for the declaration via `target.constructor.wcBindable`. This is the **sole** discovery path defined by the protocol — there is no global registry, no symbol property, no fallback lookup.

Any object an adapter is asked to bind against MUST therefore expose a `constructor` whose `wcBindable` property satisfies the [Schema](#schema):

- A plain class that defines `static wcBindable = { ... }` satisfies this automatically — JavaScript's `instance.constructor` already references the class object.
- A **wrapper or proxy** that stands in for a real `EventTarget` (for example, a `Proxy`-wrapped object whose `get`/`set` traps route to a remote Core, or a test double) MUST expose an `equivalent` `constructor.wcBindable` declaration. "Equivalent" means: same `protocol`, the same `version` integer as the wrapped target (the [Versioning](#versioning) policy guarantees every adapter accepts every `version >= 1`, so wrappers do not need a version-matching step), same `properties` (including `event` names and `getter` semantics observable on the wrapper), and — when [SPEC-extensions.md § Extension 1](SPEC-extensions.md) is in use — the same `inputs` and `commands` membership as the wrapped target. Wrappers MAY rewrite `event` names internally (the `@wc-bindable/remote` `RemoteCoreProxy` uses synthetic per-property event names to disambiguate properties sharing a Core-side event), but the declaration the consumer reads via `target.constructor.wcBindable` MUST describe the events the wrapper actually dispatches, not the events the wrapped target dispatches.
- Implementations that wrap one declaration per instance (i.e. multiple wrapped targets coexisting on the same page) MUST give each instance an **isolated** `constructor.wcBindable` — sharing a single constructor across instances with different declarations would break `isWcBindable()` and `bind()` for every instance after the first declaration write. The typical pattern is to synthesize a unique subclass per wrapped target.

Adapters MUST NOT cache the declaration across binds — re-read `target.constructor.wcBindable` on each `bind()` call so that proxies whose declaration changes on reconnect are observed correctly.

### Discovery API

Implementations **MUST** expose two discovery primitives whose contracts are observable by consumers:

| Function | Returns | Contract |
|---|---|---|
| `getWcBindableDeclaration(target)` | `WcBindableDeclaration \| undefined` | Resolves the declaration via the rule above and **fully validates** it. Returns `undefined` if any of the following hold: `target.constructor.wcBindable` is missing; `protocol !== "wc-bindable"`; `version` is not an integer `>= 1`; `properties` is not an array; any property descriptor is missing a non-empty string `name` or `event`, or has a non-function `getter`; any input or command descriptor is missing a non-empty string `name`; any `name` is duplicated within `properties`, within `inputs`, or within `commands`. MUST NOT throw. MUST NOT consult any source other than `target.constructor.wcBindable`. |
| `isWcBindable(target)` | `boolean` | A type guard that is exactly equivalent to `getWcBindableDeclaration(target) !== undefined`. Implementations MAY (and SHOULD) implement it as that one-line forward. |

**Discovery is bindability.** Because `getWcBindableDeclaration()` performs the complete schema validation (including the duplicate-name rule that invalidates a declaration per § Property Descriptor / § Input Descriptor / § Command Descriptor), no declaration that survives this filter can silently no-op inside `bind()`. The earlier draft where `isWcBindable()` could return `true` for an invalid declaration while `bind()` returned a no-op cleanup is fixed: the two helpers now agree by construction. Consumers can therefore use `isWcBindable()` as the single decision point for "will `bind()` install listeners?".

The two functions are kept paired so that callers who need the declaration object (tooling, codegen, devtools, test inspection) read it once instead of probing for existence and then re-reading. Adapters that perform their own discovery MUST surface the same `boolean`-vs-declaration pair to be considered conforming. Naming is normative — third-party implementations of these helpers MUST use the same identifiers so consumers can swap implementations.

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
2. Verify `protocol === "wc-bindable"` and `version` is an integer `>= 1` (see [Versioning](#versioning))
3. For each property descriptor:
   a. Attach an event listener for subsequent changes
   b. Perform the initial-value synchronization (see below)
4. Return a function that removes every listener registered above (the **teardown contract**, see below)

The `target` parameter accepts any `EventTarget` — this includes `HTMLElement` instances as well as headless `EventTarget` subclasses.

### `onUpdate` callback shape

The normative shape of the per-update callback passed to `bind()` is the **positional form**:

```typescript
type OnUpdate = (name: string, value: unknown) => void;
```

Third-party adapters that re-export `bind()` MUST preserve this signature. Higher-level binder layers (framework adapters that wrap `bind()` to drive React state, Vue refs, Angular outputs, etc.) MAY re-pack the call into a framework-idiomatic shape — for example, the Angular adapter dispatches a single-argument `{ name, value }` event on a Subject because Angular outputs are single-argument. Re-packing at the framework layer is permitted; **changing the positional signature of the protocol-level `bind()` callback is not.**

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

- If `prop.name in target` is `true`, the adapter **MUST** read `target[prop.name]` and deliver the value (including when it is `undefined`) to the consumer.
- If `prop.name in target` is `false` (the property does not exist on the target), the adapter **MUST** skip the initial synchronization for that property. This is not an error.

The `in` operator is mandated specifically so that `undefined` can be distinguished from "property not declared on target". An earlier revision of this spec used `target[prop.name] !== undefined` as the gate; that gate cannot deliver a legitimately-`undefined` initial value, and is now superseded.

Component authors **should** ensure that every `name` in the declaration corresponds to a readable property on the target instance.

#### Ordering vs subsequent events

The relative ordering of the initial-sync delivery and the first subsequent `onUpdate` triggered by an event depends on `syncOn`:

- With `syncOn: "call"` (the default), the adapter **MUST** deliver the initial-sync values **before any subsequent change events fire on the same target**. Since `bind()` performs the synchronous initial-sync inside the same call that attaches event listeners, this ordering follows naturally as long as the host does not dispatch on the target re-entrantly inside `onUpdate`.
- With `syncOn: "connect"`, the initial-sync read is intentionally deferred until the target becomes connected. **Any change event that fires between `bind()` return and the deferred initial-sync MUST be delivered to `onUpdate` in the order it arrives** — that is, an event arriving before the deferred sync is delivered first, and the deferred initial-sync runs afterwards with `target[prop.name]` read at sync time. The consumer therefore sees the most recent value last, regardless of the path it arrived on. This is the only sound interpretation when the read site is deferred; the `"before any events fire"` guarantee from `syncOn: "call"` is **not** in effect under `syncOn: "connect"`.

In both modes, the **event payload is authoritative** in case the initial-sync read and a subsequent event disagree on the value — see [§ Event detail vs Property Read](#event-detail-vs-property-read).

#### Deferring the Initial Sync Until Connection

When `target` is an `HTMLElement` and `bind()` is called before the element has been inserted into a document (so `connectedCallback` has not yet run), reading properties synchronously may observe pre-connection state. To address this, `bind()` accepts an optional third argument:

```typescript
bind(target, onUpdate, { syncOn: "connect" })
```

- `syncOn: "call"` (default): perform the initial sync synchronously inside `bind()`. Backward-compatible behavior.
- `syncOn: "connect"`: if the target is an `HTMLElement` that is not yet connected, defer the initial sync until the element becomes connected **for the first time**. The reference implementation observes the top-level `document` via a `MutationObserver`. For headless `EventTarget`s and already-connected elements, behaves like `"call"`. The DOM globals (`HTMLElement`, `document`, `MutationObserver`) are referenced through `typeof` guards so that the reference implementation runs unmodified in non-browser runtimes where these globals are undefined — in that case `syncOn: "connect"` silently falls back to the `"call"` path. **Disconnect → reconnect cycles after the first connection do NOT re-trigger the initial sync** — the observer disconnects as soon as the deferred sync fires once. Consumers that need a fresh initial-sync on every re-attach should unbind and re-bind from their own lifecycle hook.

The returned unbind function tears down the `MutationObserver` as well, so cancelling a deferred bind is safe.

> **Shadow DOM limitation.** A `MutationObserver` attached to `document` with `subtree: true` does **not** traverse shadow roots, so a target that is appended into another element's shadow tree will have `target.isConnected === true` without firing the observer — the deferred initial sync never runs. This is a structural limitation of `MutationObserver`, not a bug. Adapters that **own** the element (i.e. hold a ref to it via a framework lifecycle hook such as React `useEffect`, Vue `onMounted`, Stencil `componentDidLoad`, or a custom element's own `connectedCallback`) **SHOULD** call `bind(target, onUpdate)` (with the default `syncOn: "call"`) from inside that hook rather than relying on `syncOn: "connect"`. The deferred path is intended for callers who construct elements imperatively and append them into the light DOM in a separate step (e.g. the VanJS / MobX / RxJS / Signals binder pattern). Adapters that deferred-bind a large number of elements simultaneously should also be aware that each deferred bind installs one document-wide observer.

### Repeated Events for the Same Property

When a component dispatches the same event multiple times, the adapter calls `onUpdate` for each occurrence. There is no batching, deduplication, or equality check — every event produces a callback. Consumers that need deduplication (e.g., skipping no-op re-renders) are responsible for implementing it on their side.

### Event detail vs Property Read

The protocol uses two independent reads of the property value:

- **Initial sync** reads `target[prop.name]` directly.
- **Subsequent updates** read `getter(event)`, defaulting to `event.detail`.

The two **SHOULD** be kept in agreement by the component author. If they diverge (e.g. a `detail` payload differs from the current property value), the **event payload is authoritative** — adapters do not re-read the property after an event fires. Component authors who cannot guarantee parity should derive `detail` from the property at dispatch time.

> **Edge case — synchronous re-entry from a property getter.** Because adapters attach listeners before performing the initial-sync read (so that no event is missed during the read), a property whose getter synchronously dispatches a change event for the same property will cause `onUpdate` to fire twice during `bind()`: once with the event payload, once with the initial-sync read. The consumer observes both calls in dispatch order. Component authors **should not** dispatch from a getter; if the side effect is unavoidable, treat the event-payload-authoritative rule as still applying, and accept that the initial-sync delivery may overwrite the just-dispatched value in the consumer's state.

### Getter Errors

If a `getter` function throws during event handling, the adapter **must not** swallow the error silently. The error should propagate naturally (i.e., be thrown from the event listener). This preserves normal JavaScript error semantics and allows component authors to detect bugs in their getter implementations.

Adapters **should not** wrap getter calls in try/catch unless they re-throw the error after performing cleanup.

---

## Versioning

The protocol version is an integer. Within a single `protocol` identifier (e.g. `"wc-bindable"`), every adapter and every declaration are mutually compatible by construction:

- An adapter **MUST** accept any declaration whose `version` is an integer `>= 1`, regardless of when the adapter was built or what version the adapter itself was originally designed against. Adapters **MUST NOT** impose an adapter-specific upper or lower version bound (e.g. "this v2 adapter only handles `version >= 2`"). Doing so would silently no-op against valid older declarations and is explicitly forbidden.
- New optional fields (on the root, on property/input/command descriptors, or new root-level keys entirely) may be added in later versions. Adapters **MUST** ignore fields they do not recognize. The `version` field then becomes informational at the wire / discovery level — its primary role within a given `protocol` identifier is to flag the presence of newer optional fields, not to gate acceptance.
- Breaking changes to the `properties` binding contract (the shape of property descriptors, the meaning of `event` / `getter`, the initial-sync rule, the teardown contract) require a new `protocol` identifier (e.g. `"wc-bindable-2"`), **not** a version bump. This guarantees both directions: a v1 adapter never silently misinterprets a future declaration **and** a future-version adapter never silently rejects a v1 declaration.

In `@wc-bindable/core`, the exported constant `MIN_COMPATIBLE_VERSION` is pinned to `1` and serves only as a sanity check that the `version` field exists, is a number, is an integer, and is `>= 1`. It is **not** an adapter-version dial and MUST NOT be raised in future releases.

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

### Input and Command Type Declarations

Components that declare `inputs` or `commands` **should** export companion interfaces so that consumers, remote proxies, devtools, and codegen tools can type-check the input/command surface without re-deriving it:

```typescript
// my-fetch/types.ts
export interface MyFetchValues {
  value: unknown;
  loading: boolean;
  error: { status: number; statusText: string; body: string } | null;
  status: number;
}

export interface MyFetchInputs {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
}

export interface MyFetchCommands {
  fetch(): Promise<unknown>;
  abort(): void;
}
```

The `Inputs` interface's keys MUST be a subset of `wcBindable.inputs[].name`. The `Commands` interface's keys MUST be a subset of `wcBindable.commands[].name`, and each method's signature should match the underlying instance method. Remote-aware tooling can compose these into a typed surface (`MyFetchValues & RemoteCallable<MyFetchInputs, MyFetchCommands>`) without re-deriving anything.

This three-interface pattern (`Values` / `Inputs` / `Commands`) is the recommended shape for any component whose interface is non-trivial. Components that only expose `properties` can stick to `Values` alone.

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
| Compile-time | `export interface ...Values` (+ optional `...Inputs`, `...Commands`) | Type-safe access to bound values, input setters, and command callers |

The type declarations are **recommendations**, not requirements. Components without type exports still work — consumers simply receive `unknown` values. The `import type` syntax ensures type declarations have zero runtime cost.

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
