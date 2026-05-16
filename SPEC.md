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
      { name: "error",   event: "my-fetch:error-changed" },
      { name: "status",  event: "my-fetch:status-changed" },
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

The four properties above match the `MyFetchValues` interface used later in § Adapter Usage and the README's "exposes value, loading, error, and status" description — `properties[]` MUST enumerate every observable output that consumers will receive via `bind()` `onUpdate` and read from the corresponding `Values` interface.

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

Within a single `properties` array, every `name` MUST be unique. A declaration that violates this rule is **invalid**: adapters MUST treat such a target as non-bindable. Per § Discovery API, `getWcBindableDeclaration()` MUST return `undefined` and `isWcBindable()` MUST return `false` for this case — the two helpers and `bind()` agree by construction. Adapters MAY additionally warn or throw in development mode. Multiple property descriptors MAY share the same `event` name — adapters dispatch each one independently. The same `name` MAY appear in both `properties` (as an observable output) and `inputs` (as a settable input); this is a common pattern for two-way-bindable values (e.g. `value`).

An empty `properties: []` is **valid**: it describes a target that exposes no observable outputs (e.g. a command-only headless service whose surface is entirely in `commands`). `bind()` on such a target installs no listeners, performs no initial sync, and returns a no-op cleanup — this is a successful bind, not a non-bindable rejection.

Adapters **MUST** ignore unknown fields on a property descriptor.

### Input Descriptor

| Field       | Type     | Required | Description                                          |
|-------------|----------|----------|------------------------------------------------------|
| `name`      | `string` | ✅       | The settable property name on the target             |
| `attribute` | `string` | ❌       | Declarative hint, see [SPEC-extensions.md](SPEC-extensions.md). Not interpreted by core. |

Within `inputs`, every `name` MUST be unique. Duplicate names make the declaration **invalid** under the same rule given for properties above (`getWcBindableDeclaration()` MUST return `undefined`; `isWcBindable()` MUST return `false`). Adapters **MUST** ignore unknown fields on an input descriptor.

### Command Descriptor

| Field   | Type      | Required | Description                                            |
|---------|-----------|----------|--------------------------------------------------------|
| `name`  | `string`  | ✅       | The method name on the target                          |
| `async` | `boolean` | ❌       | Declarative hint, see [SPEC-extensions.md](SPEC-extensions.md). Not interpreted by core. |

Within `commands`, every `name` MUST be unique. Duplicate names make the declaration **invalid** under the same rule given for properties above (`getWcBindableDeclaration()` MUST return `undefined`; `isWcBindable()` MUST return `false`). Adapters **MUST** ignore unknown fields on a command descriptor.

---

## Discovery Contract

Protocol detection (`isWcBindable(target)`) and binding (`bind(target, ...)`) both reach for the declaration via `target.constructor.wcBindable`. This is the **sole** discovery path defined by the protocol — there is no global registry, no symbol property, no fallback lookup.

