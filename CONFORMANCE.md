# wc-bindable-protocol Conformance Test Vectors

> **Authoritative scope of this document.** CONFORMANCE.md is the **authoritative source for the runnable starter test vectors** — concrete Setup → Action → Expected → Spec-reference cases that any third-party implementation should reproduce. It is **necessary but not sufficient** for conformance: the test cases here are a curated subset of the rules defined in [SPEC.md](SPEC.md) and [SPEC-extensions.md](SPEC-extensions.md), and those documents remain authoritative on the rules themselves. Where a vector below disagrees with the linked spec section, the spec section is authoritative — file an issue against this document.

This file is a **starter set** of test vectors for implementations of `@wc-bindable/core` and/or `@wc-bindable/remote`. The list is intentionally short — it covers the rules that are easy to get wrong in ways that compile, pass naive tests, and only surface under specific runtime patterns.

**Scoping rule.** Each vector applies to one or more of the conformance claims defined in [SPEC.md § Conformance Levels](SPEC.md#conformance-levels). Implementations are expected to pass **every vector applicable to the level and role they claim** — not every vector in the file. A Level 2 core implementation should pass the core / local-observation vectors and is not obligated to pass remote / wire vectors. An Extension 2 remote consumer-side proxy should pass the consumer-side wire vectors and the local 1O bind-target vectors its proxy supports; a producer-side remote shell should pass the producer-side wire vectors and the local 1P vectors for the target it exposes. The "Applies to" column on each row identifies the claim it tests, using the facet-annotated shorthand from SPEC.md § Conformance Levels (`{1O, 2}`, `{1P, 3-producer}`, etc.).

Passing every applicable vector is **necessary but not sufficient** for full conformance; failing any indicates a concrete bug that [SPEC.md](SPEC.md) or [SPEC-extensions.md](SPEC-extensions.md) calls out in prose.

Each vector below is structured the same way: **Setup → Action → Expected → Spec reference**. The spec reference is authoritative; the vector here exists to give implementers a runnable target.

> The vector descriptions are framework-agnostic JavaScript pseudocode. Concrete TypeScript tests for the reference implementation live under [`packages/core/tests/`](packages/core/tests/) and [`packages/remote/tests/`](packages/remote/tests/); reading those gives the in-tree shape, but this file is what a third-party reimplementer reads first.

## Summary

The "Applies to" column uses the facet shorthand from [SPEC.md § Conformance Levels](SPEC.md#conformance-levels) — `{1O, 2}` means "Level 1 observer facet + Level 2"; `{3-consumer}` means the consumer-side of an Extension 2 implementation; `{3-producer}` is the producer-side shell; `{3-both}` is an implementation that ships both sides. `{1O}` standalone means any 1O-claiming implementation regardless of higher levels.

| # | Area | Applies to | Test case | Spec section |
|---|---|---|---|---|
| 1 | Discovery | `{1O, 2}` (and `{3-consumer}` / `{3-both}` for the proxy's local bindable declaration exposed to core `bind()` — i.e. the wrapper's own `constructor.wcBindable`, per [SPEC.md § Discovery Contract](SPEC.md#discovery-contract)) | Duplicate property names invalidate the declaration | [SPEC.md § Property Descriptor](SPEC.md#property-descriptor) |
| 2 | Discovery | `{1O, 2}` (and `{3-consumer}` / `{3-both}` for the proxy's local bindable declaration exposed to core `bind()` — i.e. the wrapper's own `constructor.wcBindable`, per [SPEC.md § Discovery Contract](SPEC.md#discovery-contract)) | Malformed `inputs[].attribute` (non-string) invalidates the declaration | [SPEC.md § Input Descriptor](SPEC.md#input-descriptor) |
| 3 | Empty properties | `{1O, 2}` (and any 1O-claiming bind implementation) | `properties: []` → `bind()` succeeds, installs no listeners, returns a valid no-op cleanup | [SPEC.md § Property Descriptor](SPEC.md#property-descriptor) (empty-array case) |
| 4 | Initial sync | `{1O}` (any 1O-claiming bind implementation, including `{1O, 2}` and `{3-consumer}` proxies that expose `bind()`-equivalent semantics to local consumers) | A property whose current value is `undefined` is still delivered as `onUpdate(name, undefined)` on initial sync | [SPEC.md § Initial Value Synchronization](SPEC.md#initial-value-synchronization) |
| 5 | Remote sync | `{3-consumer}` and `{3-both}` | Before the `sync` response, `name in proxy === false` for declared names | [SPEC-extensions.md § Consumer-side proxy `has` trap contract](SPEC-extensions.md#consumer-side-proxy-has-trap-contract) |
| 6 | Remote undefined | `{3-consumer}` and `{3-both}` | An `update` envelope with no `value` key produces `onUpdate(name, undefined)` — **not** `null` | [SPEC-extensions.md § Update envelope value field](SPEC-extensions.md#update-envelope-value-field) + [§ CustomEvent `detail` and undefined preservation](SPEC-extensions.md#customevent-detail-and-undefined-preservation) |
| 7 | JsonValue | `{3-consumer}` and `{3-producer}` (and `{3-both}`) — every side that serializes payloads to the wire | `Date`, `NaN`, sparse-hole arrays, accessor-property objects are rejected by `JsonValue` validation | [SPEC-extensions.md § Design invariants → invariant 3](SPEC-extensions.md#extension-2--wire-format-remote-proxying) |
| 8 | Teardown | `{1O, 2}` (and any other 1O implementation that hands a cleanup function back to the caller) | If `addEventListener` throws on the Nth listener install, the previous N-1 listeners MUST be removed before the throw propagates | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) |
| 9 | setWithAck | `{3-both}` end-to-end; producer-side semantics tested on `{3-producer}`, consumer-side semantics tested on `{3-consumer}` | The returned `Promise` MUST NOT resolve before the JS-level assignment `target[name] = value` has executed on the producer side | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `setWithAck` row) + [§ setWithAck end-to-end](SPEC-extensions.md#setwithack-end-to-end) |
| 10 | setWithAck legacy | `{3-consumer}` and `{3-both}` (the consumer-side rejection rule is what is tested; producer side participates only as a stub that omits `setAck`) | If the producer's `sync` response omits / sets-false `capabilities.setAck`, `setWithAck` MUST return an already-rejected `Promise` and MUST NOT send an id-bearing `set` on the wire | [SPEC-extensions.md § Message types — server → client](SPEC-extensions.md#message-types--server--client) (setAck capability bullets) + [§ Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) |

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

---

### 6. Remote undefined — absent `update.value` delivers `undefined`, not `null`

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

### 7. JsonValue — Date, NaN, sparse arrays, accessor properties are rejected

**Setup.** For each of the inputs below, call the producer's `isJsonValue(v)` predicate (or the equivalent the implementation exposes) **and** call `proxy.setWithAck("name", v)` against any declared input named `"name"`:

```javascript
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
  Object.create({ inherited: 1 }),                           // non-plain prototype
  new Map([["k", "v"]]),                                     // class instance
  new Set([1, 2]),                                           // class instance
  Symbol("x"),                                               // symbol
  () => {},                                                  // function
  (() => { const o = {}; o.self = o; return o; })(),         // cyclic
];
```

**Action.** For each value `v`:
- `isJsonValue(v)` (or equivalent) is called
- `proxy.setWithAck("name", v)` is called (assuming `"name"` is in the declaration's `inputs`)

**Expected.** Every entry:
- `isJsonValue(v) === false`
- `proxy.setWithAck("name", v)` returns an already-rejected `Promise` (per [SPEC-extensions.md § Design invariants invariant 3](SPEC-extensions.md#extension-2--wire-format-remote-proxying)); no wire message is sent
- `proxy.set("name", v)` (fire-and-forget) MUST throw synchronously (no silent drop; the caller has no other channel to learn about the validation failure)

A `try { JSON.stringify(v) }` based predicate fails this vector against `NaN`, `Infinity`, and any value containing them — `JSON.stringify` silently coerces them to `null` rather than throwing. See the "JSON.stringify is NOT sufficient validation" paragraph in invariant 3.

Symbol-keyed objects are the **one** vector here with a documented opt-out (see [SPEC-extensions.md § Implementation-defined behavior](SPEC-extensions.md#implementation-defined-behavior-interop-variability-flag)); a conformant implementation may either reject them (default normative behavior) or silently ignore the symbol keys, but MUST document its choice. Cross-impl test vectors targeting symbol-key handling should branch on the implementation's documented stance.

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

## What this list does NOT cover

These ten vectors are deliberately narrow — they target rules that are easy to violate in ways that pass naive smoke tests. They are **not** a complete conformance suite. Additional areas worth covering in a richer test corpus:

- **`syncOn: "connect"` deferred-sync ordering** (events that arrive between bind and connection)
- **Shadow-DOM attach** under `syncOn: "connect"` (the documented "observer doesn't traverse shadow roots" limitation)
- **Re-entrant `dispatchEvent` from a property getter** during initial sync (the producer-side MUST NOT rule)
- **`AbortSignal` pre-aborted at `setWithAckOptions` / `invokeWithOptions` call time** (rejects immediately without sending)
- **Late `return` / `throw` envelope after timeout / abort** (consumer MUST drop, MUST NOT re-settle)
- **Reserved-name declarations** at proxy construction (MUST throw)
- **Declaration fingerprint mismatch** on `sync` (MUST log warn, MUST continue accepting)
- **`getterFailures` semantics** — MUST log, MUST NOT touch cache, MUST NOT dispatch
- **Cleanup-callback that itself throws** during the consumer-invoked unbind (other cleanups MUST still run)
- **`MutationObserver` callback after host detach** under `syncOn: "connect"` (observer rechecks `isConnected`, stays armed)

Implementations targeting full conformance should grow their own test suite to cover at minimum the items above; the in-tree tests under `packages/core/tests/` and `packages/remote/tests/` cover much of this space and can be used as a starting reference.

Contributions that expand this file with additional canonical vectors are welcome — the test-vector format above (Setup → Action → Expected → Spec reference) is the template.
