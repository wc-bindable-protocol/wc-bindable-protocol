# wc-bindable-protocol Specification

**Protocol:** `wc-bindable`  
**Version:** 1  

> **Authoritative scope of this document.** SPEC.md is the **authoritative source for the core protocol contract** — the `static wcBindable` declaration schema, the `bind()` / `getWcBindableDeclaration()` / `isWcBindable()` runtime surface, initial-sync semantics, the teardown contract, the conformance levels, and the versioning policy. Behavioral extensions (input/command invocation, the remote wire format) live in [SPEC-extensions.md](SPEC-extensions.md); runnable test vectors live in [CONFORMANCE.md](CONFORMANCE.md); narrative overview and quick-start live in [README.md](README.md). Where any of those disagree with a core rule below, this document is authoritative.

## Requirements language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY**, **REQUIRED**, **RECOMMENDED**, and **OPTIONAL** in this document and its extensions ([SPEC-extensions.md](SPEC-extensions.md)) are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) — [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) — when, and only when, they appear in all capitals. Lowercase uses of these words ("a target must be …") carry their natural-English meaning and are non-normative.

---

## Overview

`wc-bindable-protocol` is a minimal, framework-agnostic protocol. A **producer target** — typically a class that extends `EventTarget` (e.g. an `HTMLElement` subclass) — declares its reactive properties, and any reactivity system (React, Vue, Svelte, etc.) can `bind()` to it as a **consumer-side bind target** without framework-specific coupling. Optionally, components can also declare their input properties and commands, providing a complete interface description that enables tooling, documentation generation, and remote proxying.

The capability requirement is **role-specific**, and the two roles MUST be kept distinct in any conformance discussion:

| Role | Required methods | Required to satisfy |
|---|---|---|
| **Producer target** (emits change events; the thing a component author writes) | `addEventListener`, `removeEventListener`, `dispatchEvent` | Full EventTarget contract |
| **Consumer-side bind target** (anything passed to `bind()` — the producer, OR a remote proxy / test double / relay wrapper) | `addEventListener`, `removeEventListener` | Subset — `dispatchEvent` is NOT required |

A producer is always also a valid consumer-side bind target (it has both), but a consumer-side bind target is NOT required to be a producer. A relay wrapper that re-emits events through its own internal channel without exposing `dispatchEvent` is a valid bind target as long as listeners receive the events.