Any object an adapter is asked to bind against MUST therefore expose a `constructor` whose `wcBindable` property satisfies the [Schema](#schema):

- A plain class that defines `static wcBindable = { ... }` satisfies this automatically — JavaScript's `instance.constructor` already references the class object.
- A **wrapper or proxy** that stands in for a real `EventTarget` (for example, a `Proxy`-wrapped object whose `get`/`set` traps route to a remote Core, or a test double) MUST expose an `equivalent` `constructor.wcBindable` declaration — where "equivalent" means **observation-equivalent at the wrapper**, NOT byte-equal to the wrapped target's declaration. Specifically:

  - The declaration the consumer reads via `target.constructor.wcBindable` MUST describe what the wrapper **actually** dispatches and exposes, not what the wrapped target dispatches and exposes. In particular, wrappers MAY (and often MUST) rewrite `event` names internally — the `@wc-bindable/remote` `RemoteCoreProxy` uses synthetic per-property event names like `@wc-bindable/remote:value` to disambiguate properties that shared a Core-side event. The wire layer translates between the two name spaces; the consumer sees only the wrapper's space.
  - Required equivalences: same `protocol`; same `version` integer as the wrapped target (the [Versioning](#versioning) policy guarantees every adapter accepts every `version >= 1`, so wrappers do not need a version-matching step); same set of `name`s in `properties`; observable `getter` semantics at the wrapper that yield the same values a local consumer would have observed (in the remote case the wrapper omits `getter` entirely — see [SPEC-extensions.md § Extension 2](SPEC-extensions.md)); and — when [SPEC-extensions.md § Extension 1](SPEC-extensions.md) is in use — the same `inputs` and `commands` membership as the wrapped target.
- Implementations that wrap one declaration per instance (i.e. multiple wrapped targets coexisting on the same page) MUST give each instance an **isolated** `constructor.wcBindable` — sharing a single constructor across instances with different declarations would break `isWcBindable()` and `bind()` for every instance after the first declaration write. The typical pattern is to synthesize a unique subclass per wrapped target.

Adapters MUST NOT cache the declaration across binds — re-read `target.constructor.wcBindable` on each `bind()` call so that proxies whose declaration changes on reconnect are observed correctly.

### Discovery API

Implementations **MUST** expose two discovery primitives whose contracts are observable by consumers:

| Function | Returns | Contract |
|---|---|---|
| `getWcBindableDeclaration(target)` | `WcBindableDeclaration \| undefined` | Resolves the declaration via the rule above and **fully validates** it. Returns `undefined` if any of the following hold: `target` does not satisfy the minimum EventTarget capability (`typeof target.addEventListener !== "function"` or `typeof target.removeEventListener !== "function"`); `target.constructor.wcBindable` is missing; `protocol !== "wc-bindable"`; `version` is not an integer `>= 1`; `properties` is not an array; any property descriptor is missing a non-empty string `name` or `event`, or has a non-function `getter`; any input or command descriptor is missing a non-empty string `name`; any `name` is duplicated within `properties`, within `inputs`, or within `commands`. MUST NOT throw. MUST NOT consult any source other than `target.constructor.wcBindable` (and the EventTarget-capability test on `target` itself). |
| `isWcBindable(target)` | `boolean` | A type guard that is exactly equivalent to `getWcBindableDeclaration(target) !== undefined`. Implementations MAY (and SHOULD) implement it as that one-line forward. |

**Discovery is bindability — for `bind()` from `@wc-bindable/core`.** Because `getWcBindableDeclaration()` performs the complete schema validation (including the duplicate-name rule that invalidates a declaration per § Property Descriptor / § Input Descriptor / § Command Descriptor), no declaration that survives this filter can silently no-op inside `bind()`. Consumers can therefore use `isWcBindable()` as the single decision point for "will `bind()` install listeners?". (For why the discovery and bindability checks are unified rather than split, see [§ Appendix: Design rationale notes](#appendix-design-rationale-notes).)

> **Scope.** This equivalence is normative for the core `bind()` only. Extensions MAY impose **additional** rejection conditions that core does not check — for example, [SPEC-extensions.md § Extension 2](SPEC-extensions.md) rejects declarations whose `properties` / `inputs` / `commands` names collide with reserved wire names at proxy-construction time. `isWcBindable(target) === true` therefore guarantees `bind()` will succeed but does NOT guarantee that constructing a remote proxy (or any other extension consumer) will succeed; extension-level checks are layered on top, and an extension that rejects a target SHOULD throw at construction with a clear error rather than silently fall back.

The two functions are kept paired so that callers who need the declaration object (tooling, codegen, devtools, test inspection) read it once instead of probing for existence and then re-reading. Adapters that perform their own discovery MUST surface the same `boolean`-vs-declaration pair to be considered conforming. Naming is normative — third-party implementations of these helpers MUST use the same identifiers so consumers can swap implementations.

> **Why identifier naming is normative.** This protocol's pitch is "zero dependencies, just `static` fields + `CustomEvent`", and mandating helper names is admittedly more API surface than that pitch implies. The justification: the data shape on `target.constructor.wcBindable` alone is not enough to make an `@wc-bindable/core` consumer and a third-party reimplementation (Deno port, web-component-devtools-style runtime inspector, a forked monorepo) drop-in compatible. If one names the helper `getDeclaration()` and another `readWcBindable()`, every adapter and tool downstream has to dual-import or rename. Pinning the two function names — and *only* the two function names — keeps the runtime contract honest (still just static field + events) while letting consumers swap implementations at the import boundary. The constraint is intentionally narrow: no other identifier in this spec is normatively named.

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

### Normative TypeScript surface

The protocol-level public types and function signatures are:

```typescript
// ── Declaration shape (the value on `Target.constructor.wcBindable`) ──

interface WcBindableDeclaration {
  protocol: "wc-bindable";
  /** Integer >= 1. See SPEC.md § Versioning. */
  version: number;
  properties: WcBindablePropertyDescriptor[];
  inputs?: WcBindableInputDescriptor[];
  commands?: WcBindableCommandDescriptor[];
}

interface WcBindablePropertyDescriptor {
  name: string;
  event: string;
  /** Defaults to `(e) => (e as CustomEvent).detail` when omitted. */
  getter?: (event: Event) => unknown;
}

interface WcBindableInputDescriptor {
  name: string;
  /** Hint consumed by extensions (see SPEC-extensions.md); not interpreted by core. */
  attribute?: string;
}

interface WcBindableCommandDescriptor {
  name: string;
  /** Hint consumed by extensions (see SPEC-extensions.md); not interpreted by core. */
  async?: boolean;
}

/** A target that survives `isWcBindable()` — i.e. an EventTarget that exposes
 *  a valid declaration on its constructor. */
type WcBindableTarget = EventTarget & {
  readonly constructor: { readonly wcBindable: WcBindableDeclaration };
};

// ── bind() and discovery ──

type OnUpdate = (name: string, value: unknown) => void;
type UnbindFn = () => void;

interface BindOptions {
  syncOn?: "call" | "connect";  // default: "call"
}

/** Discovery primitives. Both MUST accept `unknown` and never throw — see
 *  § Discovery API for the full contract. `target` is typed `unknown`
 *  (not `EventTarget`) precisely because the helper handles non-EventTarget
 *  inputs (returning `undefined`) as part of its validation surface. */
function getWcBindableDeclaration(target: unknown): WcBindableDeclaration | undefined;
function isWcBindable(target: unknown): target is WcBindableTarget;

/** Binding. The narrowed `WcBindableTarget` is what survives discovery; the
 *  `EventTarget` parameter accepts any input and `bind()` internally calls
 *  `getWcBindableDeclaration()` to discriminate. */
function bind(
  target: EventTarget,
  onUpdate: OnUpdate,
  options?: BindOptions,
): UnbindFn;
```

Third-party adapters that re-export `bind()` MUST preserve this signature, including the optional third argument. Higher-level binder layers (framework adapters that wrap `bind()` to drive React state, Vue refs, Angular outputs, etc.) MAY re-pack the callback into a framework-idiomatic shape — for example, the Angular adapter dispatches a single-argument `{ name, value }` event on a Subject because Angular outputs are single-argument. Re-packing at the framework layer is permitted; **changing the positional signature of the protocol-level `bind()` callback is not.** Additional optional fields on `BindOptions` MAY be added in later spec revisions; older implementations MUST ignore unrecognized fields rather than throw.

The discovery primitives' parameter type is `unknown` deliberately: both `getWcBindableDeclaration` and `isWcBindable` are required to accept any input (a stray `null`, a plain object, a `Map` — anything callers might pass while probing for support) and return cleanly without throwing. Implementations that type the parameter more narrowly than `unknown` are non-conformant.

```javascript
const DEFAULT_GETTER = (e) => e.detail;
const MIN_COMPATIBLE_VERSION = 1;

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

// Discovery — full schema validation, including descriptor shape and
// name-uniqueness within properties / inputs / commands. MUST NOT throw
// (target without a constructor, target with a constructor whose
// `wcBindable` getter throws, target that is `null`-prototype-like —
// return undefined). This is the single source of truth for "is this
// target safe to bind to" (see § Discovery API).
//
// Implementation note: optional chaining (not a `typeof` gate) accepts
// both function-typed class constructors and object-typed constructors.
// See § Appendix: Design rationale notes for why.
function getWcBindableDeclaration(target) {
  // Minimum capability check: target MUST be an EventTarget. A target that
  // ships a valid declaration but lacks add/removeEventListener would
  // throw inside bind() later — reject it here so isWcBindable() and
  // bind() agree by construction.
  if (typeof target?.addEventListener !== "function") return undefined;
  if (typeof target?.removeEventListener !== "function") return undefined;
  let decl;
  try {
    decl = target?.constructor?.wcBindable;
  } catch {
    return undefined;
  }
  if (decl?.protocol !== "wc-bindable") return undefined;
  if (!Number.isInteger(decl.version) || decl.version < MIN_COMPATIBLE_VERSION) return undefined;
  if (!isValidNamedList(decl.properties, isValidPropertyDescriptor)) return undefined;
  if (decl.inputs !== undefined && !isValidNamedList(decl.inputs, isValidInputDescriptor)) return undefined;
  if (decl.commands !== undefined && !isValidNamedList(decl.commands, isValidCommandDescriptor)) return undefined;
  return decl;
}

function isWcBindable(target) {
  return getWcBindableDeclaration(target) !== undefined;
}

function isValidNamedList(list, isValidEntry) {
  if (!Array.isArray(list)) return false;
  const seen = new Set();
  for (const entry of list) {
    if (!isValidEntry(entry) || seen.has(entry.name)) return false;
    seen.add(entry.name);
  }
  return true;
}
function isValidPropertyDescriptor(p) {
  return p && typeof p === "object"
    && typeof p.name === "string" && p.name.length > 0
    && typeof p.event === "string" && p.event.length > 0
    && (p.getter === undefined || typeof p.getter === "function");
}
function isValidInputDescriptor(p)   { return p && typeof p === "object" && typeof p.name === "string" && p.name.length > 0; }
function isValidCommandDescriptor(p) { return p && typeof p === "object" && typeof p.name === "string" && p.name.length > 0; }

function bind(target, onUpdate, options) {
  // Discovery == bindability: a declaration that survives this check is
  // safe to bind. The version check above is permissive (every integer
  // >= 1) per § Versioning; no adapter-specific upper bound exists.
  const decl = getWcBindableDeclaration(target);
  if (decl === undefined) return () => {};

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

  // Wrapper: if initialSync (or `onUpdate` called from it) throws, the
  // listeners installed above must NOT leak — tear them down and rethrow.
  // See § Teardown Contract.
  const runOrCleanup = (fn) => {
    try { fn(); } catch (err) {
      cleanups.forEach((c) => { try { c(); } catch {} });
      throw err;
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
      if (target.isConnected) { observer.disconnect(); runOrCleanup(initialSync); }
    });
    observer.observe(documentRef, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  } else {
    runOrCleanup(initialSync);
  }

  return () => cleanups.forEach((fn) => fn());
}
```

### Teardown Contract

`bind()` **MUST** return a function that, when called, removes every event listener (and any other resource — e.g. `MutationObserver`) the adapter installed during the call. This applies whether or not the target was actually bindable: a no-op cleanup function (`() => {}`) is the correct return value for non-`wc-bindable` targets.

**If the synchronous initial-sync step throws** — for example, a property's `in` trap throws, a property getter throws on read, or the consumer's `onUpdate` callback throws — the adapter **MUST** tear down every listener and observer it installed earlier in the same `bind()` call before letting the error propagate. Without this, the caller never receives the unbind function and the listener set leaks. Cleanup callbacks that themselves throw during this fallback path SHOULD be swallowed; surfacing a cleanup-time secondary error in place of the original `initialSync` error is more confusing than useful.

**If a *deferred* initial-sync (`syncOn: "connect"`) throws** the same cleanup runs — but the error has no synchronous caller to propagate to. The throw originates inside a `MutationObserver` callback (a microtask), so the runtime treats it as an uncaught error: browsers surface it via `window.onerror` / `reportError`, Node surfaces it via `process.on('uncaughtException')`, etc. The unbind function the caller already received remains valid but becomes a no-op since every cleanup it would have called has already run. Adapters SHOULD treat deferred-throw cleanup as a best-effort safety net — consumers who need structured error handling from initial-sync should use `syncOn: "call"` from inside their own lifecycle hook so that the throw lands on a frame they can catch.

**If `onUpdate` throws on a post-initial-sync event** — i.e. after `bind()` has returned and a normal change event fires the registered listener — the error propagates out of the event listener via the standard DOM dispatch path (i.e. it becomes an unhandled error on the dispatching event-loop turn). The listener remains attached; the adapter does NOT auto-unbind on consumer throws, and subsequent events continue to fire normally. Consumers that want fail-fast teardown on their own throws are responsible for calling the returned unbind from a catch in their `onUpdate`.

Long-lived headless `Core` instances may outlive multiple consumers; without an explicit teardown contract, listener leaks are guaranteed. Component-side `disconnectedCallback` cannot be relied on because headless Cores have no DOM lifecycle, and Web Components bound via framework refs may be reattached.

### Initial Value Synchronization

Initial value synchronization is a **required** part of the protocol (not merely an adapter implementation suggestion). For each declared property at bind time:

- If `prop.name in target` is `true`, the adapter **MUST** read `target[prop.name]` and deliver the value (including when it is `undefined`) to the consumer.
- If `prop.name in target` is `false` (the property does not exist on the target), the adapter **MUST** skip the initial synchronization for that property. This is not an error.

The `in` operator is mandated specifically so that `undefined` can be distinguished from "property not declared on target". (For why, see [§ Appendix: Design rationale notes](#appendix-design-rationale-notes).)

Component authors **should** ensure that every `name` in the declaration corresponds to a readable property on the target instance.

#### Ordering vs subsequent events

The relative ordering of the initial-sync delivery and the first subsequent `onUpdate` triggered by an event depends on `syncOn`:

- With `syncOn: "call"` (the default), the adapter **MUST** attach event listeners and perform the initial-sync read within the same synchronous frame of `bind()`. As a consequence, no event the adapter itself observes can fire on the target *between* the listener attach and the initial-sync delivery — the in-frame ordering is the adapter's enforceable guarantee. Once the initial sync has been delivered and `bind()` has returned, subsequent events follow normal listener-delivery order. The only way an event can interleave the initial sync at all is if `onUpdate` synchronously re-enters the target via `dispatchEvent` while the initial-sync loop is running; the adapter cannot prevent this re-entry, and component / consumer authors SHOULD NOT do it. The event-payload-authoritative rule (see [§ Event detail vs Property Read](#event-detail-vs-property-read)) covers any resulting ordering anomaly.
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
>
> **Connect-then-disconnect race.** `MutationObserver` callbacks are delivered as microtasks, not synchronously. If the host appends the target and then synchronously detaches it again within the same task — for example, a transient mount inside a virtual-DOM diff — the observer callback runs after both mutations and observes `target.isConnected === false`. The reference implementation rechecks `isConnected` inside the callback, so it does NOT fire the initial sync in this case and the observer remains armed; a later re-attach will re-fire the observer and complete the sync. If the target is never re-attached, the observer is held alive until `unbind()` is called and never delivers the initial sync. This is an intentional consequence of "deferred until first real connection" — adapters that need a tighter binding to host lifecycle MUST use `syncOn: "call"` from their own lifecycle hook instead.

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

## Appendix: Design rationale notes

These notes record the *why* behind a few decisions that earlier spec drafts surfaced inline. They are non-normative — the normative rules are stated where they belong in the main body — but third-party implementers may find them useful when judging an edge case the normative text does not directly address.

**Why `getWcBindableDeclaration()` performs full validation (Discovery = bindability).**
A pre-v0.7.1 draft of this spec validated only `protocol` / `version` / `properties` at discovery time and pushed name-uniqueness and descriptor-shape checks into `bind()`. The split caused `isWcBindable(target) === true` while `bind(target, ...)` silently returned a no-op cleanup — a footgun for any consumer that gated on `isWcBindable`. Moving the full schema check into the discovery helper makes the two functions agree by construction and removes the silent-no-op path.

**Why the `in` operator gates initial sync (instead of `!== undefined`).**
A pre-v0.7.0 draft used `if (target[prop.name] !== undefined)` as the initial-sync gate. That gate cannot deliver a property whose current value is legitimately `undefined`, conflating "the value is undefined" with "the property is not exposed on the target". The `in`-operator gate distinguishes the two and lets components declare an initial-`undefined` state without losing the first delivery; the consequence (an extra `onUpdate(name, undefined)` for properties whose value is `undefined`) is accepted as the correct behavior.

**Why the reference pseudocode uses optional chaining (not a `typeof` gate) on `target.constructor`.**
A class declaration in JavaScript is a function (`typeof MyClass === "function"`), not an object. A pre-v0.7.1 draft of the pseudocode gated on `typeof ctor === "object"` and silently failed to discover any class-based component — the single most common shape in the wild. Optional chaining inside a `try / catch` accepts both function-typed (class) and object-typed constructors and satisfies the "MUST NOT throw" rule even when `target` is a null-prototype-like object.

**Why `MIN_COMPATIBLE_VERSION` is pinned to `1` (and adapter-specific bounds are forbidden).**
The forward-compatibility policy — "breaking changes get a new `protocol` identifier, not a version bump" — implies symmetric compatibility within a given `protocol` identifier. A future v2 adapter that gated on `decl.version >= 2` would silently no-op against valid v1 declarations, producing exactly the regression the policy was meant to prevent. Pinning the constant to `1` and naming it `MIN_COMPATIBLE_VERSION` (a minimum, not a maximum) reflects this and makes the bound obviously protocol-wide rather than adapter-specific.

---

## License

MIT
