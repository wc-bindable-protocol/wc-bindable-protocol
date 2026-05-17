# wc-bindable-protocol Conformance Test Vectors

> **Authoritative scope of this document.** CONFORMANCE.md is the **authoritative source for the runnable starter test vectors** — concrete Setup → Action → Expected → Spec-reference cases that any third-party implementation should reproduce. It is **necessary but not sufficient** for conformance: the test cases here are a curated subset of the rules defined in [SPEC.md](SPEC.md) and [SPEC-extensions.md](SPEC-extensions.md), and those documents remain authoritative on the rules themselves. Where a vector below disagrees with the linked spec section, the spec section is authoritative — file an issue against this document.

This file is a **starter set** of test vectors for implementations of `@wc-bindable/core` and/or `@wc-bindable/remote`. The list is intentionally short — it covers the rules that are easy to get wrong in ways that compile, pass naive tests, and only surface under specific runtime patterns.

**Scoping rule.** Each vector applies to one or more of the conformance claims defined in [SPEC.md § Conformance Levels](SPEC.md#conformance-levels). Implementations are expected to pass **every vector applicable to the level and role they claim** — not every vector in the file. A Level 2 core implementation should pass the core / local-observation vectors and is not obligated to pass remote / wire vectors. An Extension 2 remote consumer-side proxy should pass the consumer-side wire vectors and the local 1O bind-target vectors its proxy supports; a producer-side remote shell should pass the producer-side wire vectors and the local 1P vectors for the target it exposes. The "Applies to" column on each row identifies the claim it tests, using the facet-annotated shorthand from SPEC.md § Conformance Levels (`{1O, 2}`, `{1P, 3-producer}`, etc.).

Passing every applicable vector is **necessary but not sufficient** for full conformance; failing any indicates a concrete bug that [SPEC.md](SPEC.md) or [SPEC-extensions.md](SPEC-extensions.md) calls out in prose.

Each vector below is structured the same way: **Setup → Action → Expected → Spec reference**. The spec reference is authoritative; the vector here exists to give implementers a runnable target.

> The vector descriptions are framework-agnostic JavaScript pseudocode. Concrete TypeScript tests for the reference implementation live under [`packages/core/tests/`](packages/core/tests/) and [`packages/remote/tests/`](packages/remote/tests/); reading those gives the in-tree shape, but this file is what a third-party reimplementer reads first.

## Summary

Conformance is **facet-based, not monolithic** — an implementation does not need to pass every vector to be conformant; it needs to pass the vectors applicable to the level + role combination it claims. The facets:

| Facet | What it means |
|---|---|
| **`{1O}`** | Consumer-side: can observe a wc-bindable target via `bind()`-equivalent semantics (the `in`-operator initial-sync rule, `syncOn` modes, teardown / exception-safety, `onUpdate` validity) |
| **`{1P}`** | Producer-side: a target that exposes a valid `static wcBindable` declaration and dispatches the declared events (the contract a component author writes against) |
| **`{2}`** | Drop-in Core JS API compatibility — exports `bind`, `getWcBindableDeclaration`, `isWcBindable` with the exact normative signatures; implies `{1O}` and `{1P}` because anything a framework adapter imports as `@wc-bindable/core` is gated by it |
| **`{3-consumer}`** | Remote consumer-side proxy — implements Extension 2's wire format and Extension 1's call methods (`set`, `setWithAck`, `invoke`) from the consumer side |
| **`{3-producer}`** | Remote producer-side shell — accepts the wire format on the producer side, dispatches per-property updates, runs `getter` server-side |
| **`{3-both}`** | Implementation that ships both sides (the reference `@wc-bindable/remote` is `{1O, 2, 3-both}`) |

Compound shorthand: `{1O, 2}` means "Level 1 observer facet + Level 2"; `{3-consumer}` is the consumer-side of an Extension 2 implementation; `{3-both}` ships both Level 3 sides. `{1O}` standalone means any 1O-claiming implementation regardless of higher levels. The full definitions live in [SPEC.md § Conformance Levels](SPEC.md#conformance-levels) — this legend is a navigation aid, not a re-definition.

| # | Area | Applies to | Test case | Spec section |
|---|---|---|---|---|
| 1 | Discovery | `{1O, 2}` (and `{3-consumer}` / `{3-both}` for the proxy's local bindable declaration exposed to core `bind()` — i.e. the wrapper's own `constructor.wcBindable`, per [SPEC.md § Discovery Contract](SPEC.md#discovery-contract)) | Duplicate property names invalidate the declaration | [SPEC.md § Property Descriptor](SPEC.md#property-descriptor) |
| 2 | Discovery | `{1O, 2}` (and `{3-consumer}` / `{3-both}` for the proxy's local bindable declaration exposed to core `bind()` — i.e. the wrapper's own `constructor.wcBindable`, per [SPEC.md § Discovery Contract](SPEC.md#discovery-contract)) | Malformed `inputs[].attribute` (non-string) invalidates the declaration | [SPEC.md § Input Descriptor](SPEC.md#input-descriptor) |
| 3 | Empty properties | `{1O, 2}` (and any 1O-claiming bind implementation) | `properties: []` → `bind()` succeeds, installs no listeners, returns a valid no-op cleanup | [SPEC.md § Property Descriptor](SPEC.md#property-descriptor) (empty-array case) |
| 4 | Initial sync | `{1O}` (any 1O-claiming bind implementation, including `{1O, 2}` and `{3-consumer}` proxies that expose `bind()`-equivalent semantics to local consumers) | A property whose current value is `undefined` is still delivered as `onUpdate(name, undefined)` on initial sync | [SPEC.md § Initial Value Synchronization](SPEC.md#initial-value-synchronization) |
| 5 | Remote sync | `{3-consumer}` and `{3-both}` | Before the `sync` response, `name in proxy === false` for declared `properties` names (the rule is properties-only; `inputs` / `commands` `in` behavior is implementation-defined — see the detail section) | [SPEC-extensions.md § Consumer-side proxy `has` trap contract](SPEC-extensions.md#consumer-side-proxy-has-trap-contract) |
| 6 | Remote undefined | `{3-consumer}` and `{3-both}` | An `update` envelope with no `value` key produces `onUpdate(name, undefined)` — **not** `null` | [SPEC-extensions.md § Update envelope value field](SPEC-extensions.md#update-envelope-value-field) + [§ CustomEvent `detail` and undefined preservation](SPEC-extensions.md#customevent-detail-and-undefined-preservation) |
| 7 | JsonValue | `{3-consumer}` and `{3-producer}` (and `{3-both}`) — every side that serializes payloads to the wire | Non-finite numbers, non-plain-prototype objects, sparse-hole arrays, accessor-property objects, non-enumerable objects, functions, and cyclic references are rejected by `JsonValue` validation. Symbol-keyed objects are rejected **by default**; an implementation MAY accept them only by documenting the opt-out and silently dropping the symbol keys at serialization (see the detail section) | [SPEC-extensions.md § Design invariants → invariant 3](SPEC-extensions.md#extension-2--wire-format-remote-proxying) |
| 8 | Teardown | `{1O, 2}` (and any other 1O implementation that hands a cleanup function back to the caller) | If `addEventListener` throws on the Nth listener install, the previous N-1 listeners MUST be removed before the throw propagates | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) |
| 9 | setWithAck | `{3-both}` end-to-end; producer-side semantics tested on `{3-producer}`, consumer-side semantics tested on `{3-consumer}` | The returned `Promise` MUST NOT resolve before the JS-level assignment `target[name] = value` has executed on the producer side | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `setWithAck` row) + [§ setWithAck end-to-end](SPEC-extensions.md#setwithack-end-to-end) |
| 10 | setWithAck legacy | `{3-consumer}` and `{3-both}` (the consumer-side rejection rule is what is tested; producer side participates only as a stub that omits `setAck`) | If the producer's `sync` response omits / sets-false `capabilities.setAck`, `setWithAck` MUST return an already-rejected `Promise` and MUST NOT send an id-bearing `set` on the wire | [SPEC-extensions.md § Message types — server → client](SPEC-extensions.md#message-types--server--client) (setAck capability bullets) + [§ Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) |
| 11 | onUpdate validity | **`{2}` MUST**; `{1O without 2}` SHOULD (MAY defer to first invocation — see body) | **`{2}` (binding pass/fail):** `bind(target, "not-a-function")` (and other non-function `onUpdate` values) MUST throw a synchronous `TypeError` at `bind()` entry, **including** on an empty-`properties` target where deferred detection would never fire. **`{1O without 2}` (informational):** SHOULD throw synchronously; an implementation that defers MUST still surface the `TypeError` at the first attempted `onUpdate` invocation, so a non-empty-`properties` target produces the throw at initial-sync delivery time | [SPEC.md § onUpdate validity](SPEC.md#onupdate-validity) |
| 12 | Hostile discovery | `{1O, 2}` (any implementation exposing `getWcBindableDeclaration` / `isWcBindable`) | A target whose `constructor.wcBindable` access throws (Proxy `get` trap that raises, throwing accessor on a Schema field, null-prototype constructor) MUST result in `getWcBindableDeclaration() === undefined`, `isWcBindable() === false`, and `bind()` returning a non-bindable no-op cleanup — no error escapes the helpers | [SPEC.md § Discovery API](SPEC.md#discovery-api) (MUST NOT throw) |
| 13 | Deferred sync ordering | `{1O}` for general-purpose browser JS implementations targeting `HTMLElement` with `syncOn: "connect"`. MAY be skipped **only** under the spec-defined fallback conditions: non-browser runtime without DOM globals, non-`HTMLElement` / synthetic / already-connected target, or an explicitly scoped profile that documents non-support of browser DOM deferred-sync. A `{1O}` implementation **SHOULD NOT** skip this vector merely by ignoring `syncOn: "connect"` — see body | Under `syncOn: "connect"`, a setter-driven property mutation on the still-unconnected target (which dispatches the change event as a side effect) MUST surface the event to `onUpdate` first; the deferred initial sync runs afterward and delivers `target[prop.name]` as read at connection time | [SPEC.md § Initial Value Synchronization → Ordering vs subsequent events](SPEC.md#ordering-vs-subsequent-events) |
| 14 | Cleanup-throw containment | `{1O, 2}` (and any 1O implementation that hands a cleanup function back to the caller) | If the first listener removal in the cleanup chain throws (hostile `removeEventListener`), the remaining listeners and `MutationObserver`s registered by the same `bind()` call MUST still be torn down; the secondary cleanup-time error is swallowed | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) (the "MUST continue running the remaining cleanup callbacks" paragraph) |
| 15 | Reserved names | `{3-consumer}` and `{3-producer}` (and `{3-both}`) | A declaration containing a `properties` / `inputs` / `commands` `name` that begins with `@wc-bindable/` MUST cause the consumer-side proxy constructor and the producer-side shell constructor to throw synchronously with a clear error; no wire traffic MUST be sent for such a name even if validation is bypassed | [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) (Normative minimum) |

---

## Vectors

### 1. Discovery — duplicate property names invalidate the declaration

**Setup.** A target whose `static wcBindable.properties` contains two descriptors with the same `name`:

```javascript
class T extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "t:value-a-changed" },
      { name: "value", event: "t:value-b-changed" },  // duplicate `name`
    ],
  };
}
const target = new T();
```

**Action.** Call `getWcBindableDeclaration(target)`, `isWcBindable(target)`, and `bind(target, () => {})`.

**Expected.**
- `getWcBindableDeclaration(target) === undefined`
- `isWcBindable(target) === false`
- `bind(target, () => {})` returns the non-bindable `() => {}` no-op cleanup; no listeners are installed
- The same vector holds for duplicate names within `inputs` and within `commands` (see [SPEC.md § Input Descriptor](SPEC.md#input-descriptor) / [§ Command Descriptor](SPEC.md#command-descriptor))

---

### 2. Discovery — malformed `inputs[].attribute` invalidates the declaration

**Setup.** A target whose `inputs[].attribute` is not a string:

```javascript
class T extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "v", event: "t:v" }],
    inputs:     [{ name: "v", attribute: 42 }],  // non-string `attribute`
  };
}
```

**Action.** `isWcBindable(new T())`.

**Expected.** `false`. The declaration is invalid even though core does not interpret `attribute` at runtime — discovery validates the schema regardless. The same vector holds for malformed `commands[].async` (non-boolean), missing-or-empty `name`, and any other Schema-typed field outside its declared type.

---

### 3. Empty `properties: []` → `bind()` succeeds with no listeners

**Setup.** A command-only target:

```javascript
class CommandOnly extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [],
    commands:   [{ name: "doThing" }],
  };
  doThing() { /* ... */ }
}
const target = new CommandOnly();
let callCount = 0;
const cleanup = bind(target, () => { callCount++; });
```

**Action.** Inspect listener registry; invoke `cleanup()`; assert `callCount === 0`.

**Expected.**
- `bind()` returns a callable cleanup function (not throws, not undefined)
- Zero listeners are installed against `target` (verify via instrumentation on `target.addEventListener`, or by dispatching arbitrary events and confirming `callCount` stays `0`)
- `cleanup()` is safe to call once and idempotent across repeat calls
- The cleanup may be `() => {}` literally or a closure whose internal cleanup list is empty; both shapes satisfy the contract — the observable behavior is the same (see [SPEC.md § Property Descriptor](SPEC.md#property-descriptor) empty-array paragraph). What is NOT acceptable: `bind()` returning `undefined`, throwing, or short-circuiting `isWcBindable` to `false` on the empty-properties case.

---

### 4. Initial sync — explicit `undefined` is delivered

**Setup.** A target whose declared property exists but currently holds `undefined`:

```javascript
class T extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "value", event: "t:value-changed" }],
  };
  // The public class field below creates `value` as an own instance
  // property at construction time (NOT on the prototype). `"value" in target`
  // returns true even though the current value is `undefined`, which is
  // exactly the case the in-operator gate must deliver — distinguishing
  // "the value is undefined" from "the property is not declared on target".
  value = undefined;
}
const target = new T();
const calls = [];
bind(target, (name, value) => { calls.push([name, value]); });
```

**Action.** Inspect `calls` immediately after `bind()` returns (synchronous `syncOn: "call"`).

**Expected.**
- `calls.length === 1`
- `calls[0][0] === "value"`
- `calls[0][1] === undefined` (strictly, not `null`, not a default-substituted value)

This is the rule that distinguishes the `in`-operator gate (mandatory, per spec) from the wrong `!== undefined` gate (silently drops the delivery) — see the design rationale note in [SPEC.md § Appendix](SPEC.md#appendix-design-rationale-notes).

---

### 5. Remote sync — pre-sync `in` returns `false`

**Setup.** Construct a remote proxy against a producer declaration that names `properties: [{ name: "value", ... }]`. Do **not** allow the `sync` response to arrive (e.g. instrument the transport to swallow it, or simply check synchronously before any incoming message has been processed):

```javascript
const proxy = createRemoteCoreProxy(declaration, transport);
// no sync response delivered yet
```

**Action.** Evaluate `"value" in proxy`.

**Expected.** `false`. The `has` trap MUST report the declared name as absent until `sync` arrives. After the producer's `sync` response is processed:
- If the producer sent `value` in its `values` object or `undefinedProperties` list → `"value" in proxy === true`
- If the producer omitted `value` from both → `"value" in proxy === false` (treat as "property not present on the producer", same gate as the local `in`-operator initial-sync rule)

A naive JS-`Proxy`-based implementation that lets `has` fall through to the underlying object will fire a spurious early initial-sync from `bind()` and then re-fire on `sync` arrival, breaking the "exactly one initial sync per property" guarantee. See [SPEC-extensions.md § Consumer-side proxy `has` trap contract](SPEC-extensions.md#consumer-side-proxy-has-trap-contract).

**Scope: properties only.** This vector tests the `has`-trap rule that core's `bind()` depends on, which is defined over declared `properties` names. The rule does NOT extend to declared `inputs` / `commands` names — for those, `N in proxy` is implementation-defined per the "Scope: inputs and commands" note in the linked spec section, and no `bind()`-observable behavior depends on the choice. Test vectors targeting an implementation's `in` behavior for input or command names should branch on the implementation's documented stance, not assume the property-side rule.

---

### 6. Remote undefined — absent `update.value` delivers `undefined`, not `null`

> **⚠ Known divergence in the reference implementation.** `@wc-bindable/remote` 0.7.x does NOT pass this vector as written — its `update`-handling path dispatches `new CustomEvent(eventName, { detail: undefined })`, which WebIDL coerces to `detail: null`, so `bind()` callbacks observe `null` while `proxy.value` correctly reads `undefined`. This is the **only documented divergence** in this CONFORMANCE.md revision — every other vector in the file is satisfied by the reference implementation as of `@wc-bindable/remote` 0.7.x. The divergence is also documented at [SPEC-extensions.md § CustomEvent `detail` and undefined preservation → "Reference implementation status (informative)"](SPEC-extensions.md#customevent-detail-and-undefined-preservation), [SPEC-extensions.md § Implementation-defined behavior](SPEC-extensions.md#implementation-defined-behavior-interop-variability-flag) (the "current implementation, not a complete conformance oracle" paragraph), and the README's remote-path callouts. Third-party implementers writing against the spec contract should treat the spec rule as authoritative and expect a future `@wc-bindable/remote` release to close the gap; consumers running 0.7.x today can read the cached `proxy.<name>` as the producer-intended-`undefined` recovery.

**Setup.** Establish a remote proxy + producer pair through Step 5; let `sync` complete with `value: 1` for `"value"`. Then have the producer send a post-sync transition into `undefined`:

```javascript
// On the wire, producer → consumer:
{ "type": "update", "name": "value" }   // NOTE: no "value" key
```

```javascript
// On the consumer side:
const calls = [];
bind(proxy, (name, value) => { calls.push([name, value]); });
// ... after the update envelope above is delivered to the proxy ...
```

**Action.** Inspect the last entry in `calls`.

**Expected.**
- `calls[calls.length - 1][0] === "value"`
- `calls[calls.length - 1][1] === undefined` — strictly `=== undefined`, NOT `=== null`
- `proxy.value === undefined` (cache and listener delivery agree)

The naive `this.dispatchEvent(new CustomEvent(eventName, { detail: undefined }))` path **fails this vector** because WebIDL coerces `CustomEventInit.detail`'s `undefined` to its declared default `null`. Conformant implementations preserve `undefined` via one of the mitigations in [SPEC-extensions.md § CustomEvent `detail` and undefined preservation](SPEC-extensions.md#customevent-detail-and-undefined-preservation) (sentinel + custom getter; direct listener invocation; or equivalent).

The same vector applies to the initial-sync path via `undefinedProperties` — a property listed in `undefinedProperties` MUST surface as `onUpdate(name, undefined)`, not `null`.

---

### 7. JsonValue — invalid JSON shapes are rejected; symbol-keyed objects are implementation-defined

**Setup.** Two buckets — `NEEDS_REJECT` is unconditional (every conformant implementation MUST reject these); `IMPLEMENTATION_DEFINED` is the symbol-keyed-object opt-out per [SPEC-extensions.md § Implementation-defined behavior](SPEC-extensions.md#implementation-defined-behavior-interop-variability-flag). Test each value with the producer's `isJsonValue(v)` predicate (or the equivalent the implementation exposes) and with `proxy.setWithAck("name", v)` against any declared input named `"name"`:

```javascript
// Bucket 1 — always rejected, regardless of implementation choice.
const NEEDS_REJECT = [
  new Date(),                                                // Date carries a custom prototype
  NaN,                                                       // non-finite number
  Infinity,                                                  // non-finite number
  -Infinity,                                                 // non-finite number
  (() => { const a = [1, , 3]; return a; })(),               // sparse hole at index 1
  (() => {                                                   // accessor (getter) property
    return Object.defineProperty({}, "x", { get: () => 1, enumerable: true });
  })(),
  (() => {                                                   // non-enumerable own string key
    return Object.defineProperty({}, "hidden", { value: 1, enumerable: false });
  })(),
  Object.create({ inherited: 1 }),                           // prototype is neither Object.prototype nor null (the object itself is plain; the prototype object is too — what disqualifies it from JsonValue is that Object.getPrototypeOf(value) is not in { Object.prototype, null })
  new Map([["k", "v"]]),                                     // class instance
  new Set([1, 2]),                                           // class instance
  Symbol("x"),                                               // symbol primitive used as a value
  () => {},                                                  // function
  (() => { const o = {}; o.self = o; return o; })(),         // cyclic
];

// Bucket 2 — symbol-keyed object: a plain object whose OWN keys include a symbol.
// Distinct from `Symbol("x")` above — that is a symbol PRIMITIVE used as a value.
// This case is the documented opt-out point.
const IMPLEMENTATION_DEFINED = [
  (() => {
    const meta = Symbol("meta");
    return { [meta]: "x", visible: true };                   // own symbol key + visible string key
  })(),
];
```

**Action.** For each value `v` in either bucket:
- `isJsonValue(v)` (or equivalent) is called
- `proxy.setWithAck("name", v)` is called (assuming `"name"` is in the declaration's `inputs`)

**Expected — `NEEDS_REJECT`.** Every entry:
- `isJsonValue(v) === false`
- `proxy.setWithAck("name", v)` returns an already-rejected `Promise` (per [SPEC-extensions.md § Design invariants invariant 3](SPEC-extensions.md#extension-2--wire-format-remote-proxying)); no wire message is sent
- `proxy.set("name", v)` (fire-and-forget) MUST throw synchronously **at the `set()` call site** (no silent drop, and crucially: even if the implementation is queueing fire-and-forget `set` calls before `sync` per [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine), validation MUST happen at the call site, not at send time — `set()` returns `void` and deferring validation past the call site removes the caller's only signal that anything went wrong)

**Expected — `IMPLEMENTATION_DEFINED`.** For each entry, the **default normative behavior is rejection** (the implementation behaves identically to a `NEEDS_REJECT` entry). An implementation MAY accept the value, but only if **all** of the following hold:
- The opt-out is **documented in the implementation's public API surface** (per [SPEC-extensions.md § Implementation-defined behavior](SPEC-extensions.md#implementation-defined-behavior-interop-variability-flag))
- The symbol keys are **silently ignored at serialization** — the wire frame for this entry MUST be observationally identical to one carrying just `{ visible: true }` (the symbol key contributes no wire bytes)
- The consumer-side proxy on the other end never observes the symbol key under any circumstance

For an opt-out implementation, the acceptance MUST be uniform across the call surface:
- `proxy.setWithAck("name", v)` MUST resolve normally (no `JsonValue`-validation rejection) and the on-wire `setWithAck` frame MUST omit the symbol key
- `proxy.set("name", v)` (fire-and-forget) MUST NOT throw and the on-wire fire-and-forget frame MUST likewise omit the symbol key
- `isJsonValue(v)` MUST return `true` (otherwise the predicate disagrees with the call-surface behavior, which is itself non-conformant)

Cross-implementation tests targeting symbol-key handling MUST therefore branch on the implementation's documented stance: a strict-rejecting implementation (the default and the reference implementation's choice) treats `IMPLEMENTATION_DEFINED` exactly like `NEEDS_REJECT` on all three call sites; an opt-out implementation accepts on all three and verifies the symbol key did not cross the wire on either of the two `set`-family frames.

A `try { JSON.stringify(v) }` based predicate fails this vector against `NaN`, `Infinity`, and any value containing them — `JSON.stringify` silently coerces them to `null` rather than throwing. See the "JSON.stringify is NOT sufficient validation" paragraph in invariant 3.

---

### 8. Teardown — Nth-listener install throw cleans up the first N-1

**Setup.** A target whose `addEventListener` throws on the Nth call (e.g. via a `Proxy` `get` trap on `addEventListener` that counts and throws), with a declaration whose `properties` has at least N entries:

```javascript
class T extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "a", event: "t:a" },
      { name: "b", event: "t:b" },
      { name: "c", event: "t:c" },  // installation of this listener will throw
      { name: "d", event: "t:d" },
    ],
  };
}
const target = new T();

// Instrument: count installs; throw on the 3rd; track removals.
let installed = 0;
const installedEventNames = [];
const removedEventNames = [];
const realAdd = target.addEventListener.bind(target);
const realRemove = target.removeEventListener.bind(target);
target.addEventListener = (type, ...rest) => {
  installed++;
  if (installed === 3) throw new Error("simulated install failure");
  installedEventNames.push(type);
  realAdd(type, ...rest);
};
target.removeEventListener = (type, ...rest) => {
  removedEventNames.push(type);
  realRemove(type, ...rest);
};
```

**Action.** Call `bind(target, () => {})` and catch the rethrown error.

**Expected.**
- `bind()` rethrows the install-time error (the caller observes it)
- Every listener installed *before* the throw has been removed by the time the rethrow returns control to the caller — i.e. `removedEventNames` contains every entry from `installedEventNames`, in some order, with no leftovers
- The caller never receives a cleanup function from this failed `bind()` call, so the cleanup obligation rests entirely on `bind()` itself (the "MUST tear down every listener and observer it installed earlier in the same `bind()` call before letting the error propagate" rule)

The same vector applies analogously to install-time throws from the synchronous initial-sync step (a property getter that throws on read, an `in` trap that throws, an `onUpdate` callback that throws). See [SPEC.md § Teardown Contract](SPEC.md#teardown-contract).

---

### 9. setWithAck — Promise does NOT resolve before the assignment runs

**Setup.** Instrument the producer side so that the JS-level assignment `core[name] = value` is observable, and so that the `setWithAck` `return` wire envelope can be ordered against it. The simplest way is to have the Core's setter record a timestamp:

```javascript
// Producer side:
class Core extends EventTarget {
  static wcBindable = { ..., inputs: [{ name: "x" }] };
  set x(v) {
    this._x = v;
    this._lastAssignment = performance.now();
  }
  get x() { return this._x; }
}

// Consumer side:
const t0 = performance.now();
await proxy.setWithAck("x", 42);
const tResolve = performance.now();
// Then read `core._lastAssignment` over a side channel (test harness)
const tAssign = core._lastAssignment;
```

**Action.** Compare `tAssign` with `tResolve`.

**Expected.** `tAssign <= tResolve` (i.e. the assignment happens before — or at the same moment as — the consumer-side `await` resolves). Implementations MUST NOT resolve the `setWithAck` `Promise` optimistically (before the wire ack arrives), MUST NOT resolve it on `send()` completion, and MUST NOT resolve it before the producer-side shell has invoked the setter. See [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `setWithAck` row, "The promise MUST NOT resolve before the JS-level assignment …").

**Negative companion.** Have the producer-side setter throw synchronously. The consumer-side `Promise` MUST reject (not resolve, not hang), and the producer MUST emit a `throw` envelope referencing the same `id` (see [SPEC-extensions.md § setWithAck end-to-end](SPEC-extensions.md#setwithack-end-to-end)).

---

### 10. setWithAck legacy — `setAck` absent rejects locally without sending wire traffic

**Setup.** A producer that does NOT advertise `capabilities.setAck` in its `sync` response (or advertises `setAck: false`). Most easily simulated by a producer that simply omits the `capabilities` object entirely:

```javascript
// Producer side: emits this sync response.
const sync = {
  type: "sync",
  values: { url: "/api/default" },
  // capabilities omitted entirely — legacy peer
};
```

**Action.** After the consumer-side proxy has processed the sync response above, call `proxy.setWithAck("url", "/api/users")`. Observe both the returned `Promise` and the wire traffic going out from the consumer to the producer.

**Expected.**
- `proxy.setWithAck("url", "/api/users")` returns an **already-rejected** `Promise` (synchronously) with a clear error describing the capability mismatch
- No id-bearing `set` (no `{ type: "set", name: "url", value: "/api/users", id: "..." }`) message is sent on the wire — the proxy MUST NOT send a message it knows the producer will not handle
- Fire-and-forget `proxy.set("url", "/api/users")` (no id) MUST still work normally — it is unaffected by `setAck` (baseline wire contract, see [SPEC-extensions.md § Message types — server → client](SPEC-extensions.md#message-types--server--client))
- `proxy.invoke("fetch")` MUST still work normally — `setAck` gates `setWithAck` only

**Pre-sync companion.** If `setWithAck` is called *before* the `sync` response arrives, the call MUST queue (not optimistically send) and MUST resolve / reject only after the `sync` response is processed — see [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine).

---

### 11. onUpdate validity — non-function `onUpdate` throws `TypeError` synchronously

> **Pass/fail bar — Level 2 only.** This vector is a hard pass/fail gate for `{2}` (the drop-in `@wc-bindable/core` JS API). A `{1O}` implementation that does not also claim `{2}` SHOULD pass it as written but MAY satisfy the underlying rule with a deferred-detection path that throws on the first `onUpdate` invocation instead — see the "Expected (Level 1O without a Level 2 claim)" section below for what that variant must still guarantee. Failing the Level 2 form against an implementation that claims `{2}` is a concrete conformance bug; the Level 1O-only form is informational and tracked separately.

**Setup.** A perfectly valid bindable target and an `onUpdate` value that is not a function:

```javascript
class T extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "value", event: "t:value-changed" }],
  };
}
const target = new T();

// A second target that is also valid but exposes the empty-properties shape —
// this is the one where a deferred "fail at first dispatch" implementation
// would never trip, and is what makes synchronous detection MUST at Level 2.
class CommandOnly extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [],
    commands:   [{ name: "doThing" }],
  };
}
const commandOnly = new CommandOnly();
```

**Action.** For each of the targets above, call `bind(target, onUpdate)` with each of these `onUpdate` values:

```javascript
const BAD_ON_UPDATES = [undefined, null, "not a function", 42, {}, []];
```

**Expected (Level 2).** Every combination of `(target, onUpdate)` above MUST throw a synchronous `TypeError` at the `bind()` call site, **before any discovery, listener installation, or initial-sync read happens**. The recommended internal shape is a top-of-function `if (typeof onUpdate !== "function") throw new TypeError(...)`.

- The throw MUST happen even for `commandOnly` (the empty-`properties` target) — that is the whole point of the synchronous-throw rule, since a deferred "fail on first dispatch" implementation would silently accept this case forever.
- The throw MUST be observable on the `bind()` call frame (i.e. a `try { bind(...) } catch (e) { ... }` around the call MUST catch it).
- No listener may be left attached on `target` after the throw, and the caller MUST NOT receive a cleanup function.

**Expected (Level 1O without a Level 2 claim).** SHOULD throw synchronously; MAY defer to the first attempted invocation. An implementation that defers MUST still detect the bug at the first `onUpdate` invocation site (so that on a non-empty `properties` target, the initial-sync delivery surfaces the `TypeError`). Implementations that target the Level 2 drop-in API (every JS implementation that exposes itself as `@wc-bindable/core`) MUST use the synchronous form. See [SPEC.md § onUpdate validity](SPEC.md#onupdate-validity).

The hazard is structural: an empty-`properties` target is the only call shape where a deferred-detection implementation can ship for years without ever throwing, so the vector exercises both shapes together.

---

### 12. Hostile discovery — accessors that throw return `undefined`, never propagate

**Setup.** Three targets whose `constructor.wcBindable` walk fails in different places. Each is a separate sub-vector:

```javascript
// Sub-vector A — accessing `constructor.wcBindable` itself throws.
const ctorThatThrows = new Proxy(class {}, {
  get(target, prop) {
    if (prop === "wcBindable") throw new Error("hostile constructor");
    return Reflect.get(target, prop);
  },
});
const targetA = Object.assign(Object.create(EventTarget.prototype), {
  constructor: ctorThatThrows,
  addEventListener() {}, removeEventListener() {},
});

// Sub-vector B — `wcBindable` exists but reading its `protocol` field throws.
class HostileSchema extends EventTarget {
  static wcBindable = Object.defineProperty({
    version: 1,
    properties: [{ name: "v", event: "t:v" }],
  }, "protocol", { get() { throw new Error("hostile getter"); }, enumerable: true });
}
const targetB = new HostileSchema();

// Sub-vector C — null-prototype constructor (no `wcBindable` lookup possible).
const targetC = Object.assign(Object.create(null), {
  addEventListener() {}, removeEventListener() {},
});
```

**Action.** For each `target` in `[targetA, targetB, targetC]`, call `getWcBindableDeclaration(target)`, `isWcBindable(target)`, and `bind(target, () => {})`.

**Expected.** For every sub-vector:
- `getWcBindableDeclaration(target) === undefined` (no exception propagates)
- `isWcBindable(target) === false`
- `bind(target, () => {})` returns the non-bindable `() => {}` no-op cleanup; no listeners are installed (the hostile target never sees `addEventListener` called by the adapter)
- No error reaches the test harness from any of the three calls — the helpers internalize every throw

The discovery helper MUST wrap its entire validation body in a single `try / catch` (or equivalent guard) so that any access failure funnels to `return undefined`. Conformant implementations also snapshot each Schema-typed field into a local on first read within a validator function so the uniqueness gate cannot fall out of step with the type checks that share it — see [SPEC.md § Trust Boundaries](SPEC.md#trust-boundaries) → "Discovery itself touches the target." for the rationale and the explicit non-extension of that snapshotting across the validator → `bind()` pipeline.

---

### 13. Deferred initial sync — pre-connection events deliver before the deferred sync

**Setup.** A bindable custom element that has been constructed but **not** yet appended to a document. Use `syncOn: "connect"`.

> **Applicability of this vector.** A **general-purpose browser JS implementation claiming `{1O}` SHOULD NOT skip this vector merely by ignoring `syncOn: "connect"`.** SPEC.md § Conformance Levels explicitly lists "the `in`-operator initial-sync rule with its `syncOn` modes" as part of `{1O}`, so silently no-oping on `"connect"` while otherwise claiming `{1O}` is a documentation gap, not a skip reason.
>
> Skipping is appropriate only under the spec-defined fallback conditions in [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection):
> - **Non-browser runtime** where `HTMLElement` / `document` / `MutationObserver` are undefined (the deferred path's `typeof` guard short-circuits to `"call"`).
> - **Non-`HTMLElement` target** — a headless `EventTarget` subclass, a synthetic proxy, an already-connected element. The vector specifically tests the not-yet-connected `HTMLElement` path.
> - **Explicitly scoped implementation profile** that documents non-support of browser DOM deferred-sync (e.g. "this is a server-only / Node-only consumer-side implementation; `syncOn: "connect"` is rejected with a clear error or ignored, and that scope is documented in the public API surface"). General-purpose `{1O}` implementations cannot use this carve-out.
>
> The unknown-`syncOn` fallback (an unrecognized string value collapsing to `"call"`) is **not** a valid skip reason — the caller here is passing the literal `"connect"`. A browser-runtime `{1O}` implementation that supports `syncOn: "connect"` against `HTMLElement` targets MUST pass this vector.

```javascript
class T extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "value", event: "t:value-changed" }],
  };
  set value(v) {
    this._value = v;
    this.dispatchEvent(new CustomEvent("t:value-changed", { detail: v }));
  }
  get value() { return this._value; }
}

// Use a unique tag name per harness invocation. `customElements.define`
// is process-global and throws on a duplicate definition, so a watch-mode
// or repeated-run harness MUST NOT reuse a static tag literal.
//
// `crypto.randomUUID()` is the cleanest unique-id source on modern
// browsers and Node 19+, but is not universally available — JSDOM
// before v22, Node before 19, and some older browser versions lack it.
// A fallback that works everywhere with no dependencies:
//
//   const tag = `t-deferred-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
//
// or use the harness's preferred unique-id source. The protocol does
// not care which one you pick — the only requirement is that the tag
// is unique within the lifetime of the test process.
const tag = `t-deferred-sync-${crypto.randomUUID()}`;
customElements.define(tag, T);
const target = document.createElement(tag);
target.value = "initial";  // setter records _value, but no listener is attached yet

const calls = [];
const unbind = bind(target, (name, value) => { calls.push([name, value]); }, { syncOn: "connect" });
```

**Action.** Mutate the property via its setter on the still-unconnected target (which both updates `_value` *and* dispatches the change event in the same call), then append it to the document, then let the `MutationObserver` microtask run:

```javascript
target.value = "between-bind-and-connect";
document.body.appendChild(target);
// Wait until the next macrotask so the MutationObserver callback has
// definitely fired. `MutationObserver` callbacks are microtasks, so a
// single `await Promise.resolve()` suffices in theory — but harnesses
// that re-queue microtasks during the callback (test runners, polyfills,
// some JSDOM versions) can need more than one turn. A macrotask wait is
// strictly later than any pending microtask queue and avoids the
// timing-sensitive flake that a microtask-only wait can produce on some
// environments.
//
// Often-sufficient two-microtask form: `await Promise.resolve();
// await Promise.resolve();`. This is not strictly equivalent — a polyfill
// or test runner that re-queues microtasks during the callback can still
// need more than two turns — but in practice it covers the common cases
// and has the advantage of working unchanged under fake timers.
//
// If the harness uses fake timers (Vitest `vi.useFakeTimers()`, Jest
// `jest.useFakeTimers()`, Sinon `useFakeTimers`), this `setTimeout` will
// not fire on its own — advance the clock by one macrotask after the
// `appendChild` (e.g. `await vi.advanceTimersByTimeAsync(0)` /
// `jest.advanceTimersByTime(0)`) or temporarily exit fake-timer mode
// for this wait. The two-microtask form above is a fake-timer-friendly
// alternative in many harnesses, with the strictness caveat noted there.
await new Promise((resolve) => setTimeout(resolve, 0));
```

**Expected.**
- `calls.length === 2`
- `calls[0]` corresponds to the pre-connection event the setter dispatched: `["value", "between-bind-and-connect"]`
- `calls[1]` corresponds to the deferred initial sync, which reads `target.value` **at sync time**: `["value", "between-bind-and-connect"]` as well — the setter ran before connection, so the getter sees the post-mutation value when the deferred sync finally reads it
- The deferred initial sync runs **after** the pre-connection event, not before — implementations that fire the initial sync first violate the ordering rule

> **Why a property-setter mutation, not a bare `dispatchEvent`.** A bare `target.dispatchEvent(new CustomEvent("t:value-changed", { detail: X }))` would deliver `X` to `calls[0]` *but leave `_value` untouched*, so the deferred-sync read at `calls[1]` would observe the pre-bind `"initial"` instead of `X`. The vector exercises the spec's intended scenario where a producer-side state change is what raced ahead of connection, and the routing rule is "the event is delivered first; the deferred sync's later property-read wins for `calls[1]`". If you want to test the bare-`dispatchEvent` case explicitly, the expected `calls[1]` is `["value", "initial"]`, not `["value", X]` — the divergence between the event payload and the deferred read is precisely the inverse of `syncOn: "call"`'s "event payload is authoritative" rule.

The deferred-sync read winning over a (hypothetical) divergent pre-connection event payload is the **opposite** of the call-mode "event payload is authoritative" rule, and is intentional — see [SPEC.md § Initial Value Synchronization → Ordering vs subsequent events](SPEC.md#ordering-vs-subsequent-events). Producers that need event-payload-wins semantics on an unconnected target MUST use `syncOn: "call"` from a host lifecycle hook.

---

### 14. Teardown — a cleanup callback that throws does NOT abort the remaining cleanups

**Setup.** A bindable target with at least three declared properties; instrument `removeEventListener` so the **first** invocation throws but the rest succeed:

```javascript
class T extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "a", event: "t:a" },
      { name: "b", event: "t:b" },
      { name: "c", event: "t:c" },
    ],
  };
}
const target = new T();

// Track every successful removal.
let removedCount = 0;
const removedEventNames = [];
const realRemove = target.removeEventListener.bind(target);
let firstRemoveSeen = false;
target.removeEventListener = (type, ...rest) => {
  if (!firstRemoveSeen) {
    firstRemoveSeen = true;
    throw new Error("simulated cleanup failure on the first listener removed");
  }
  removedCount++;
  removedEventNames.push(type);
  realRemove(type, ...rest);
};

const unbind = bind(target, () => {});
```

**Action.** Call `unbind()` and observe both the thrown error (if any) and the removal tally.

**Expected.**
- `removedCount === 2` (the two listeners after the first one were all torn down despite the first removal throwing)
- The set `removedEventNames` covers the two events for which removal succeeded; the order matches the registration order minus the failing one
- The `unbind()` call MUST NOT propagate the cleanup-time error to the caller — secondary errors are swallowed per the "more confusing than useful" rule in [SPEC.md § Teardown Contract](SPEC.md#teardown-contract)
- A second `unbind()` call MUST be a safe no-op (the closure-level `disposed` re-entry guard is set on first invocation regardless of which individual cleanups threw)

> **The listener whose `removeEventListener` threw may remain attached on `target` after `unbind()` returns** — the adapter cannot force a hostile removal to succeed, and the spec does not require it to. The conformance requirement this vector tests is that **the failure does not abort the remaining cleanup callbacks** and does not propagate from `unbind()`; a leaked listener whose removal threw is acceptable collateral damage, not a vector failure. Test harnesses that assert "every listener is removed" against a hostile target are testing a stricter rule than the spec; the assertion to make instead is on `removedCount` for the *non-failing* removals plus the absence of a propagated throw.

The same shape applies to a throwing `MutationObserver.disconnect()` under `syncOn: "connect"` — the adapter MUST still tear down its event listeners.

---

### 15. Reserved names — `@wc-bindable/` prefix rejects at proxy / shell construction

**Setup.** Three declarations, each placing the reserved prefix on a different facet:

```javascript
const RESERVED_PROPERTIES = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "@wc-bindable/value", event: "t:value-changed" }],
};

const RESERVED_INPUTS = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "value", event: "t:value-changed" }],
  inputs:     [{ name: "@wc-bindable/url" }],
};

const RESERVED_COMMANDS = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "value", event: "t:value-changed" }],
  commands:   [{ name: "@wc-bindable/dispose" }],
};
```

**Action.** For each declaration, attempt both ends of the wire:
- **Consumer side.** Construct the implementation's consumer-side remote proxy with the declaration and a recording transport (a stub that records every outbound send).
- **Producer side.** Construct the implementation's producer-side remote shell with a core that exposes the declaration as `constructor.wcBindable` and the same kind of recording transport.

> The protocol pins the wire-level method names (`set`, `setWithAck`, `invoke`, the message `type` discriminator) as normative but does **not** pin the JavaScript factory names third-party implementations must use to construct the proxy / shell — see [SPEC-extensions.md § Extension 2](SPEC-extensions.md#extension-2--wire-format-remote-proxying). Third-party implementers should target the abstract construction step above; only the *behavior* (synchronous throw, zero outbound messages) is normative. For the reference implementation, these are `createRemoteCoreProxy(declaration, transport)` on the consumer side and `new RemoteShellProxy(coreWithDecl, transport)` on the producer side.

**Expected.** For every declaration and every side:
- Construction MUST throw synchronously with an error that names the reserved prefix (or otherwise clearly identifies the rejection reason); the call site sees the throw on its own frame
- No reference to the constructed proxy / shell is returned to the caller — the failure is total
- The transport stub MUST observe **zero** outbound messages — rejection happens at construction, before any `sync` request is sent
- If the consumer-side proxy somehow advances past construction (non-conformant), the producer's per-message reserved-name gate MUST still reject any wire frame whose `name` is reserved; this is the defense-in-depth check called out in [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) and the producer-side dispatcher footnote

The reserved-name rule pins **only** the `@wc-bindable/` prefix as cross-implementation; implementations MAY reserve additional names (e.g. `__proto__`, vendor prefixes) and MUST document those additions in their public API. Cross-implementation vectors that target the implementation-specific extras MUST branch on the implementation's documented list — only the `@wc-bindable/` prefix is portable.

---

## What this list does NOT cover

These vectors are deliberately narrow — they target rules that are easy to violate in ways that pass naive smoke tests. They are **not** a complete conformance suite. Additional areas worth covering in a richer test corpus:

- **Shadow-DOM attach** under `syncOn: "connect"` (the documented "observer doesn't traverse shadow roots" limitation)
- **Re-entrant `dispatchEvent` from a property getter** during initial sync (the producer-side MUST NOT rule)
- **`AbortSignal` pre-aborted at `setWithAckOptions` / `invokeWithOptions` call time** (rejects immediately without sending)
- **Late `return` / `throw` envelope after timeout / abort** (consumer MUST drop, MUST NOT re-settle)
- **Declaration fingerprint mismatch** on `sync` (MUST log warn, MUST continue accepting)
- **`getterFailures` semantics** — MUST log, MUST NOT touch cache, MUST NOT dispatch
- **`MutationObserver` callback after host detach** under `syncOn: "connect"` (observer rechecks `isConnected`, stays armed)

Implementations targeting full conformance should grow their own test suite to cover at minimum the items above; the in-tree tests under `packages/core/tests/` and `packages/remote/tests/` cover much of this space and can be used as a starting reference.

Contributions that expand this file with additional canonical vectors are welcome — the test-vector format above (Setup → Action → Expected → Spec reference) is the template.