`getWcBindableDeclaration()` enforces the **consumer-side** bindability check (presence of `addEventListener` / `removeEventListener` only) — see [§ Discovery API](#discovery-api). The producer-side `dispatchEvent` requirement is a contract on the component author, not something the discovery helper can verify from the consumer side.

`HTMLElement` (a subclass of `EventTarget`) is the most common implementation target, as it enables DOM integration and framework binding via refs, but it is not required. This means the protocol works equally well in non-browser runtimes (Node.js, Deno, Cloudflare Workers, etc.) where `EventTarget` is available.

The protocol requires no library dependencies and relies solely on standard platform APIs: `static` class fields for the declaration, `addEventListener` / `removeEventListener` on the consumer-side bind target, and `dispatchEvent` + `CustomEvent` on the producer side. All of these are part of the JavaScript / DOM / Web Components core; no `npm` runtime dependency is introduced.

---

## Goals

- Allow any producer target (an `EventTarget` subclass or a structural duck-type with `addEventListener` / `removeEventListener` / `dispatchEvent`) to declare bindable properties once
- Allow any consumer-side bind target (anything with `addEventListener` / `removeEventListener`, including relay proxies that omit `dispatchEvent`) to be passed to `bind()`
- Optionally allow declaration of input properties and commands for a complete interface description
- Allow any reactivity system to consume those declarations without prior knowledge of the component
- Remain zero-dependency and runtime-only
- Be simple enough that a **conceptual local observer** — discovery + `bind()` returning a cleanup — can be demonstrated in tens of lines of code, while making clear that **Level 2 (Core JS API compatibility) requires the full validation and teardown contract** and is therefore not a tens-of-lines implementation. The conceptual demo and the conformant implementation are two different artifacts: the former exists to communicate the shape of the protocol in a single screenful, the latter is what framework adapters import as `bind` from `@wc-bindable/core` and what § Conformance Levels actually gates on.
- Define the stricter edge-case rules (full descriptor validation, exception-safe teardown, partial-delivery semantics, deferred-sync ordering, shadow-DOM limitations) that a **production-grade adapter** needs separately, so the small-impl pitch and the production contract do not have to be the same artifact

---

## Protocol Model and Assumptions

This section names the load-bearing model choices the rest of the spec depends on. Every later rule presupposes them, so re-stating them once in one place makes the chain of derivations explicit and lets readers locate the right normative section quickly.

### Interface model — three distinct surfaces

A `wcBindable` declaration models a component interface as **three independent surfaces**:

| Surface | Field | Layer that interprets it |
|---|---|---|
| Observable outputs | `properties` | **Core** — consumed by `bind()` via event listeners + initial-sync read |
| Declared inputs | `inputs` | **Core does not interpret** — purely metadata for tooling, codegen, devtools; behavior (the actual `set` / `setWithAck` semantics) lives in [SPEC-extensions.md § Extension 1](SPEC-extensions.md#extension-1--inputcommand-invocation) |
| Declared commands | `commands` | **Core does not interpret** — purely metadata; behavior (the `invoke` semantics) lives in [SPEC-extensions.md § Extension 1](SPEC-extensions.md#extension-1--inputcommand-invocation) |

The separation lets the core protocol stay narrow (observation only) while extensions add invocation semantics on top. Core still schema-validates every surface (an invalid `inputs` / `commands` descriptor invalidates the whole declaration — see [§ Discovery API](#discovery-api)) so downstream consumers of those surfaces can trust the shape of what `getWcBindableDeclaration()` returns.

### Role model — Producer target vs Consumer-side bind target

The two roles introduced in § Overview are the central model split: a **producer target** dispatches events; a **consumer-side bind target** observes them. They share the `add` / `removeEventListener` surface but a consumer-side target is NOT required to expose `dispatchEvent`. A relay wrapper, remote proxy, or test double that re-emits events through an internal channel is a valid bind target even when it deliberately hides `dispatchEvent`. This is why `bind()` works transparently against `RemoteCoreProxy` despite the proxy not being a literal event source.

### Trust model — the declaration is executable, not inert metadata

A `wcBindable` declaration **MAY contain executable functions** (the optional `getter` field) and **discovery itself performs JavaScript property access** on the target. The core protocol therefore assumes the target is trusted code the consumer intentionally loaded. Concretely:

- A custom `getter` runs in the consumer's JS context on every dispatched event. Loading a component from an untrusted source loads a function that will run with consumer-context privileges.
- Even reading `target.constructor.wcBindable` to discover a declaration goes through JS property access, so a hostile target's `Proxy` traps or accessor side effects fire during discovery.
- The discovery helper's MUST-NOT-throw guard is a safety net against accidental hostility (e.g. a relay whose `constructor` is a `Proxy` that raises) — it is NOT a sandbox. See [§ Trust Boundaries](#trust-boundaries) for the full treatment.

A declaration is therefore best thought of as **executable component interface metadata**, not as a JSON schema. Threat models that allow "just serialized metadata" but disallow "third-party code" MUST treat declarations as the latter.

### Value model — local JS values vs remote `JsonValue`

The core protocol's value model is "any JavaScript value" — initial sync reads `target[prop.name]` as-is, and event update reads `getter(event)` as-is. Local consumers see whatever the producer chose to expose: `Date`, `Map`, class instances, functions, cyclic graphs, anything.

The **remote** profile ([SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying)) narrows **ordinary wire payloads** to **`JsonValue`** at every wire crossing — a JSON-shape recursive type that excludes non-finite numbers, `Date`, `Map`, `Set`, `BigInt`, typed arrays, class instances, functions, symbols, and cyclic references. The narrowing is a discontinuity, not a coincidence: components designed for local use that surface non-`JsonValue` shapes MUST add an explicit serialization boundary before they can be exposed through Layer 3. The remote layer also runs `getter` functions on the producer side only — only the extracted value crosses the wire, never the function.

> **`undefined` carve-out.** `JsonValue` itself cannot contain `undefined`, so `undefined` *nested inside* an object property, array element, command argument, or return value is non-`JsonValue` and is rejected by Layer 3 validation, identical to the other excluded shapes above. But a **top-level observable property whose current value is `undefined`** is a first-class wire concept: the `sync` envelope carries it in the `undefinedProperties` list (when the producer advertises that capability), and a subsequent `update` envelope expresses a transition to `undefined` via an *absent* `value` field. The protocol deliberately preserves the "this property is currently `undefined`" signal across the wire — what it does not allow is `undefined` as a value buried inside a larger JSON shape. See [SPEC-extensions.md § Undefined enumeration](SPEC-extensions.md#undefined-enumeration) for the out-of-band protocol, [SPEC-extensions.md § Update envelope value field](SPEC-extensions.md#update-envelope-value-field) for the per-update rule, and the same nuance restated in the [README.md Layer 3 callout](README.md#the-protocol-in-three-layers).

### Discovery model — single-path, validation gate, not a normalized snapshot

Discovery resolves the declaration through a **single path** — `target.constructor.wcBindable`. There is no global registry, no symbol fallback, and **no per-instance `target.wcBindable` override** that would shadow the constructor-side declaration on individual instances. Wrappers that genuinely need per-instance declarations (the remote `RemoteCoreProxy` is the canonical example, since each proxied target has its own declaration including synthetic per-property event names) implement this by **exposing an isolated constructor whose `constructor.wcBindable` describes that one instance** — typically a synthesized unique subclass per wrapped target. That pattern is fully conformant; the rule is just that discovery only ever reads `target.constructor.wcBindable`, not a parallel `target.wcBindable` slot, so any per-instance customization MUST be carried on the constructor side.

`getWcBindableDeclaration()` is a **validation gate**: it returns either the live declaration object (if every Schema-typed field is well-formed) or `undefined` (otherwise), without throwing on any access failure. It is NOT a normalizer — it does NOT freeze, clone, or otherwise hand `bind()` an immutable snapshot. Both discovery and `bind()` re-read the underlying descriptors when they need them, which is acceptable under the trust model above (hostile accessors that return different values on successive reads are out of scope) and keeps the helper lightweight. See [§ Discovery API](#discovery-api) and [§ Trust Boundaries](#trust-boundaries) for the formal contract and the explicit non-extension of snapshotting across the validator → `bind()` pipeline.

### Failure model summary

The protocol's failure-handling choices are spread across sections; they share a single model:

- **Discovery never throws** — invalid input ⇒ `undefined` return; hostile access ⇒ `undefined` return (caught internally).
- **`bind()` is exception-safe on install** — any throw during listener installation, initial sync, or observer setup MUST tear down whatever the same `bind()` call already installed before propagating the error. See [§ Teardown Contract](#teardown-contract).
- **Cleanup is best-effort, not error-reporting** — a cleanup callback that throws does NOT abort the remaining cleanups, and the secondary error is swallowed.
- **`onUpdate` errors after initial sync propagate via the standard event-dispatch path** — the adapter does NOT auto-unbind on consumer throws.
- **Remote `set` is fire-and-forget, `setWithAck` is acknowledged delivery of the *assignment*** (not of state stability or async side-effect completion — see [SPEC-extensions.md § Methods](SPEC-extensions.md#methods)).

The chain "discovery never throws → `bind()` is exception-safe on install → cleanup is best-effort" is what lets consumers call `bind()` on stray inputs without crashing the host, while still preserving normal error reporting for real producer-side bugs.

---

## Protocol Declaration

A producer target — **typically a class that extends `EventTarget`** (e.g. an `HTMLElement` subclass) — declares its bindable properties by defining a `static wcBindable` field on the class. A structural EventTarget-compatible object MAY also participate as long as it exposes the required `addEventListener` / `removeEventListener` / `dispatchEvent` methods and the same `constructor.wcBindable` discovery path; subclassing `EventTarget` is the recommended pattern but is not strictly required (see [§ Overview](#overview) for the consumer-vs-producer capability split).

### Headless (EventTarget only)

> **Terminology note.** "Headless" in this spec means **no DOM at all** — a plain `EventTarget` subclass that runs in Node, Deno, Workers, or any other non-browser runtime. Distinct from the related but different concept in the README's "Web Components as invisible service layers" section, which describes DOM-mounted Web Components with no visual surface (e.g. an `<my-fetch>` element that exists in the DOM but renders nothing). Both patterns benefit from the protocol; they differ on whether the target is in the document tree at all.

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

The `inputs` and `commands` fields are optional. When present, they declare the component's input interface — settable properties and callable methods — enabling tooling, documentation generation, and remote proxying. They do **not** create any implicit data flow; the consumer is responsible for explicitly setting properties and invoking methods. The semantics for *how* a consumer sets inputs and invokes commands (delivery guarantees, error handling, the role of `attribute` / `async`) are described in [SPEC-extensions.md § Extension 1](SPEC-extensions.md#extension-1--inputcommand-invocation) — the core protocol itself does not interpret these fields.

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

  // Initial-sync parity requirement — see § Appendix: Design rationale notes
  // → "Why a custom getter is NOT applied during initial sync". The custom
  // `getter` above extracts `e.detail.checked` from the event, but initial
  // sync reads `target.checked` directly (no Event to feed the getter), so
  // the component MUST expose `checked` as a property returning the same
  // shape the getter would extract. Without this exposure the initial-sync
  // value and the post-change value disagree on every bind.
  get checked() { return this._checked; }
  set checked(v) {
    this._checked = v;
    this.dispatchEvent(
      new CustomEvent("my-input:checked-changed", { detail: { checked: v } }),
    );
  }
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

> **`version` is NOT a compatibility upper bound.** A reader seeing `version: 2` on a declaration MAY reasonably assume a v1 adapter will reject it — that is a SemVer-shaped intuition, not the wc-bindable contract. Every adapter under the `"wc-bindable"` protocol identifier MUST accept **every integer `version >= 1`**, regardless of when the adapter was built. The `version` field exists to flag the presence of newer optional fields (which adapters MUST ignore if unrecognized), NOT to gate acceptance. Breaking changes to the binding contract live in a **new `protocol` identifier**, never in a version bump — see [§ Versioning](#versioning) for the full rule and the rationale.

When `inputs` or `commands` is absent (`undefined`), consumers **MUST** treat it as an empty array (`[]`) — semantically equivalent to declaring "no inputs" / "no commands". An absent field and an explicit `[]` MUST behave identically for every consumer concern (e.g. Extension 1's "name MUST be declared in inputs/commands before a `set` / `invoke` reaches the producer" check rejects every name under both encodings).

### Property Descriptor

| Field    | Type       | Required | Description                                              |
|----------|------------|----------|----------------------------------------------------------|
| `name`   | `string`   | ✅       | The property name on the target                          |
| `event`  | `string`   | ✅       | The CustomEvent name dispatched when the property changes |
| `getter` | `function` | ❌       | Extracts the new value from the event. Defaults to `e => e.detail` |

Within a single `properties` array, every `name` MUST be unique. A declaration that violates this rule is **invalid**: adapters MUST treat such a target as non-bindable. Per § Discovery API, `getWcBindableDeclaration()` MUST return `undefined` and `isWcBindable()` MUST return `false` for this case — the two helpers and `bind()` agree by construction. Adapters MAY additionally warn (e.g. `console.warn`) in development mode, and a development-only diagnostic layer **outside** the normative helpers MAY throw after calling them (e.g. a strict-mode wrapper that escalates an `undefined` discovery result into an exception). The normative `getWcBindableDeclaration()` / `isWcBindable()` / Level-2 `bind()` behavior is unchanged in every environment: they MUST NOT throw merely because the declaration is invalid — the "MUST NOT throw" rule in § Discovery API is environment-independent and is not relaxed by development-mode wrappers. Multiple property descriptors MAY share the same `event` name — adapters dispatch each one independently. The same `name` MAY appear in both `properties` (as an observable output) and `inputs` (as a settable input); this is a common pattern for two-way-bindable values (e.g. `value`).

An empty `properties: []` is **valid**: it describes a target that exposes no observable outputs (e.g. a command-only headless service whose surface is entirely in `commands`). `bind()` on such a target installs no listeners, performs no initial sync, and returns a **functionally no-op** cleanup — a normal closure whose internal cleanup list is empty, so invoking it does nothing observable. The literal `() => {}` form is permitted for non-bindable targets (see [§ Teardown Contract](#teardown-contract)) but is not required here; either shape satisfies the contract because the observable behavior is the same.

Adapters **MUST** ignore unknown fields on a property descriptor.

### Input Descriptor

| Field       | Type     | Required | Description                                          |
|-------------|----------|----------|------------------------------------------------------|
| `name`      | `string` | ✅       | The settable property name on the target             |
| `attribute` | `string` | ❌       | Declarative hint, see [SPEC-extensions.md § The `attribute` hint](SPEC-extensions.md#the-attribute-hint). Not interpreted by core. |

Within `inputs`, every `name` MUST be unique. Duplicate names make the declaration **invalid** under the same rule given for properties above (`getWcBindableDeclaration()` MUST return `undefined`; `isWcBindable()` MUST return `false`). Adapters **MUST** ignore unknown fields on an input descriptor.

### Command Descriptor

| Field   | Type      | Required | Description                                            |
|---------|-----------|----------|--------------------------------------------------------|
| `name`  | `string`  | ✅       | The method name on the target                          |
| `async` | `boolean` | ❌       | Declarative hint, see [SPEC-extensions.md § The `async` hint](SPEC-extensions.md#the-async-hint). Not interpreted by core. |

Within `commands`, every `name` MUST be unique. Duplicate names make the declaration **invalid** under the same rule given for properties above (`getWcBindableDeclaration()` MUST return `undefined`; `isWcBindable()` MUST return `false`). Adapters **MUST** ignore unknown fields on a command descriptor.

---

## Discovery Contract

Protocol detection (`isWcBindable(target)`) and binding (`bind(target, ...)`) both reach for the declaration via `target.constructor.wcBindable`. This is the **sole** discovery path defined by the protocol — there is no global registry, no symbol property, no fallback lookup.

Any object an adapter is asked to bind against MUST therefore expose a `constructor` whose `wcBindable` property satisfies the [Schema](#schema):

- A plain class that defines `static wcBindable = { ... }` satisfies this automatically — JavaScript's `instance.constructor` already references the class object.
- A **wrapper or proxy** that stands in for a real `EventTarget` (for example, a `Proxy`-wrapped object whose `get`/`set` traps route to a remote Core, or a test double) MUST expose an `equivalent` `constructor.wcBindable` declaration — where "equivalent" means **observation-equivalent at the wrapper**, NOT byte-equal to the wrapped target's declaration. Specifically:

  - The declaration the consumer reads via `target.constructor.wcBindable` MUST describe what the wrapper **actually** dispatches and exposes, not what the wrapped target dispatches and exposes. In particular, wrappers MAY (and often MUST) rewrite `event` names internally — the `@wc-bindable/remote` `RemoteCoreProxy` uses synthetic per-property event names like `@wc-bindable/remote:value` to disambiguate properties that shared a Core-side event. The wire layer translates between the two name spaces; the consumer sees only the wrapper's space.
  - Required equivalences: same `protocol`; same set of `name`s in `properties`; observable `getter` semantics at the wrapper that yield the same values a local consumer would have observed (in the remote case the wrapper omits `getter` entirely, with one narrow carve-out for sentinel-unwrapping getters used solely to round-trip `undefined` across the `CustomEvent.detail` boundary — see [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying) → Design invariants invariant 2 and [§ CustomEvent `detail` and undefined preservation](SPEC-extensions.md#customevent-detail-and-undefined-preservation)); and — when [SPEC-extensions.md § Extension 1](SPEC-extensions.md#extension-1--inputcommand-invocation) is in use — the same `inputs` and `commands` membership as the wrapped target.
  - **Version reporting.** The wrapper MUST report the same `version` integer that the wrapped target's declaration carries. The wrapper does NOT need to verify or "match" the version against anything before reporting it — the [Versioning](#versioning) policy guarantees every adapter on either side accepts every integer `>= 1`, so wrappers simply propagate the value faithfully. (Reporting fidelity is required; a separate matching/checking step is not.)
- Implementations that wrap one declaration per instance (i.e. multiple wrapped targets coexisting on the same page) MUST give each instance an **isolated** `constructor.wcBindable` — sharing a single constructor across instances with different declarations would break `isWcBindable()` and `bind()` for every instance after the first declaration write. The typical pattern is to synthesize a unique subclass per wrapped target.

Adapters MUST NOT cache the declaration across binds — re-read `target.constructor.wcBindable` on each `bind()` call so that proxies whose declaration changes on reconnect are observed correctly.

### Discovery API

Implementations **MUST** expose two discovery primitives whose contracts are observable by consumers:

| Function | Returns | Contract |
|---|---|---|
| `getWcBindableDeclaration(target)` | `WcBindableDeclaration \| undefined` | Resolves the declaration via the rule above and **fully validates** it. Returns `undefined` if any of the following hold: `target` does not satisfy the minimum EventTarget capability (`typeof target.addEventListener !== "function"` or `typeof target.removeEventListener !== "function"`); `target.constructor.wcBindable` is missing; `protocol !== "wc-bindable"`; `version` is not an integer `>= 1`; `properties` is not an array; any property descriptor is missing a non-empty string `name` or `event`, or has a non-function `getter`; any input or command descriptor is missing a non-empty string `name`, has a non-string `attribute`, or has a non-boolean `async`; any `name` is duplicated within `properties`, within `inputs`, or within `commands`. MUST NOT throw. MUST NOT consult any source other than `target.constructor.wcBindable` (and the EventTarget-capability test on `target` itself). The validation covers every Schema-typed field, including the optional hint fields (`attribute`, `async`) that core does not interpret — type-checking them here keeps the "discovery succeeded ⇒ Schema is well-formed" guarantee honest for extension consumers that DO interpret them. |
| `isWcBindable(target)` | `boolean` | A type guard that is exactly equivalent to `getWcBindableDeclaration(target) !== undefined`. Implementations MAY (and SHOULD) implement it as that one-line forward. |

**Discovery is bindability — for `bind()` from `@wc-bindable/core`.** Because `getWcBindableDeclaration()` performs the complete schema validation (including the duplicate-name rule that invalidates a declaration per § Property Descriptor / § Input Descriptor / § Command Descriptor), a declaration that survives this filter is accepted by `bind()` as valid; whether listeners are installed depends on whether `properties` is non-empty (see § Property Descriptor for the empty-array case). The **malformed-declaration silent fallback to the non-bindable no-op path** that an earlier draft permitted is now impossible: discovery either rejects the target (and `bind()` returns the same non-bindable `() => {}` no-op) or accepts it (and `bind()` installs the declared listeners, or returns a functional no-op cleanup when `properties` is legitimately empty). The two no-op shapes are observationally identical at the cleanup callsite — by design, per § Property Descriptor — but they are produced by structurally different paths (`isWcBindable() === false` vs `=== true` with empty properties), and that distinction is what gates downstream logic. Consumers can therefore use `isWcBindable()` as the single decision point for "will `bind()` accept this target as a valid wc-bindable target and return a valid cleanup?" — **not** as a literal "will listeners be installed?" predicate. An empty `properties: []` is a valid declaration (see § Property Descriptor) describing a command-only target; `isWcBindable()` returns `true` for it and `bind()` accepts it, but no listeners are installed and no initial-sync event is delivered because there is nothing to observe — the cleanup is a functional no-op. The equivalence is between "passes discovery" and "is a valid bindable target", not "passes discovery" and "drives event listeners". This distinction matters for conformance tests that gate on `isWcBindable` and then assert listener-related side effects. (For why the discovery and bindability checks are unified rather than split, see [§ Appendix: Design rationale notes](#appendix-design-rationale-notes).)

The "discovery is bindability" equivalence assumes the target's declaration is **stable for the duration of the bind**: it relies on the fact that the schema `getWcBindableDeclaration()` validated is the same schema `bind()` walks a few statements later. A hostile target whose accessor properties or `Proxy` traps return different values on successive reads can present a valid schema to discovery and an invalid one to `bind()` (or vice versa). This is outside the spec's threat model — see [§ Trust Boundaries](#trust-boundaries) — but third-party implementers writing against the equivalence should know the implicit assumption.

> **Discovery is a validation gate, not a normalized-snapshot factory.** `getWcBindableDeclaration()` returns either the live declaration object as it exists on `target.constructor.wcBindable` (when every Schema-typed field is well-formed) or `undefined` (otherwise). It does NOT freeze, deep-clone, or otherwise hand `bind()` an immutable snapshot — both discovery and `bind()` re-read the underlying descriptors when they need them. This is a deliberate model choice: the protocol's trust model assumes the target is consumer-loaded code, so the cost of normalizing a snapshot (allocation, deep-equality comparison, deciding what "frozen" means for a `getter` function) is paid every `bind()` call without buying anything against the threats the spec actually defends against. A future revision MAY change this if the trust model widens, but the current contract is **live reference + per-read validation**, not snapshot. See the Discovery model bullet in [§ Protocol Model and Assumptions](#protocol-model-and-assumptions) for the model-level statement and [§ Trust Boundaries](#trust-boundaries) for the explicit non-extension of snapshotting across the validator → `bind()` pipeline.

> **Scope.** This equivalence is normative for the core `bind()` only. Extensions MAY impose **additional** rejection conditions that core does not check — for example, [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying) rejects declarations whose `properties` / `inputs` / `commands` names collide with reserved wire names at proxy-construction time. `isWcBindable(target) === true` therefore guarantees `bind()` will succeed but does NOT guarantee that constructing a remote proxy (or any other extension consumer) will succeed; extension-level checks are layered on top, and an extension that rejects a target SHOULD throw at construction with a clear error rather than silently fall back.

The two functions are kept paired so that callers who need the declaration object (tooling, codegen, devtools, test inspection) read it once instead of probing for existence and then re-reading. Adapters that perform their own discovery MUST surface the same `boolean`-vs-declaration pair to be considered conforming. Naming is normative — third-party implementations of these helpers MUST use the same identifiers so consumers can swap implementations.

The identifier names `bind`, `getWcBindableDeclaration`, and `isWcBindable` are normative — but **only at the Core JS API compatibility level** (Level 2 below), not at the protocol level. A non-JS implementation that satisfies the underlying protocol contract is conformant at Level 1 regardless of what it calls its functions; the name pinning is what makes a *JavaScript* third-party reimplementation an import-line drop-in for `@wc-bindable/core`. See § Conformance Levels for the explicit separation.

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

Reactivity system adapters **MUST** implement this default. Component authors **SHOULD** dispatch `CustomEvent` with the new value set directly as `detail`:

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

## Conformance Levels

> **Implementers: see [CONFORMANCE.md](CONFORMANCE.md)** for a starter set of test vectors covering the rules below that are easy to violate in ways that compile and pass naive smoke tests. The file is necessary-but-not-sufficient: passing every vector does not imply full conformance, but failing any indicates a concrete bug this specification calls out in prose.

This specification has three independently claimable conformance levels. An implementation MUST be explicit about which it claims. The levels stack as follows:

- **Level 1 is always implied** by claiming any higher level, but only for the *applicable facet(s)* defined in § Level 1 facets below. A Level 2 or Level 3 claim does NOT automatically require both 1P and 1O; see § Level 1 facets → "Facet implication for higher levels" for the per-level facet rule.
- **Level 2 is implied only when the implementation has JS bindings**, because Level 2's rules — the normatively-named `bind` / `getWcBindableDeclaration` / `isWcBindable` exports — are JavaScript-specific. A non-JS Level-3 implementation (Python, Go, …) is NOT required to satisfy Level 2; a JS Level-3 implementation that also exposes a local-binding surface SHOULD additionally satisfy Level 2 for drop-in compatibility with the JS adapter ecosystem.

**Claim shorthand (with facet annotation).** The level numbers compose with the 1P / 1O facets defined in § Level 1 facets below. The shorthand `{1O, 2}` means "Level 1 observer facet plus Level 2 conformance"; the shorthand never elides the facet because Level 2 / Level 3 each touch a specific facet, not "all of Level 1". Use these claim shapes:

| Claim | Reading |
|---|---|
| `{1O, 2}` | Level 2 conformant observer-side library (e.g. a third-party `bind()` reimplementation that ships no producer helpers). |
| `{1O + 1P, 2}` | Level 2 conformant library that also ships producer helpers (`@wc-bindable/core` itself). |
| `{1P, 3-producer}` | Producer-side remote shell (typical: a non-JS sidecar that emits but does not observe). |
| `{1O, 3-consumer}` | Consumer-side remote proxy without a local-binding facade. |
| `{1O + 1P, 3-both}` | Implementation that ships both Level 3 sides (`@wc-bindable/remote`). |
| `{1O + 1P, 2, 3-both}` | A JS Level-3 implementation that also exposes a local-binding surface; SHOULD additionally satisfy Level 2 for drop-in compatibility. |

A non-JS Level-3 implementation that is producer-only declares `{1P, 3-producer}` and is NOT obligated to satisfy 1O or Level 2 — its sidecar role is to emit, not to observe. The facet-implication rules in § Level 1 facets below are the authoritative source for which facets each level claim requires; this shorthand exists only to give release-notes / package-metadata a compact way to refer to a conformance claim.

| Level | Name | What it covers | What it does NOT cover |
|---|---|---|---|
| **1** | **Protocol conformance** | Has two independently claimable facets — see § Level 1 facets below. | The names exported from the implementation; the wire format. |
| **2** | **Core JS API compatibility** | The applicable Level 1 observer facet (**1O**; see § Level 1 facets), PLUS the three normatively-named exports: **`bind`**, **`getWcBindableDeclaration`**, **`isWcBindable`** (with the TypeScript surface and parameter shapes defined in [§ Normative TypeScript surface](#normative-typescript-surface), plus the runtime rule in [§ onUpdate validity](#onupdate-validity)). If the same implementation also ships producer targets or producer helpers, that producer surface MUST additionally satisfy 1P (see § Level 1 facets → "Facet implication for higher levels"). This is what makes a JavaScript reimplementation an import-line drop-in for `@wc-bindable/core` — every framework adapter does `import { bind } from "@wc-bindable/core"`, and a fork that exported `attach` instead would break every adapter even if it satisfied Level 1. | The remote wire format (Extension 2). |
| **3** | **Remote wire conformance** | The applicable Level 1 facet **by role** — **1O** for a consumer-side remote proxy (the proxy is observed via `bind()` on the consumer) and **1P** for a producer-side remote shell (the shell dispatches change events for the wrapped Core); an implementation that ships both sides MUST satisfy both for the respective sides. See § Level 1 facets → "Facet implication for higher levels" for the role-split rule. PLUS the wire-format invariants in [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying) — message shapes, FIFO / JSON-shape / single-shell invariants, undefined enumeration, declaration fingerprint, transport adapter contract. An implementation that consumes or produces wc-bindable across a network MUST satisfy this. If the implementation also exposes JS bindings to local consumers, those bindings SHOULD additionally satisfy Level 2 for drop-in compatibility with the JS adapter ecosystem. | Application-specific transport choice; back-pressure policy beyond the spec minimums. |

**Type names** (`OnUpdate`, `UnbindFn`, `BindOptions`, `WcBindableDeclaration`, ...) are NOT normatively named at any level — TypeScript users can re-import them under any local alias without breaking interop because the runtime call shape stays the same. **Constants** (`MIN_COMPATIBLE_VERSION`) are likewise not normatively named (per § Versioning); only their values are pinned. Level 2's identifier-name rule is intentionally narrow: only the three runtime entry points whose names cross the import boundary in the wild are pinned.

A non-JavaScript Level-1 implementation (for example, a Python sidecar that owns wc-bindable component instances inside a CPython runtime and exposes change events via a local socket) is a fully valid producer; it does not need to invent or expose anything called `bind`. If that same implementation also speaks the Extension 2 wire format to a JS consumer, it claims Level 1 + Level 3, not Level 2.

#### Level 1 facets

Level 1 has two facets. An implementation claiming Level 1 MUST specify which:

| Facet | Scope | What it covers |
|---|---|---|
| **1P — Producer conformance** | A target that emits change events for declared properties. | The `static wcBindable` declaration shape (§ Schema); the event-naming convention; the **declaration** of `getter` semantics (a function the dispatched `CustomEvent` payload MUST be interpretable by — the *site* of getter invocation differs by profile: under Level 1O local binding the observer/adapter runs the getter against each received event; under a remote profile the producer-side shell applies it before the value crosses the wire, so the consumer side never sees the function — see [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying) Design invariants invariant 2); the EventTarget-or-equivalent `dispatchEvent` requirement (§ Overview); the no-side-effect-event-dispatch-from-property-getter rule (§ Event detail vs Property Read). |
| **1O — Observer conformance** | A consumer-side implementation of `bind()`-equivalent semantics. | The consumer-side EventTarget capability rule (`addEventListener` / `removeEventListener`); the `in`-operator initial-sync rule with its `syncOn` modes (§ Initial Value Synchronization, § Deferring); the teardown / exception-safety / partial-delivery rules (§ Teardown Contract); the unknown-`syncOn` fallback (§ Deferring); the `onUpdate` validity rule (§ onUpdate validity). |

An implementation MAY claim 1P alone (typical: a non-JS server-side component implementation), 1O alone (typical: a JS-only inspector / devtools harness that binds to existing components but never authors them), or both (typical: `@wc-bindable/core`, which exposes both `bind()` for consumers and the declaration-discovery surface every producer needs).

**Facet implication for higher levels.** Level 2 and Level 3 each pin a specific facet rather than mandating both. The rules are:

- **Level 2 implies Level 1O.** The three normatively-named exports (`bind`, `getWcBindableDeclaration`, `isWcBindable`) are observer-side surfaces, so a Level 2 claim MUST satisfy 1O. If the same implementation also provides producer targets or producer helpers (component base classes, declaration generators, etc.), that producer surface MUST additionally satisfy 1P; an observer-only library (e.g. a third-party `bind()` reimplementation that ships no component authoring helpers) is Level 2 conformant on 1O alone.
- **Level 3 splits by role.** A consumer-side remote proxy claiming Level 3 MUST satisfy 1O for its local bind-target surface (the proxy is observed via `bind()` on the consumer). A producer-side remote shell claiming Level 3 MUST satisfy 1P for the target it exposes (it dispatches change events for the wrapped Core). An implementation that ships both sides (the common case for `@wc-bindable/remote` and its eventual peers) MUST satisfy both 1O and 1P for the respective sides; an implementation that ships only one side (a non-JS sidecar that is producer-only, or a thin observer-only client) is Level 3 conformant on the matching facet alone.

---

## Adapter Implementation Guide

A reactivity system that supports this protocol should:

1. Read `target.constructor.wcBindable`
2. Verify `protocol === "wc-bindable"` and `version` is an integer `>= 1` (see [Versioning](#versioning))
3. For each property descriptor:
   a. Attach an event listener for subsequent changes
   b. Perform the initial-value synchronization (see below)
4. Return a function that removes every listener registered above (the **teardown contract**, see below)

> **This 4-step list is a simplification.** The full, normative validation that `bind()` MUST perform — descriptor-shape checks (non-empty string `name` / `event`, function-or-undefined `getter`), name-uniqueness within `properties` / `inputs` / `commands`, the EventTarget-capability check on `target` itself, and the MUST-NOT-throw guard for pathological constructors — is specified in [§ Discovery API](#discovery-api). The reference implementation that follows this guide routes the validation through `getWcBindableDeclaration()`, which performs all of the above; if you re-implement `bind()` from scratch following only the 4 steps above, you will reproduce the "isWcBindable returns true but bind silently no-ops" footgun that the discovery-is-bindability rule exists to prevent. Always consult § Discovery API for the complete check set.

The `target` parameter accepts any **consumer-side bind target** — anything that exposes `addEventListener` / `removeEventListener` plus a valid `constructor.wcBindable` declaration. `HTMLElement` instances and headless `EventTarget` subclasses are the common cases; relay proxies that satisfy the consumer-side capability set without literally extending `EventTarget` are also valid. See [§ Overview](#overview) for the producer-vs-consumer capability split.

### `onUpdate` validity

`onUpdate` is the consumer's callback channel for both initial-sync deliveries and subsequent event-driven updates. Its TypeScript signature is normative (see [§ Normative TypeScript surface](#normative-typescript-surface)), but the spec also pins runtime behavior when the caller passes something that is not a function: `bind()` MUST treat a non-function `onUpdate` as a **programmer error** (outside the protocol surface per the same classification used for `invoke` / `setWithAck` in [SPEC-extensions.md § Methods](SPEC-extensions.md#methods)).

The throw timing is split by conformance level:

- **Level 2 (Core JS API compatibility):** `bind()` **MUST** throw a `TypeError` synchronously at call time, before discovery. The recommended pattern is `if (typeof onUpdate !== "function") throw new TypeError(...)` at the top of `bind()`. Deferring detection is non-conformant at Level 2 because for an empty-`properties` target (legitimate per § Property Descriptor) the deferred path never fires and the bug is silent — and Level 2 is the drop-in compatibility layer where surprise-silent behavior is precisely what breaks interop across framework adapters.
- **Level 1O (observer-only conformance, no Level 2 claim):** `bind()` SHOULD throw a `TypeError` synchronously, MAY defer to the first attempted invocation. The MAY is preserved here only for minimal Layer-1 conceptual implementations that are not trying to be drop-in `@wc-bindable/core` replacements; any implementation a framework adapter imports as `bind` from `@wc-bindable/core` is at Level 2 and bound by the MUST above.

The reference implementation throws synchronously regardless of which level a caller is targeting, because the cost (one `typeof` check) is negligible and the silent-bug failure mode is the same across both.

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

/** A target that survives `isWcBindable()` — i.e. anything that exposes
 *  the consumer-side EventTarget surface (add/removeEventListener) AND a
 *  valid declaration on its `constructor`. The type is structural — it does
 *  NOT extend `EventTarget` — because the consumer-side bind contract does
 *  not require `dispatchEvent`: a relay-only proxy that re-emits events
 *  through its own internal channel is a valid bind target. Including
 *  `EventTarget` in the intersection would let a `isWcBindable()` narrowing
 *  falsely promise `dispatchEvent` on such proxies. */
type WcBindableTarget = {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
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

/** Binding. `target` is typed `unknown` for the same reason the discovery
 *  helpers are: bind() MUST NOT throw **merely because** the target is
 *  null, undefined, non-bindable, or schema-invalid — callers routinely
 *  pass values that include null (e.g. `document.querySelector()` returns
 *  `Element | null`) and the helper absorbs them, returning a no-op
 *  cleanup. Once a valid bindable target is accepted, however, errors
 *  thrown during the synchronous initial sync (a property getter, an `in`
 *  trap, or the consumer's `onUpdate`) DO propagate to the caller — after
 *  the adapter has torn down every listener and observer it installed.
 *  See § Teardown Contract for the cleanup-on-throw rule.
 *
 *  Note: the no-throw-on-invalid-input rule has ONE narrow exception —
 *  a non-function `onUpdate` is a programmer error. Level-2 conformant
 *  implementations MUST throw a TypeError synchronously at bind() entry;
 *  Level-1O-only observer implementations SHOULD do the same and MAY
 *  defer. See § onUpdate validity for the level-by-level rule and why
 *  deferred detection silently accepts the bug for empty-properties
 *  targets. */
function bind(
  target: unknown,
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
  // The entire body lives inside one try/catch because the MUST-NOT-throw
  // contract covers EVERY property read during validation — not just the
  // initial `target` reads but also hostile declaration / descriptor
  // getters (a Proxy `wcBindable` whose `protocol` getter raises, a
  // Proxy property descriptor whose `name` getter raises, …). Any thrown
  // access during validation funnels to the same `return undefined`.
  try {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) {
      return undefined;
    }
    const addListener = target.addEventListener;
    const removeListener = target.removeEventListener;
    const decl = target.constructor?.wcBindable;
    // Minimum capability check: target MUST be a consumer-side bind
    // target. A target that ships a valid declaration but lacks
    // add/removeEventListener would throw inside bind() later — reject
    // it here so isWcBindable() and bind() agree by construction.
    if (typeof addListener !== "function") return undefined;
    if (typeof removeListener !== "function") return undefined;
    if (decl?.protocol !== "wc-bindable") return undefined;
    if (!Number.isInteger(decl.version) || decl.version < MIN_COMPATIBLE_VERSION) return undefined;
    if (!isValidNamedList(decl.properties, isValidPropertyDescriptor)) return undefined;
    if (decl.inputs !== undefined && !isValidNamedList(decl.inputs, isValidInputDescriptor)) return undefined;
    if (decl.commands !== undefined && !isValidNamedList(decl.commands, isValidCommandDescriptor)) return undefined;
    return decl;
  } catch {
    return undefined;
  }
}

function isWcBindable(target) {
  return getWcBindableDeclaration(target) !== undefined;
}

function isValidNamedList(list, isValidEntry) {
  if (!Array.isArray(list)) return false;
  const seen = new Set();
  for (const entry of list) {
    // Snapshot `entry.name` ONCE WITHIN THIS FUNCTION so the uniqueness
    // gate (`seen.has` / `seen.add`) reads the same value the type check
    // a few lines below it reads — a hostile accessor on a Proxy-wrapped
    // descriptor that returns a different string on successive reads
    // would otherwise allow the second read to dodge the first read's
    // gate. NOTE: this only locks the uniqueness gate to ONE read inside
    // this function; it does NOT guarantee that downstream consumers
    // (isValidEntry's own re-reads, the later bind() registration loop,
    // initial-sync property access) observe the same value. Full read
    // consistency across the discovery → bind() pipeline would require
    // discovery to hand bind() a normalized snapshot of the declaration
    // rather than re-walking the live target; this implementation does
    // not do that because the spec's threat model (target is trusted —
    // see § Trust Boundaries) considers the additional hardening
    // unnecessary.
    if (!isValidEntry(entry)) return false;
    const name = entry.name;
    if (typeof name !== "string" || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}
function isValidPropertyDescriptor(p) {
  if (!p || typeof p !== "object") return false;
  // Same single-read rule as isValidNamedList, with the same scope
  // caveat: this protects the type checks WITHIN this function from
  // seeing different values across the three `typeof` reads, but
  // bind() still re-reads `prop.name` / `prop.event` / `prop.getter`
  // independently. Threat-model-acceptable for trusted targets.
  const name = p.name;
  const event = p.event;
  const getter = p.getter;
  return typeof name === "string" && name.length > 0
    && typeof event === "string" && event.length > 0
    && (getter === undefined || typeof getter === "function");
}
function isValidInputDescriptor(p) {
  if (!p || typeof p !== "object") return false;
  const name = p.name;
  const attribute = p.attribute;
  if (typeof name !== "string" || name.length === 0) return false;
  // `attribute` is a Schema-typed optional string. Validate the type even
  // though core does not interpret it — see SPEC-extensions.md.
  if (attribute !== undefined && typeof attribute !== "string") return false;
  return true;
}
function isValidCommandDescriptor(p) {
  if (!p || typeof p !== "object") return false;
  const name = p.name;
  const asyncFlag = p.async;
  if (typeof name !== "string" || name.length === 0) return false;
  // `async` is a Schema-typed optional boolean. Same rationale as `attribute`.
  if (asyncFlag !== undefined && typeof asyncFlag !== "boolean") return false;
  return true;
}

function bind(target, onUpdate, options) {
  // Programmer error: a non-function onUpdate cannot be reached for an
  // empty-properties target (no event would ever fire it), so defer-and-
  // let-it-throw silently accepts the bug. Reject up front. See
  // § onUpdate validity.
  if (typeof onUpdate !== "function") {
    throw new TypeError("bind: onUpdate must be a function");
  }
  // Discovery == bindability: a declaration that survives this check is
  // safe to bind. The version check above is permissive (every integer
  // >= 1) per § Versioning; no adapter-specific upper bound exists.
  const decl = getWcBindableDeclaration(target);
  if (decl === undefined) return () => {};
  // After the discovery guard, `target` is known to expose
  // addEventListener / removeEventListener (the helper's consumer-side
  // capability check — see WcBindableTarget in § Normative TypeScript
  // surface). The cast below narrows to that two-method subset, NOT to
  // the full EventTarget interface — bind() never calls dispatchEvent
  // on the target, which is what lets relay proxies that only re-emit
  // through their own internal channel still be valid bind targets
  // (the WcBindableTarget design intent). The `EventTarget` type tag
  // here is a JSDoc convenience for environments where importing the
  // structural WcBindableTarget type is awkward; at runtime, only the
  // add/removeEventListener methods are invoked, never dispatchEvent.
  const et = /** @type {EventTarget} */ (target);

  const cleanups = [];
  // disposed is declared BEFORE runOrCleanup so the catch path can mark
  // teardown as already-done. Without this, a deferred-sync throw runs
  // every cleanup but leaves `disposed` false, and the user's later
  // unbind() re-walks the cleanup list — defeating the unconditional
  // idempotency MUST from § Teardown Contract for the very hostile-
  // Proxy case the rule exists to protect.
  let disposed = false;
  // Wrapper: if the registration loop, the initial-sync read, or the
  // consumer's onUpdate throws, the listeners installed so far must NOT
  // leak — tear down every cleanup recorded to date and rethrow. The
  // registration loop is wrapped because a Proxy-wrapped relay target
  // (permitted by § Overview) may have an `addEventListener` whose `get`
  // trap throws on the Nth iteration. See § Teardown Contract.
  const runOrCleanup = (fn) => {
    try { fn(); } catch (err) {
      disposed = true;
      cleanups.forEach((c) => { try { c(); } catch {} });
      throw err;
    }
  };

  runOrCleanup(() => {
    for (const prop of decl.properties) {
      const getter = prop.getter ?? DEFAULT_GETTER;
      const handler = (event) => onUpdate(prop.name, getter(event));
      et.addEventListener(prop.event, handler);
      cleanups.push(() => et.removeEventListener(prop.event, handler));
    }
  });

  // Initial value synchronization — use `in` so that an explicitly-undefined
  // property is still reported on first sync.
  const initialSync = () => {
    for (const prop of decl.properties) {
      if (prop.name in et) onUpdate(prop.name, et[prop.name]);
    }
  };

  const syncOn = options?.syncOn ?? "call";
  // Short-circuit when there are no observable properties: the deferred
  // path has nothing to do, and installing a MutationObserver here would
  // violate the "empty properties returns a real no-op cleanup" rule.
  const canDefer =
    syncOn === "connect" &&
    decl.properties.length > 0 &&
    HTMLElementCtor !== undefined &&
    et instanceof HTMLElementCtor &&
    !et.isConnected &&
    documentRef !== undefined &&
    MutationObserverCtor !== undefined;

  if (canDefer) {
    // Observer setup is wrapped in runOrCleanup so a throw from the
    // MutationObserver constructor or from observe() does not leak the
    // listeners installed by the registration loop above (§ Teardown
    // Contract names "the deferred-sync observer's setup" explicitly).
    // disposeObserver is pushed to cleanups BEFORE observe() so the
    // catch path can find it even if observe() throws — observer would
    // be undefined in that window, so the helper guards with `?.`.
    let observer;
    let observerDisposed = false;
    const disposeObserver = () => {
      if (observerDisposed) return;
      observerDisposed = true;
      observer?.disconnect();
    };
    cleanups.push(disposeObserver);
    runOrCleanup(() => {
      observer = new MutationObserverCtor(() => {
        if (et.isConnected) { disposeObserver(); runOrCleanup(initialSync); }
      });
      observer.observe(documentRef, { childList: true, subtree: true });
    });
  } else {
    runOrCleanup(initialSync);
  }

  return () => {
    // Re-entry guard: second and later invocations are an unconditional
    // no-op (§ Teardown Contract). `disposed` may already be true here
    // if runOrCleanup's catch path tore down earlier; that case turns
    // the user's unbind() into a literal no-op without re-walking the
    // cleanup list, which is what the unconditional idempotency MUST
    // requires for hostile non-idempotent removeEventListener targets.
    if (disposed) return;
    disposed = true;
    // Exception-safe teardown: every cleanup runs even if an earlier one
    // throws. Required by the "MUST remove every listener" rule (see
    // § Teardown Contract). Secondary errors are swallowed.
    for (const fn of cleanups) {
      try { fn(); } catch { /* swallow per teardown-contract semantics */ }
    }
  };
}
```

### Teardown Contract

`bind()` **MUST** return a function that, when called, removes every event listener (and any other resource — e.g. `MutationObserver`) the adapter installed during the call. This applies whether or not the target was actually bindable: a no-op cleanup function (`() => {}`) is the correct return value for non-`wc-bindable` targets.

The returned cleanup function MUST be **idempotent** — calling it more than once MUST be a safe no-op on subsequent calls. The conforming way to satisfy this is a **re-entry guard inside the returned closure** (a `disposed` flag that the closure sets on first call and checks on every entry), so the idempotency MUST hold unconditionally rather than depending on each constituent cleanup being idempotent in isolation. The cleanups the adapter records internally (typically `removeEventListener` and `MutationObserver.disconnect()` invocations) happen to be idempotent in the browser standard library, but a hostile target — for instance a `Proxy`-wrapped relay whose `removeEventListener` raises or counts each call — is exactly the kind of bind target this spec accepts elsewhere; the closure-level guard makes the idempotency rule symmetric with the registration-side defensive wrapping in the reference implementation.

The `disposed` flag is also set by `runOrCleanup`'s catch path on **every** install-time throw, not only on the deferred path: a synchronous install-time throw (a hostile `addEventListener` failing on the Nth iteration during the registration loop, or a getter throwing during the synchronous initial sync) also marks the closure as already-disposed before re-throwing. Because the caller in the synchronous-throw case never receives the unbind function (the rethrow happens before `bind()` returns), the disposed flag in that case is unobservable from outside — but maintaining the invariant uniformly across both paths keeps the closure's idempotency rule trivially provable and avoids per-path special-casing inside the returned closure. The deferred-path observability is described below.

**If anything inside `bind()` throws while installing resources** — including the listener-registration loop (e.g. a `Proxy`-wrapped relay target's `addEventListener` throws via a `get` trap on the Nth iteration), the synchronous initial-sync step (a property's `in` trap throws, a property getter throws on read, the consumer's `onUpdate` callback throws), or the deferred-sync observer's setup — the adapter **MUST** tear down every listener and observer it installed earlier in the same `bind()` call before letting the error propagate. Without this, the caller never receives the unbind function and the listener set leaks. This applies to **every** install-time throw, not only the initial-sync read. Cleanup callbacks that themselves throw during this fallback path SHOULD be swallowed; surfacing a cleanup-time secondary error in place of the original error is more confusing than useful.

> **Partial-delivery state at the consumer.** Initial-sync delivers properties in declaration order. If `properties[0..k-1]` succeed but `properties[k]` throws, the consumer has already received `onUpdate(name, value)` calls for every successful property — those calls are observable and **final**. The adapter does NOT (and cannot) roll back consumer state on a subsequent throw. After `bind()` rethrows, the consumer therefore holds a partially-populated view of the target: keys it observed via successful `onUpdate` calls have real values, keys after the failure point have whatever default the consumer initialized with (typically nothing). Consumers that need all-or-nothing initial-sync semantics MUST snapshot their state before calling `bind()` and restore on caught exception themselves; the protocol does not provide a transactional initial sync.

**If a *deferred* initial-sync (`syncOn: "connect"`) throws** the same cleanup runs — but the error has no synchronous caller to propagate to. The throw originates inside a `MutationObserver` callback (a microtask), so the runtime treats it as an uncaught error: browsers surface it via `window.onerror` / `reportError`, Node surfaces it via `process.on('uncaughtException')`, etc. The unbind function the caller already received remains valid; calling it after the deferred throw is a literal no-op thanks to the re-entry guard mandated by the idempotency MUST above (the throw path already set the closure's `disposed` flag, so the user's later `unbind()` returns immediately without re-walking the cleanup list). Adapters SHOULD treat deferred-throw cleanup as a best-effort safety net — consumers who need structured error handling from initial-sync should use `syncOn: "call"` from inside their own lifecycle hook so that the throw lands on a frame they can catch.

**If `onUpdate` throws on a post-initial-sync event** — i.e. after `bind()` has returned and a normal change event fires the registered listener — the error propagates out of the event listener via the standard DOM dispatch path (i.e. it becomes an unhandled error on the dispatching event-loop turn). The listener remains attached; the adapter does NOT auto-unbind on consumer throws, and subsequent events continue to fire normally. Consumers that want fail-fast teardown on their own throws are responsible for calling the returned unbind from a catch in their `onUpdate`.

**If a cleanup callback itself throws during the consumer-invoked unbind** — for example, a `Proxy`-wrapped target whose `removeEventListener` raises, or an overridden `observer.disconnect()` — the adapter **MUST** continue running the remaining cleanup callbacks instead of aborting. Without this, a single misbehaving cleanup at the head of the list would orphan every later listener and observer the same `bind()` installed, contradicting the "MUST remove every listener" rule. The conformant pattern is to wrap each cleanup invocation in `try { ... } catch {}` and swallow secondary errors; teardown is best-effort, not error-reporting. (Same rationale and shape as the synchronous initial-sync throw path described above.)

Long-lived headless `Core` instances may outlive multiple consumers; without an explicit teardown contract, listener leaks are guaranteed. Component-side `disconnectedCallback` cannot be relied on because headless Cores have no DOM lifecycle, and Web Components bound via framework refs may be reattached.

### Initial Value Synchronization

Initial value synchronization is a **required** part of the protocol (not merely an adapter implementation suggestion). For each declared property at bind time:

- If `prop.name in target` is `true`, the adapter **MUST** read `target[prop.name]` and deliver the value (including when it is `undefined`) to the consumer.
- If `prop.name in target` is `false` (the property does not exist on the target), the adapter **MUST** skip the initial synchronization for that property. This is not an error.

The `in` operator is mandated specifically so that `undefined` can be distinguished from "property not declared on target". (For why, see [§ Appendix: Design rationale notes](#appendix-design-rationale-notes).)

Component authors **should** ensure that every `name` in the declaration corresponds to a readable property on the target instance.

> **Note for remote / proxy targets.** A remote-proxied target observes the same rule from the consumer side, but the underlying values arrive **asynchronously** over the wire rather than from a synchronous property read. The bridging is the consumer-side proxy's responsibility: until the producer's `sync` message lands, `prop.name in proxy` MUST be `false` so the in-operator check correctly skips initial sync; on `sync` arrival the proxy populates its cache and dispatches per-property `CustomEvent`s, which the listener installed by `bind()` then receives as if they were ordinary change events. This is the consumer-side proxy's normative `has`-trap contract — formalized in [SPEC-extensions.md § Consumer-side proxy `has` trap contract](SPEC-extensions.md#consumer-side-proxy-has-trap-contract) — without which a JS Proxy-based consumer that passes `has` through to the underlying object would let `bind()` fire a spurious early initial-sync and then re-fire on sync arrival. See [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying) for the wire-format details and § Undefined enumeration for how `undefined` is bridged across JSON's representation gap.

#### Ordering vs subsequent events

The relative ordering of the initial-sync delivery and the first subsequent `onUpdate` triggered by an event depends on `syncOn`:

- With `syncOn: "call"` (the default), the adapter **MUST** attach event listeners and perform the initial-sync read within the same synchronous frame of `bind()`. As a consequence, no event the adapter itself observes can fire on the target *between* the listener attach and the initial-sync delivery — the in-frame ordering is the adapter's enforceable guarantee. Once the initial sync has been delivered and `bind()` has returned, subsequent events follow normal listener-delivery order. The only way an event can interleave the initial sync at all is if `onUpdate` synchronously re-enters the target via `dispatchEvent` while the initial-sync loop is running; the adapter cannot prevent this re-entry, and component / consumer authors SHOULD NOT do it. The event-payload-authoritative rule (see [§ Event detail vs Property Read](#event-detail-vs-property-read)) covers any resulting ordering anomaly.
- With `syncOn: "connect"`, the initial-sync read is intentionally deferred until the target becomes connected. **Any change event that fires between `bind()` return and the deferred initial-sync MUST be delivered to `onUpdate` in the order it arrives** — that is, an event arriving before the deferred sync is delivered first, and the deferred initial-sync runs afterwards with `target[prop.name]` read at sync time. The consumer therefore sees the most recent value last, regardless of the path it arrived on. This is the only sound interpretation when the read site is deferred; the `"before any events fire"` guarantee from `syncOn: "call"` is **not** in effect under `syncOn: "connect"`.

In `syncOn: "call"` the **event payload is authoritative** in case the initial-sync read and a subsequent event disagree on the value — see [§ Event detail vs Property Read](#event-detail-vs-property-read). **In `syncOn: "connect"` this rule is overridden by the ordering rule above**: the deferred initial-sync runs *after* any events that fired pre-connection, reads `target[prop.name]` at sync time, and that read is what the consumer's state holds last. The deferred-sync read therefore wins over a pre-connection event payload, which is the opposite of the call-mode authority direction. This is a deliberate compromise — in the deferred case, the producer is expected to NOT dispatch wc-bindable change events on an unconnected element (no real consumer is observing changes yet), and if it does, the sync-time property read is the better source of truth at the moment the consumer first becomes attentive. Producers that genuinely need event-payload-wins semantics on an unconnected target MUST use `syncOn: "call"` from a host lifecycle hook instead.

#### Deferring the Initial Sync Until Connection

> **`syncOn: "connect"` is a best-effort DOM-convenience fallback, not a host-lifecycle replacement.** The name suggests a first-class lifecycle hook; the implementation is a single document-wide `MutationObserver` that observes the first insertion and then disconnects. Concretely it does NOT traverse shadow roots, does NOT re-fire on disconnect → reconnect cycles, does NOT survive a connect-then-immediate-disconnect race within the same task, MUST silently fall back to `"call"` in non-browser runtimes, and installs one observer per deferred bind so bulk-binding many elements scales the observer count linearly. None of these are bugs — each is a documented consequence of "the protocol does not own a host lifecycle and is borrowing a `MutationObserver` as the closest standard primitive". **An adapter that holds a host-lifecycle reference (React `useEffect`, Vue `onMounted`, Stencil `componentDidLoad`, a custom element's own `connectedCallback`, etc.) MUST prefer `syncOn: "call"` from inside that hook.** `syncOn: "connect"` exists for imperative light-DOM construction patterns (VanJS / MobX / RxJS / Signals binders that hand the caller a binder which is then `appendChild`-ed separately) where no host lifecycle is available; outside that narrow case it is the inferior choice. The full caveat list — shadow-root non-traversal, connect-then-disconnect race, observer-per-bind cost, synthetic / proxy fall-back — lives in the prose and callouts below.

When `target` is an `HTMLElement` and `bind()` is called before the element has been inserted into a document (so `connectedCallback` has not yet run), reading properties synchronously may observe pre-connection state. To address this, `bind()` accepts an optional third argument:

```typescript
bind(target, onUpdate, { syncOn: "connect" })
```

- `syncOn: "call"` (default): perform the initial sync synchronously inside `bind()`. Backward-compatible behavior. Also the fallback for any value other than `"connect"` — see the unknown-value rule below.
- `syncOn: "connect"`: if the target is an `HTMLElement` that is not yet connected, defer the initial sync until the element becomes connected **for the first time**. The reference implementation observes the top-level `document` via a `MutationObserver`. For headless `EventTarget`s and already-connected elements, behaves like `"call"`. The DOM globals (`HTMLElement`, `document`, `MutationObserver`) are referenced through `typeof` guards so that the reference implementation runs unmodified in non-browser runtimes where these globals are undefined — in that case `syncOn: "connect"` silently falls back to the `"call"` path. **Disconnect → reconnect cycles after the first connection do NOT re-trigger the initial sync** — the observer disconnects as soon as the deferred sync fires once. Consumers that need a fresh initial-sync on every re-attach should unbind and re-bind from their own lifecycle hook.

**Unknown `syncOn` values MUST be treated as `"call"`.** TypeScript narrows the field to the `"call" | "connect"` literal union, but JavaScript callers can pass any string (or any value). An implementation MUST NOT throw on an unrecognized value; it MUST fall back to the synchronous default. This matches `bind()`'s overall "MUST NOT throw on invalid input" posture from [§ Normative TypeScript surface](#normative-typescript-surface) — `syncOn` is an input field like any other, and a typo (`"later"`, `"defer"`) is a programmer error best handled by a safe fallback that the consumer can notice via the observed behavior, not by a hard runtime throw. Future spec revisions MAY add new `syncOn` values; older implementations that pre-date those values will then behave as if the caller passed `"call"`, preserving forward compatibility.

The returned unbind function tears down the `MutationObserver` as well, so cancelling a deferred bind is safe.

> **Shadow DOM limitation.** A `MutationObserver` attached to `document` with `subtree: true` does **not** traverse shadow roots, so a target that is appended into another element's shadow tree will have `target.isConnected === true` without firing the observer — the deferred initial sync never runs. This is a structural limitation of `MutationObserver`, not a bug. Adapters that **own** the element (i.e. hold a ref to it via a framework lifecycle hook such as React `useEffect`, Vue `onMounted`, Stencil `componentDidLoad`, or a custom element's own `connectedCallback`) **SHOULD** call `bind(target, onUpdate)` (with the default `syncOn: "call"`) from inside that hook rather than relying on `syncOn: "connect"`. The deferred path is intended for callers who construct elements imperatively and append them into the light DOM in a separate step (e.g. the VanJS / MobX / RxJS / Signals binder pattern). Adapters that deferred-bind a large number of elements simultaneously should also be aware that each deferred bind installs one document-wide observer.
>
> **Connect-then-disconnect race.** `MutationObserver` callbacks are delivered as microtasks, not synchronously. If the host appends the target and then synchronously detaches it again within the same task — for example, a transient mount inside a virtual-DOM diff — the observer callback runs after both mutations and observes `target.isConnected === false`. The reference implementation rechecks `isConnected` inside the callback, so it does NOT fire the initial sync in this case and the observer remains armed; a later re-attach will re-fire the observer and complete the sync. If the target is never re-attached, the observer is held alive until `unbind()` is called and never delivers the initial sync. This is an intentional consequence of "deferred until first real connection" — adapters that need a tighter binding to host lifecycle MUST use `syncOn: "call"` from their own lifecycle hook instead.

> **Synthetic / proxy targets fall back to `"call"` automatically.** Synthetic targets that subclass `EventTarget` rather than `HTMLElement` — typically used by remote proxies, test doubles, and the per-declaration isolated subclasses described in [§ Discovery Contract](#discovery-contract) — fail the `target instanceof HTMLElement` check inside the deferred-path gate and silently fall back to the synchronous `"call"` behavior. This is the desired outcome: deferred-sync presumes a DOM `connectedCallback` lifecycle that proxy/test targets do not have, and the proxy's initial value arrives via its own wire `sync` (see [§ Initial Value Synchronization](#initial-value-synchronization) note) regardless of which `syncOn` value the caller passed. Adapters that wrap `bind()` and forward `syncOn: "connect"` blindly therefore do the right thing on non-DOM targets without special-casing.

### Repeated Events for the Same Property

When a component dispatches the same event multiple times, the adapter calls `onUpdate` for each occurrence. There is no batching, deduplication, or equality check — every event produces a callback. Consumers that need deduplication (e.g., skipping no-op re-renders) are responsible for implementing it on their side.

### Event detail vs Property Read

The protocol uses two independent reads of the property value:

- **Initial sync** reads `target[prop.name]` directly.
- **Subsequent updates** read `getter(event)`, defaulting to `event.detail`.

The two **SHOULD** be kept in agreement by the component author. If they diverge (e.g. a `detail` payload differs from the current property value), the **event payload is authoritative** — adapters do not re-read the property after an event fires. Component authors who cannot guarantee parity should derive `detail` from the property at dispatch time.

> **Producer-side rule — property getters MUST be side-effect-free with respect to wc-bindable change events.** A `wcBindable`-declared property's getter (or the equivalent attribute-backed read on a Web Component) **SHOULD** be a pure read of the current value as a general matter, and **MUST NOT** synchronously dispatch a `wc-bindable`-declared change event during the read (the stronger rule for the specific re-entrant case). Adapters attach listeners *before* performing the initial-sync read (so no event is missed during the read), so a getter that re-enters via `dispatchEvent` causes both the dispatch and the initial-sync read to reach the consumer in dispatch order, producing a double `onUpdate` whose second value depends on whatever was read last. Conformant adapters are NOT required to detect, deduplicate, or repair this re-entrant case — the protocol's defense is to forbid it at the producer. If a side effect is genuinely unavoidable (e.g. a sensor whose read materializes the value), the producer **SHOULD** perform the side effect on construction or in a dedicated initializer, NOT inside the getter; an unavoidable non-event side effect (e.g. a benign cache fill) is permitted under the general SHOULD-be-pure rule but is not the same as the MUST NOT on event dispatch.

### Getter Errors

If a `getter` function throws during event handling, the adapter **MUST NOT** swallow the error silently. The error **MUST** propagate naturally (i.e., be thrown from the event listener). This preserves normal JavaScript error semantics and allows component authors to detect bugs in their getter implementations.

Adapters **SHOULD NOT** wrap getter calls in try/catch unless they re-throw the error after performing cleanup.

---

## Producer Obligations

The rules a *consumer-side* adapter must follow are scattered across § Discovery API, § Teardown Contract, § Initial Value Synchronization, and § onUpdate validity — that is the surface `bind()` directly implements and where most cross-impl interop tests live. The rules a **producer** must follow are equally normative but are easier to overlook because they are scattered across § Initial Value Synchronization, § Event detail vs Property Read, § Getter Errors, and § Trust Boundaries. This section gathers them in one place. None of them are new rules — each links to its normative home; this section exists so a component author writing a producer can audit their work against a single checklist.

A wc-bindable producer MUST:

- **Make every declared `properties[i].name` readable for initial sync.** `bind()` reads `target[name]` (gated by the `in` operator) at sync time and delivers the value to the consumer, including when it is `undefined`. A `name` declared in `properties` but missing from the target instance silently skips initial sync — see [§ Initial Value Synchronization](#initial-value-synchronization).
- **Keep the property's current value and the corresponding event's payload (or `getter`-extracted value) representing the same logical state.** When they diverge, the event payload is authoritative for subsequent updates, and the consumer-side adapter is NOT required to detect, deduplicate, or repair the divergence — see [§ Event detail vs Property Read](#event-detail-vs-property-read).
- **Avoid synchronously dispatching a wc-bindable change event from inside a declared property getter** (whether the getter is on the producer-side property descriptor or implicit via a Web Component attribute-backed read). Adapters attach listeners *before* performing the initial-sync read, so a getter that re-enters via `dispatchEvent` produces a double `onUpdate` whose second value is order-dependent. Conformant adapters are NOT required to detect, deduplicate, or repair this re-entrant case — see the producer-side rule paragraph in [§ Event detail vs Property Read](#event-detail-vs-property-read).
- **Keep declared property getters side-effect-free with respect to wc-bindable change events.** A non-event side effect (e.g. a benign cache fill on first read) is permitted under the general "SHOULD be pure" guidance but is not the same relaxation — synchronously dispatching a declared change event during the read is the strong MUST NOT above. Unavoidable initialization side effects SHOULD happen at construction or in a dedicated initializer, NOT inside the getter.
- **Allow `getter`-thrown errors to propagate.** The adapter contract requires consumers to NOT swallow getter throws — that error reporting is the producer's signal that its getter has a bug. See [§ Getter Errors](#getter-errors).
- **Dispatch through `dispatchEvent` (`CustomEvent` or a structurally compatible event)** for every change to a declared property. The protocol's observation guarantee depends on this; without it, the consumer never receives an update.
- **Treat declared `name`s as the public interface.** Renaming a `name` in `properties` / `inputs` / `commands` is a breaking change for every consumer that bound against the old name. Versioning provides no recovery path; the consumer's `bind()` simply stops delivering that property.

A wc-bindable producer is **NOT required to**:

- **Deduplicate or coalesce repeated events** for the same property. The consumer-side adapter delivers every event as-is; the producer MAY emit redundant change events and the consumer is responsible for any deduplication it needs — see [§ Repeated Events for the Same Property](#repeated-events-for-the-same-property).
- **Make `getter` referentially stable.** The consumer-side adapter re-reads the descriptor at each `bind()` call; a producer that swaps `getter` at runtime is unusual but not forbidden — though it is the source of the hostile-accessor caveat in [§ Trust Boundaries](#trust-boundaries) and is strongly discouraged for stable interop.
- **Implement `inputs` / `commands` behaviorally for Core conformance.** Core only schema-validates them; behavioral semantics belong to [SPEC-extensions.md § Extension 1](SPEC-extensions.md#extension-1--inputcommand-invocation). A core-only producer that declares `inputs` is making a true statement about its settable surface; it is not promising any particular `set` / `setWithAck` semantics until Extension 1 is also in play.

These obligations are what the cross-impl interop guarantees rest on. A producer that violates the strong MUST NOTs above will appear to work against forgiving adapters and break against strict ones; testing against the reference adapter is not sufficient.

---

## Versioning

The protocol version is an integer. Within a single `protocol` identifier (e.g. `"wc-bindable"`), every adapter and every declaration are mutually compatible by construction:

- An adapter **MUST** accept any declaration whose `version` is an integer `>= 1`, regardless of when the adapter was built or what version the adapter itself was originally designed against. Adapters **MUST NOT** impose an adapter-specific upper or lower version bound (e.g. "this v2 adapter only handles `version >= 2`"). Doing so would silently no-op against valid older declarations and is explicitly forbidden.
- New optional fields (on the root, on property/input/command descriptors, or new root-level keys entirely) may be added in later versions. Adapters **MUST** ignore fields they do not recognize. The `version` field then becomes informational at the wire / discovery level — its primary role within a given `protocol` identifier is to flag the presence of newer optional fields, not to gate acceptance.
- Breaking changes to the `properties` binding contract (the shape of property descriptors, the meaning of `event` / `getter`, the initial-sync rule, the teardown contract) require a new `protocol` identifier (e.g. `"wc-bindable-2"`), **not** a version bump. This guarantees both directions: a v1 adapter never silently misinterprets a future declaration **and** a future-version adapter never silently rejects a v1 declaration.

The normative rule above ("integer `>= 1`") is the version contract every implementation MUST enforce. The reference implementation `@wc-bindable/core` materializes this minimum as an exported constant `MIN_COMPATIBLE_VERSION = 1` for convenience; the constant's *name* is NOT normatively required (only the three runtime entry points `bind`, `getWcBindableDeclaration`, and `isWcBindable` are normatively named — see [§ Discovery API](#discovery-api) and [§ Conformance Levels](#conformance-levels) Level 2). Other implementations MAY use any identifier or inline the literal `1`; what they MUST NOT do is raise the threshold above `1` for the `"wc-bindable"` protocol identifier, because that would silently reject valid older declarations.

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

Several adapters in this repository (React, Preact, Vue, Vanjs, Mobx, Rxjs, Signals, Mithril, Riot, Stencil, Lit) also accept an **optional initial-values object** as the first call-site argument — e.g. `useWcBindable<HTMLElement, MyCounterValues>({ count: 0 })` — so the consumer's local state has a meaningful starting shape before the first declared event fires (or before initial sync resolves on a remote proxy). This is an adapter-level convention, not a protocol-level requirement; the core `bind()` itself takes no such argument and the spec does not mandate one. Adapters that adopt it SHOULD treat the object as a shallow initial state and SHOULD overwrite each key as soon as the matching `(name, value)` arrives from the protocol.

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
Putting the declaration on the class (rather than on every instance) keeps it in one place that both *tooling* and *bind() at runtime* read the same way. Tooling that operates on the class object — codegen, docs generators, schema extractors — can inspect `Class.wcBindable` directly without instantiating anything. The `bind()` path receives an instance and reads `instance.constructor.wcBindable`, reaching the same declaration via the JS-native `constructor` reference. One source of truth, two consumers, no per-instance copy.

**Why not JSON / custom attribute?**  
Functions (getters) cannot be expressed in JSON. A `static` field keeps everything in one place with full JavaScript expressiveness.

**Why EventTarget and not HTMLElement?**
`EventTarget` is the minimal standard interface that covers the protocol's two roles: a **producer** dispatches change events via `dispatchEvent`, and a **consumer-side bind target** receives them via `addEventListener` / `removeEventListener`. Targeting `EventTarget` (rather than `HTMLElement`) lets the protocol work in non-browser runtimes (Node.js, Deno, Cloudflare Workers) and lets headless components encapsulate business logic without any DOM dependency. `HTMLElement` is a subclass of `EventTarget`, so all Web Components are automatically compatible.

Note that the two roles have different surface requirements (see § Overview): a producer needs all three EventTarget methods, but a consumer-side bind target only needs `addEventListener` / `removeEventListener`. A relay wrapper that re-emits events through its own internal channel (without exposing `dispatchEvent`) is therefore a valid `bind()` target even though it does not literally extend `EventTarget`. The discovery helper enforces the consumer-side subset, not the full `EventTarget` interface.

**Why are `inputs` and `commands` optional?**
The protocol's primary purpose is reactive property binding (`properties`). The `inputs` and `commands` fields are an opt-in extension for components that wish to declare their full interface — for example, to enable remote proxying, tooling, or documentation generation. Components that only need one-way state observation can omit them entirely. Importantly, these fields are purely declarative — they do not create any automatic two-way synchronization between the component and the framework.

**Why doesn't `bind()` interpret `inputs` and `commands` directly?**
Doing so would require the core to take a position on call semantics (synchronous? batched? acked? error-mapped?) that varies wildly across runtimes. The core stays small by reading only `properties`; downstream specs build call semantics on top — see [SPEC-extensions.md](SPEC-extensions.md).

**Is this a W3C standard?**
No. This is a community protocol. Any EventTarget-based class or framework can adopt it independently.

**Why is `version` required if breaking changes use a new `protocol` identifier?**
Three reasons, in decreasing order of weight:

1. **Well-formedness gate.** The `version` field gives every adapter a cheap, uniform sanity check: a declaration without an integer `version >= 1` is unambiguously not a wc-bindable declaration, regardless of which `protocol` string it carries. Adapters and tooling that probe arbitrary targets (devtools, codegen, test inspection) use the field's presence as the second discriminator after `protocol === "wc-bindable"`, instead of having to validate the rest of the schema before deciding the target is "ours" at all.
2. **Future-affordance for additive metadata.** The forward-compatibility policy says breaking changes get a new `protocol` identifier — but additive changes (a new optional descriptor field, a new top-level optional key) DO bump `version`. An adapter that wants to opt into a new feature can branch on `decl.version >= N` without affecting backward compatibility, because it MUST still bind successfully against lower-version declarations.
3. **Wire-format echoing.** Remote and similar bridging extensions transmit `version` faithfully (see [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying)). Tooling on the other side that inspects a sync snapshot can ask "what feature surface is this producer at?" without separately reading the producer's source. A literal `1` everywhere today still costs nothing; the slot exists so the question can be answered in v1.1 / v1.2 / … without renegotiating the wire shape.

So the field is informational *for the binding contract* (every adapter accepts every version `>= 1`), but informational does not mean useless — it is the single integer that makes the declaration well-formed, future-extensible, and inspectable end-to-end.

---

## Appendix: Design rationale notes

These notes record the *why* behind a few decisions that earlier spec drafts surfaced inline. They are non-normative — the normative rules are stated where they belong in the main body — but third-party implementers may find them useful when judging an edge case the normative text does not directly address.

**Why `getWcBindableDeclaration()` performs full validation (Discovery = bindability).**
A pre-v0.7.1 draft of this spec validated only `protocol` / `version` / `properties` at discovery time and pushed name-uniqueness and descriptor-shape checks into `bind()`. The split caused `isWcBindable(target) === true` while `bind(target, ...)` silently returned a no-op cleanup — a footgun for any consumer that gated on `isWcBindable`. Moving the full schema check into the discovery helper makes the two functions agree by construction and removes the silent-no-op path.

**Why the `in` operator gates initial sync (instead of `!== undefined`).**
A pre-v0.7.0 draft used `if (target[prop.name] !== undefined)` as the initial-sync gate. That gate cannot deliver a property whose current value is legitimately `undefined`, conflating "the value is undefined" with "the property is not exposed on the target". The `in`-operator gate distinguishes the two and lets components declare an initial-`undefined` state without losing the first delivery; the consequence (an extra `onUpdate(name, undefined)` for properties whose value is `undefined`) is accepted as the correct behavior.

**Why the reference pseudocode uses optional chaining (not a `typeof` gate) on `target.constructor`.**
A class declaration in JavaScript is a function (`typeof MyClass === "function"`), not an object. A pre-v0.7.1 draft of the pseudocode gated on `typeof ctor === "object"` and silently failed to discover any class-based component — the single most common shape in the wild. Optional chaining inside a `try / catch` accepts both function-typed (class) and object-typed constructors and satisfies the "MUST NOT throw" rule even when `target` is a null-prototype-like object.

**Why a custom `getter` is NOT applied during initial sync.**
The default getter (`e => e.detail`) is applied to subsequent change events but not to the initial-sync read; the initial sync reads `target[prop.name]` directly. This is deliberate: there is no `Event` object to feed the getter on the initial pass, so applying it would require the adapter to synthesize one with a fake `detail`, which is exactly the kind of impedance mismatch this protocol tries to avoid. The cost is a small asymmetry — a component that declares `getter: (e) => e.detail.checked` MUST also expose `target.checked` returning the same shape the getter would extract, so the two paths produce equal values for the same logical state. The spec mandates this alignment as a SHOULD (see § Event detail vs Property Read); enforcing it as a MUST is impossible without runtime invocation of the getter at construction, which would defeat the headless-component goal. Component authors who genuinely cannot maintain the parity should expose the extracted value directly as the property and use the default getter.

**Why the minimum version is pinned to `1` (and adapter-specific bounds are forbidden).**
The forward-compatibility policy — "breaking changes get a new `protocol` identifier, not a version bump" — implies symmetric compatibility within a given `protocol` identifier. A future v2 adapter that gated on `decl.version >= 2` would silently no-op against valid v1 declarations, producing exactly the regression the policy was meant to prevent. The reference implementation materializes this minimum as the constant `MIN_COMPATIBLE_VERSION = 1` (the *name* is implementation-local, not part of the normative API — only the three runtime entry points `bind`, `getWcBindableDeclaration`, and `isWcBindable` are pinned per § Discovery API and § Conformance Levels Level 2), and the constant's value MUST NOT be raised in future releases under the `"wc-bindable"` identifier.

---

## License

MIT
