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
| 16 | Queue not transactional | `{3-consumer}` and `{3-both}` | A queued `setWithAck` whose settlement rejects does NOT cancel a queued `invoke` issued after it. **FIFO ordering preserves order, not dependency** — a failed queued entry does not auto-cancel later entries; each settles per its own rules | [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) ("Queue ordering is not transactional") |
| 17 | `set` pre-sync queue | `{3-consumer}` and `{3-both}` | Pre-sync fire-and-forget `set` SHOULD queue with id-bearing calls so caller order is preserved across mixed traffic (default profile). A low-latency-profile implementation MAY send `set` immediately and MUST document the choice in its public API surface. Both profiles MUST throw synchronously from `set()` on declared-name / JsonValue validation failure | [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) (`set` row) |
| 18 | Late envelope drop | `{3-consumer}` and `{3-both}` | A `return` / `throw` envelope arriving for an `id` whose pending entry has already timed out or been aborted MUST be silently dropped (with SHOULD warn-log); the consumer `Promise` MUST NOT re-settle | [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) |
| 19 | Re-entrant getter dispatch | `{1O}` (any 1O-claiming bind implementation observing a non-conformant producer) | A producer-side property getter that synchronously dispatches its declared change event during initial sync produces a double `onUpdate` (dispatch-first, sync-second). The adapter MUST faithfully deliver both calls in that order; deduplication / detection / repair is NOT the adapter's job — the producer MUST NOT cause the re-entry | [SPEC.md § Event detail vs Property Read](SPEC.md#event-detail-vs-property-read) (producer-side rule) + [§ Producer Obligations](SPEC.md#producer-obligations) |
| 20 | Reserved prototype-pollution names | `{3-consumer}` and `{3-producer}` (and `{3-both}`) | A declaration containing a `properties` / `inputs` / `commands` `name` exactly equal to `"__proto__"`, `"constructor"`, or `"prototype"` MUST cause the consumer-side proxy constructor and the producer-side shell constructor to throw synchronously with a clear error; no wire traffic MUST be sent for such a name. The same rule as the `@wc-bindable/` prefix vector (#15), applied to the second normative reserved-name rule | [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) (rule 2) |
| 21 | Duplicate pending `id` rejection | `{3-producer}` and `{3-both}` | If the producer receives a `cmd` or id-bearing `set` whose `id` matches a pending entry (return/throw not yet emitted), the producer MUST NOT execute the later message and **MUST NOT emit a `return` / `throw` envelope carrying the duplicate `id` as the response to the later message** (the wire `id` would be ambiguous and a conformant consumer would settle the original call against it). Two conformant producer responses, with different effects on the original pending entry: (a) **log + drop path** — keep the first pending entry untouched (MUST NOT cancel, reject, or otherwise settle it; the original call continues to its natural settlement); silently drop the later duplicate-`id` message. (b) **TerminalFailure path** — transition the channel to TerminalFailure with a synthetic `WC_BINDABLE_DUPLICATE_ID` reason; as part of standard channel teardown the producer MAY reject every outstanding pending entry (including the original whose `id` was duplicated). Neither path emits a wire `return` / `throw` carrying the duplicate `id` as the later message's reply | [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id-constraints bullet) |
| 22 | Empty-string `id` rejection | `{3-producer}` and `{3-both}` | An inbound `cmd` or id-bearing `set` whose `id` is `""` (or any non-string) MUST be treated as malformed. The producer MUST log + drop (no `throw` reply is reachable, since no conformant consumer allocates `""` to await on) and MUST NOT touch the Core | [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id-constraints bullet, first sub-bullet) |
| 23 | Malformed `sync` ⇒ terminal | `{3-consumer}` and `{3-both}` | A malformed `sync` response (missing `values`, type-mismatched fields) MUST cause the consumer-side proxy to settle every queued pending entry as Rejected in caller order with a `WC_BINDABLE_PROTOCOL_ERROR`-coded error, transition to TerminalFailure, and signal the transport to dispose. This is the one consumer-side path where a single malformed envelope escalates to teardown | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| 24 | Malformed `return`/`throw` ⇒ drop or per-entry reject | `{3-consumer}` and `{3-both}` | A malformed `return` or `throw` envelope MUST NOT close the transport. If the `id` field is well-formed AND matches a pending entry, the proxy MUST reject that entry with a `WC_BINDABLE_PROTOCOL_ERROR`-coded synthetic error built locally (NOT pass-through the malformed `error` object). Otherwise drop + warn-log | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| 25 | `update.value` absence via key-presence | `{3-consumer}` and `{3-both}` | The consumer-side proxy MUST distinguish "the `value` key is absent" from "the `value` key is present and holds `undefined`" via key-presence check (`Object.hasOwn(msg, "value")`), not via `msg.value === undefined`. The two are equivalent post-`JSON.parse` but the spec contract is key-presence, not value comparison — implementations that use `=== undefined` are non-conformant against non-`JSON.parse` boundaries (in-process test harnesses, hand-rolled envelopes) | [SPEC-extensions.md § Update envelope value field](SPEC-extensions.md#update-envelope-value-field) (hasOwn rule) |
| 26 | Transport at-most-once delivery | Any transport adapter packaged with `{3-consumer}` / `{3-producer}` / `{3-both}` | A conformant transport adapter MUST deliver each accepted `send(message)` to the peer's `onMessage` at most once. Adapters built on a medium that may duplicate frames MUST either de-duplicate at the adapter boundary (e.g. via a per-frame sequence number the adapter strips before invoking `onMessage`) or treat any observed duplication as a terminal transport failure (`onClose` fires; subsequent traffic dropped). Test by injecting a duplicate frame at the adapter's underlying medium and asserting one of the two behaviors; silent double-delivery to `onMessage` is non-conformant. **For transports whose underlying medium cannot duplicate frames under test** (a strict in-process mock, WebSocket-over-TCP with no proxy in front of it, single-`MessagePort` peer-to-peer), the duplicate-injection setup is not reachable and the vector MAY be satisfied by inspecting the adapter's `send` / `onMessage` paths and asserting it contains no retry / replay code path that can call `onMessage` twice for one accepted `send()` — i.e. the at-most-once property holds by construction rather than by runtime defense. Implementations SHOULD document which of the two satisfaction modes their adapter uses | [SPEC-extensions.md § Transport adapter contract](SPEC-extensions.md#transport-adapter-contract) (invariant 7) |
| 27 | `dispose()` rejects pending in caller order; late envelopes dropped | `{3-consumer}` and `{3-both}` | `dispose()` MUST reject every pending `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` entry in **caller order** (FIFO across the pending table) before returning. Any subsequent inbound `return` / `throw` envelope referencing one of the already-rejected `id`s MUST be silently dropped (SHOULD warn-log) — the consumer `Promise` MUST NOT re-settle. `set()` after `dispose()` MUST throw synchronously; `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` after `dispose()` MUST return an already-rejected `Promise`. `dispose()` itself MUST be idempotent (safely re-callable as a no-op) | [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods) + [§ Pending-call lifecycle](SPEC-extensions.md#pending-call-lifecycle-setwithack--setwithackoptions--invoke--invokewithoptions) + [§ AckOptions](SPEC-extensions.md#ackoptions) |
| 28 | `reconnect()` after TerminalFailure: fresh `sync`; old pending NOT replayed | `{3-consumer}` and `{3-both}` that ship `reconnect()` (OPTIONAL per [§ Lifecycle methods](SPEC-extensions.md#lifecycle-methods); implementations that omit `reconnect` are conformant and this vector is N/A) | After the channel enters TerminalFailure, every pending entry MUST have been rejected (per vector 27's drain rule applied to TerminalFailure). On `reconnect(transport)` with a fresh transport, the proxy MUST send a new `{ "type": "sync" }` envelope and MUST NOT replay any of the previously-rejected pending messages on the new transport. `reconnect()` MUST throw synchronously when the proxy is already disposed OR when the existing transport is still active (re-attaching to a healthy connection is a programmer error) | [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods) (reconnect row) + [§ Remote proxy lifecycle](SPEC-extensions.md#remote-proxy-lifecycle) (TerminalFailure → Reconnecting → PreSync) |
| 29 | Cache validity across TerminalFailure / Reconnecting | `{3-consumer}` and `{3-both}` | During TransientFailure, TerminalFailure, and Reconnecting (before the next `sync` response arrives), the per-property cache MUST be preserved as last-known-value: `proxy.<N>` reads the same value it returned before the lifecycle transition, and `N in proxy` stays `true` for `N` that was cached before the transition. The proxy MUST NOT zero / clear / mark-stale the cache merely because the transport state changed. The new `sync` response (after reconnect) re-applies the [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode) rules diff-style: `N` now present in `values` / `undefinedProperties` updates the cache and re-fires `onUpdate`; `N` now omitted from both (and not in `getterFailures`) removes the cache entry and flips `has` back to `false` without dispatching a synthetic removal event | [SPEC-extensions.md § Cache validity across transport lifecycle](SPEC-extensions.md#cache-validity-across-transport-lifecycle) |
| 30 | Locally-synthesized errors MUST carry `code` | `{3-consumer}` and `{3-both}` (consumer-side synthetic errors); `{3-producer}` and `{3-both}` (producer-side `throw` envelope emission for locally-synthesized failures) | Every locally-synthesized protocol error reaching the consumer's `catch` MUST carry `error.code` drawn from the registry in [SPEC-extensions.md § Error envelope → Machine-readable code field](SPEC-extensions.md#error-envelope). Concretely test: (a) `setWithAckOptions(name, value, { timeoutMs: 1 })` against an unresponsive producer rejects with `error.code === "WC_BINDABLE_TIMEOUT"`; (b) `invokeWithOptions(name, args, { signal })` aborted after send rejects with `error.code === "WC_BINDABLE_ABORTED"`; (c) `setWithAck(name, new Date())` (or any non-`JsonValue`) rejects with `error.code === "WC_BINDABLE_INVALID_JSON_VALUE"`; (d) malformed inbound `sync` (per vector 23) drains pending with `error.code === "WC_BINDABLE_PROTOCOL_ERROR"`. Application throws from the producer's command / setter (canonical example: `target.fetch()` throws a `RangeError`) MAY omit `code` or carry `WC_BINDABLE_REMOTE_THROW` — application throws MUST NOT repurpose any other registered `WC_BINDABLE_*` code | [SPEC-extensions.md § Error envelope → Producer-side code-emission rule](SPEC-extensions.md#error-envelope) (origin-conditional MUST / MAY) |
| 31 | `getterFailures` does NOT touch cache; subsequent `update` recovers | `{3-consumer}` and `{3-both}` | Setup: producer's first `sync` response includes `values: { v: 42 }` and `capabilities: { setAck: true, getterFailures: true }`. After consumer caches `v === 42`, force a re-sync (via reconnect or a producer-issued fresh `sync`) whose response carries `values: {}` and `getterFailures: ["v"]`. Expected: (a) `proxy.v === 42` is preserved (cache NOT reverted to `undefined`); (b) no `onUpdate` event is dispatched for `v` as part of the failed-getter sync; (c) the consumer logger receives a warn-level message naming `v`; (d) a subsequent `{ type: "update", name: "v", value: 99 }` from the producer normally updates the cache to `99` and dispatches `onUpdate("v", 99)` — the getter failure does NOT permanently taint the property | [SPEC-extensions.md § `getterFailures` semantics](SPEC-extensions.md#getterfailures-semantics) + [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode) |
| 32 | Malformed `update` drops + warns; transport stays open; next valid `update` processed | `{3-consumer}` and `{3-both}` | Inject a malformed `update` envelope (missing `name`, non-string `name`, or present `value` that fails `JsonValue` deep validation). Expected: (a) the proxy does NOT throw, does NOT close the transport, and does NOT write the cache for the property whose `name` was malformed (if any); (b) the consumer's `bind()` callback receives NO event for the malformed envelope; (c) the proxy logger receives a warn-level entry naming the field that failed; (d) a subsequent well-formed `{ type: "update", name: "value", value: "ok" }` envelope is processed normally — the cache updates, `onUpdate("value", "ok")` fires. This is the asymmetry from vector 23: malformed `sync` escalates to TerminalFailure, malformed `update` degrades gracefully | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) (malformed `update` row) |
| 33 | Deferred initial-sync throw — `unbind()` is a literal no-op afterward | `{1O}` for general-purpose browser JS implementations that support `syncOn: "connect"` (skip applies under the same conditions as vector 13) | A `syncOn: "connect"` bind where the deferred initial-sync throws (e.g. a property getter throws on read inside the `MutationObserver` microtask). Expected: (a) the adapter's installed cleanups (listeners + the `MutationObserver`) MUST be torn down before the throw escapes the microtask; (b) the throw surfaces as an uncaught error on the dispatching microtask (`window.onerror` / `reportError` / `process.on('uncaughtException')`), NOT as a synchronous throw from the original `bind()` call frame; (c) the `unbind` function the caller received at `bind()` time MUST still be safe to invoke after the throw — calling `unbind()` MUST be a literal no-op (the closure-level `disposed` re-entry guard was set by the cleanup-on-throw path); (d) the `unbind()` call MUST NOT re-walk the cleanup list, MUST NOT throw, MUST NOT trigger any further uncaught error | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) (the "If a deferred initial-sync (`syncOn: \"connect\"`) throws" paragraph) + [§ bind() state machine summary](SPEC.md#bind-state-machine-summary) (InitialSyncing → Disposed via deferred throw) |
| 34 | `set()` — sync throw on terminal, no throw on transient outage | `{3-consumer}` and `{3-both}` — the line between terminal and transient is transport-implementation-defined per [SPEC-extensions.md § Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2); the canonical vector uses a controllable mock transport that lets the test force each state explicitly | Setup: a mock transport with explicit `setTerminal()` / `setTransient()` hooks. Bring the proxy to Active. Expected — terminal path: after `mockTransport.setTerminal()` (e.g. emit `onClose` and refuse to accept further `send()`), `proxy.set("x", 1)` MUST throw synchronously at the call site with a clear terminal-failure error. Expected — transient path: after `mockTransport.setTransient()` (the transport's own reconnect/backoff layer is masking an outage; the proxy has NOT been notified of terminal failure), `proxy.set("x", 1)` MUST NOT throw — the message is either eventually delivered or silently lost (at-most-once contract). Verifying the silent-drop case: the test asserts only the absence of a synchronous throw and the absence of a wire frame on the underlying socket; whether the message lands on a later recovery is implementation-defined. The bifurcation is the canonical safety mechanism `setWithAck` is designed around | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `set` row) + [§ Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) + [SPEC-extensions.md § Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (the `set` rows in both tables) |

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

> **Scope of this vector — consumer interoperability with legacy producers, NOT current producer conformance.** This vector tests that a consumer-side proxy gracefully handles a producer that omits or sets `false` on `capabilities.setAck` (i.e. the consumer interoperates with a legacy / non-current producer per the "Consumers MUST still cope with legacy producers ... for backward compatibility" rule in [SPEC-extensions.md § Message types — server → client](SPEC-extensions.md#message-types--server--client)). It does **NOT** make such a producer current-conformant: per the same spec section, "for an Extension 2 producer to claim current conformance, `setAck` MUST be advertised as `true`" and `setWithAck` MUST be implemented end-to-end. A producer-side conformance test for `setAck` is the converse of this vector — see vector 9 ("setWithAck end-to-end") for the producer-side rule that current producers MUST satisfy. Passing this vector says nothing about producer conformance; it is a consumer-side robustness check against the legacy peer shape.

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

The cross-implementation normative minimum has **two** rules: the `@wc-bindable/` prefix tested here, and the exact-string prototype-pollution names (`"__proto__"`, `"constructor"`, `"prototype"`) tested separately in vector #20. Implementations MAY reserve additional declaration names beyond the normative minimum (vendor prefixes, debugging-tool names) and MUST document those additions in their public API. Cross-implementation vectors that target the implementation-specific extras MUST branch on the implementation's documented list; only the two normative-minimum rules are portable across every conformant implementation.

---

### 16. Pre-sync queue is FIFO but not transactional

**Setup.** A remote proxy in PreSync (before its initial `sync` response arrives) with a recording client transport and a producer-stub that will respond to `sync` with `capabilities.setAck: false` — the legacy-producer path is the most reliable way to force a queued `setWithAck` to reject without needing a co-operating producer that throws on a specific setter:

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);
// proxy is now in PreSync; no setWithAck / invoke wire traffic has been
// sent yet (only the initial { type: "sync" } request).

const settleOrder = [];
const setPromise = proxy.setWithAck("url", "/api/users")
  .then(() => settleOrder.push("setWithAck:resolved"))
  .catch(() => settleOrder.push("setWithAck:rejected"));
const invokePromise = proxy.invoke("fetch")
  .then(() => settleOrder.push("invoke:resolved"))
  .catch(() => settleOrder.push("invoke:rejected"));

// Producer responds with legacy semantics (no setAck capability).
transport.emitInbound({
  type: "sync",
  values: {},
  capabilities: { setAck: false },
});

// Flush queued microtasks AND one macrotask turn so the proxy's
// sync-response handler completes, drains the queue (emitting the `cmd`
// envelope for invoke("fetch")), and settles the queued setWithAck's
// already-rejected Promise — in that order — before we inspect outbound
// state and inject the return below. A single `await Promise.resolve()`
// is enough for the common "one microtask hop" implementation, but a
// proxy that uses two microtask hops internally (e.g. queue drain
// scheduled as a microtask that itself schedules per-call microtasks)
// could observe the outbound list before the cmd has been pushed AND
// settle setWithAck after the return injection — both flip the
// settleOrder expectation. The setTimeout(0) form below pins both
// orderings to the post-handler frame across any reasonable scheduler
// (matches the same defensive pattern used in vector 13).
await new Promise((resolve) => setTimeout(resolve, 0));

// After the sync response is processed, the proxy must respond to the
// pending `cmd` envelope it sent for `invoke("fetch")`.
const outboundCmd = transport.outboundMessages().find((m) => m.type === "cmd");
transport.emitInbound({ type: "return", id: outboundCmd.id, value: null });

await Promise.allSettled([setPromise, invokePromise]);
```

**Action.** Inspect `settleOrder` and the recorded outbound message list.

**Expected.**
- `settleOrder[0] === "setWithAck:rejected"` — the queued `setWithAck` rejects on sync arrival because the producer did not advertise `setAck` (per the legacy-rejection rule in § Pre-sync call state machine)
- `settleOrder[1] === "invoke:resolved"` — the queued `invoke` is **NOT** auto-cancelled by the preceding rejection; it is sent on the wire after sync-response processing and resolves on the matching `return` envelope
- The recorded outbound list contains exactly ONE `cmd` envelope for `"fetch"` and ZERO id-bearing `set` envelopes (the proxy MUST NOT send a `setWithAck` it knows the producer will not handle)

**Variant — post-sync, producer-side assignment throws.** With a producer that advertises `setAck: true`, issue both calls without awaiting between them so they go onto the wire in caller order:

```javascript
const p1 = proxy.setWithAck("badInput", v); // producer setter throws on receipt
const p2 = proxy.invoke("fetch");
await Promise.allSettled([p1, p2]);
```

The `setWithAck` rejects via a `throw` envelope; the `invoke` STILL sends on the wire and STILL completes per its own rules. **The `await` MUST NOT be placed between the two calls** — awaiting `p1` first would let the rejection settle before the dependent call is even issued, which is the safe pattern the spec recommends consumers adopt for dependent calls (`await proxy.setWithAck(...); proxy.invoke(...)`) and is therefore not what this vector exercises. The point of this vector is to demonstrate that issuing the two calls back-to-back with no inter-call await still leaves the second call running even when the first rejects. The same FIFO-without-dependency rule applies post-sync — the pre-sync case is just the most visible place the distinction matters.

**Spec reference.** [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) → "Queue ordering is not transactional" paragraph (with the same `setWithAck("url"); invoke("fetch")` example) plus the section's final paragraph extending the rule symmetrically to the steady-state post-sync case.

---

### 17. Fire-and-forget `set` pre-sync queuing (default vs low-latency profile)

**Setup.** A remote proxy in PreSync with a recording client transport, plus a known-input / known-command declaration:

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);

proxy.setWithAck("url", "/api/users"); // call 1: id-bearing, queued
proxy.set("method", "GET");             // call 2: fire-and-forget
proxy.invoke("fetch");                   // call 3: id-bearing, queued

// Inspect outbound state BEFORE sync (the default vs low-latency choice
// is observable right here — see Expected below).
const preSyncOutbound = transport.outboundMessages()
  .filter((m) => m.type !== "sync");

// Trigger sync to let the queue drain.
transport.emitInbound({
  type: "sync",
  values: {},
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

const postSyncOutbound = transport.outboundMessages()
  .filter((m) => m.type !== "sync");
```

> **`postSyncOutbound` is cumulative, not "messages emitted after sync arrival only".** Both `preSyncOutbound` and `postSyncOutbound` are snapshots of `transport.outboundMessages()` (everything the proxy has handed to the transport so far, minus the initial `{ "type": "sync" }`). So under the low-latency profile, the early-emitted `set("method", "GET")` appears in **both** snapshots — that is the intended observation, not a duplicate. The two snapshots together form a "before / after sync arrival" diff: anything present in `postSyncOutbound` but absent from `preSyncOutbound` was emitted as part of queue drain on sync arrival.

**Action.** Compare `preSyncOutbound` (what left the proxy before sync arrival) and `postSyncOutbound` (the full ordered outbound after queue drain).

**Expected (default profile — SHOULD-queue, what the reference implementation does).**
- `preSyncOutbound.length === 0` — all three calls (including the fire-and-forget `set`) are queued; nothing leaves the proxy until sync-response processing completes
- `postSyncOutbound` is exactly three messages in caller order: `[set("url", id: X), set("method", no id), cmd("fetch", id: Y)]`
- The relative order between `setWithAck("url")` and the fire-and-forget `set("method")` is preserved — the producer observes the inputs in exactly the order the consumer issued them

**Expected (low-latency profile — MAY-immediate, a documented alternative).**
- `preSyncOutbound` MAY contain the fire-and-forget `set("method", "GET")` — the implementation chose to send `set` immediately rather than queue. The id-bearing `setWithAck("url")` and `invoke("fetch")` MUST still queue (the immediate-send option is `set`-only).
- `postSyncOutbound` then contains `[set("method", no id), set("url", id: X), cmd("fetch", id: Y)]` — note the reordering: the fire-and-forget `set` lands first because it bypassed the queue.
- A low-latency-profile implementation MUST document this choice in its public API surface so consumers can audit before relying on caller-order-preserves-wire-order.

**Cross-profile invariant (BOTH profiles MUST satisfy).** Validation throws in `set()` are call-site synchronous regardless of profile. A `set("not-a-declared-input", X)` (undeclared name) and a `set("validInput", { date: new Date() })` (non-`JsonValue` value) MUST both throw synchronously from the `set()` call itself; no message is queued, no message is sent, and the consumer learns about the bug at the call site rather than via a silent drop.

**Spec reference.** [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) (`set` row in the per-call-site table) and the cross-profile validation-throw paragraph in the same table cell.

---

### 18. Late `return` after timeout MUST be dropped

**Setup.** A `setWithAckOptions` with a short timeout against a proxy that has already finished sync handshake (so the message goes on the wire directly), plus the ability to inject a late inbound `return` envelope after the timeout fires:

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);

// Bring the proxy to Active.
transport.emitInbound({
  type: "sync",
  values: {},
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

const settleSequence = [];
const callPromise = proxy
  .setWithAckOptions("url", "/api/users", { timeoutMs: 50 })
  .then(() => settleSequence.push("resolved"))
  .catch((err) => settleSequence.push(["rejected", err?.name]));

// Capture the id the proxy assigned to this setWithAck on the wire.
const outboundSet = transport.outboundMessages()
  .find((m) => m.type === "set" && m.id !== undefined);
const id = outboundSet.id;

// Wait past the timeout — the proxy fires its local TimeoutError.
await new Promise((resolve) => setTimeout(resolve, 100));
// At this point settleSequence === [["rejected", "TimeoutError"]]

// Inject the LATE `return` envelope referencing the same id.
transport.emitInbound({ type: "return", id, value: null });
await new Promise((resolve) => setTimeout(resolve, 0));

// A subsequent normal call MUST still work — the late drop is per-id,
// not a connection-level failure. Inject the matching return explicitly
// so the vector is executable end-to-end against a recording transport.
// Capture the outbound count BEFORE issuing the follow-up so we match
// the follow-up's `cmd` rather than any pre-existing cmd("fetch") that
// a longer test scenario might have left in the recording transport.
const outboundBefore = transport.outboundMessages().length;
const followUpPromise = proxy.invoke("fetch");
const outboundCmd = transport.outboundMessages()
  .slice(outboundBefore)
  .find((m) => m.type === "cmd" && m.name === "fetch");
transport.emitInbound({ type: "return", id: outboundCmd.id, value: null });
const followUp = await followUpPromise;
```

**Action.** Inspect `settleSequence`, any warn-level logger output, and the follow-up call's outcome.

**Expected.**
- `settleSequence.length === 1` and `settleSequence[0] === ["rejected", "TimeoutError"]` — the late `return` MUST NOT re-settle the already-rejected `Promise`
- The proxy SHOULD log a warn-level message for the dropped late envelope so the unexpected late delivery is visible to diagnostics; the consumer's `Promise` MUST NOT throw or transition on the late delivery
- The transport MUST NOT be closed by the late drop — subsequent `setWithAck` / `invoke` calls on the same proxy continue to work normally

**Variant — `AbortSignal`-initiated cancellation.** The same shape applies when the caller's `AbortSignal` fires before the producer answers. The aborted call's pending entry is removed locally; a subsequent matching `return` / `throw` envelope MUST be silently dropped without re-settling the `Promise`. The cancellation is local-only — no wire-level cancellation is sent, so the producer keeps running the work and eventually emits an envelope that the late-drop rule then ignores.

**Spec reference.** [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) → "After timeout or abort settles the caller's promise, the proxy MUST NOT re-settle it if a late `return` / `throw` envelope arrives for the same `id`" and the surrounding paragraph on warn-logging.

---

### 19. Producer re-entrant getter dispatch is a producer violation

**Setup.** A producer whose declared-property getter synchronously dispatches the corresponding wc-bindable change event during the property read — exactly the case the producer MUST NOT cause per [SPEC.md § Event detail vs Property Read](SPEC.md#event-detail-vs-property-read) (producer-side rule blockquote) and the second-to-last bullet in [SPEC.md § Producer Obligations](SPEC.md#producer-obligations):

```javascript
class HostileProducer extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "value", event: "h:value-changed" }],
  };

  // PRODUCER VIOLATION: synchronous re-entrant dispatch from the getter.
  get value() {
    this.dispatchEvent(
      new CustomEvent("h:value-changed", { detail: "from-getter" }),
    );
    return "from-read";
  }
}
const target = new HostileProducer();

const calls = [];
const unbind = bind(target, (name, value) => calls.push([name, value]));
unbind();
```

**Action.** Inspect `calls` (the consumer's observed `onUpdate` delivery sequence).

**Expected.**
- `calls.length === 2` — the consumer observes BOTH the re-entrant dispatch AND the initial-sync read. The adapter MUST faithfully deliver both; deduplication / detection / repair is **NOT** the adapter's job (the producer is responsible for not causing the re-entry).
- `calls[0]` is the listener-delivered event from the synchronous `dispatchEvent` inside the getter: `["value", "from-getter"]`.
- `calls[1]` is the initial-sync read's `onUpdate` call observing the property's return: `["value", "from-read"]`.
- The order is **dispatch-first, sync-second** because adapters MUST attach listeners *before* performing the initial-sync read (the registration-before-read rule, so no event is missed during the read), so the re-entrant dispatch fires the registered listener first and the initial-sync `onUpdate` runs after.

**Conformance interpretation.** This is a **negative test on the producer**, not on the adapter. An adapter that suppresses the duplicate `onUpdate`, reorders the two calls, or otherwise "repairs" the double delivery is non-conformant — it is masking a producer bug that the spec deliberately makes observable so producer authors can detect it during testing. The conformant adapter behavior is the literal sequence above; the conformant producer behavior is to NOT define such a getter (and, if a side effect like a sensor materialization is unavoidable, to perform it on construction / in a dedicated initializer instead of inside the getter — see the § Producer Obligations "side-effect-free with respect to wc-bindable change events" bullet).

**Spec reference.** [SPEC.md § Event detail vs Property Read](SPEC.md#event-detail-vs-property-read) (producer-side rule blockquote) + [SPEC.md § Producer Obligations](SPEC.md#producer-obligations) ("avoid synchronously dispatching" and "side-effect-free" bullets).

---

### 27. `dispose()` — pending entries reject in caller order; late envelopes dropped

**Setup.** A remote proxy in Active state with three outstanding pending entries issued in caller order (`setWithAck`, `invoke`, `setWithAck`), plus a recording transport that can inject late inbound envelopes after `dispose()`:

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);

// Bring to Active.
transport.emitInbound({
  type: "sync",
  values: {},
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

const settleOrder = [];
const p1 = proxy.setWithAck("url", "/api/users")
  .catch((e) => settleOrder.push(["p1", e?.code, e?.name]));
const p2 = proxy.invoke("fetch")
  .catch((e) => settleOrder.push(["p2", e?.code, e?.name]));
const p3 = proxy.setWithAck("method", "POST")
  .catch((e) => settleOrder.push(["p3", e?.code, e?.name]));

// Capture the on-wire ids before dispose so we can inject late envelopes.
const outbound = transport.outboundMessages();
const id1 = outbound.find((m) => m.type === "set" && m.name === "url").id;
const id2 = outbound.find((m) => m.type === "cmd" && m.name === "fetch").id;
const id3 = outbound.find((m) => m.type === "set" && m.name === "method").id;

// Action: dispose.
proxy.dispose();

await Promise.allSettled([p1, p2, p3]);
```

**Action.** Inspect `settleOrder`, then inject late envelopes for the disposed ids and verify they do not re-settle.

```javascript
// Inject late envelopes for already-rejected ids.
let lateReSettle = false;
[p1, p2, p3].forEach((p) => p.then(() => { lateReSettle = true; }, () => {}));
transport.emitInbound({ type: "return", id: id1, value: "should be dropped" });
transport.emitInbound({ type: "throw",  id: id2, error: { name: "X", message: "should be dropped" } });
transport.emitInbound({ type: "return", id: id3, value: null });
await new Promise((resolve) => setTimeout(resolve, 0));

// Action 2: subsequent dispose() call is a safe no-op (idempotent).
proxy.dispose();
```

**Expected.**
- `settleOrder.length === 3` and the entries appear in **caller order** — `[["p1", ..., ...], ["p2", ..., ...], ["p3", ..., ...]]` — regardless of `Map` iteration order in the proxy's internal `id → pending` table. The error code carried by each rejection MAY be `WC_BINDABLE_PROTOCOL_ERROR` (a generic terminal-failure synthetic) or an implementation-defined locally-namespaced equivalent that signals dispose; the **caller-order** part is the load-bearing contract here, not the exact code value.
- `lateReSettle === false` — none of the three late envelopes injected after dispose re-settles the corresponding `Promise`. The proxy SHOULD log a warn-level entry for each late envelope it drops, but MUST NOT throw, MUST NOT reopen the transport, and MUST NOT re-fire `onUpdate` for any property.
- The second `proxy.dispose()` call returns without throwing — `dispose()` is unconditionally idempotent.
- After `dispose()`: `proxy.set("x", 1)` MUST throw synchronously; `proxy.setWithAck("x", 1)` / `proxy.invoke("fetch")` MUST return an already-rejected `Promise`.

**Spec reference.** [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods) (`dispose` row), [§ Pending-call lifecycle](SPEC-extensions.md#pending-call-lifecycle-setwithack--setwithackoptions--invoke--invokewithoptions) ("the `id → pending` table is the integration point" note about FIFO drain order), [§ AckOptions](SPEC-extensions.md#ackoptions) (late-envelope drop rule).

---

### 28. `reconnect()` after TerminalFailure — fresh `sync`, no pending replay

> **Applicability.** This vector tests `reconnect()`, which is **OPTIONAL** per [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods). Implementations that omit `reconnect` from their public surface are conformant and this vector is N/A — the conformant equivalent for the consumer is `dispose()` followed by constructing a new proxy. Implementations that ship `reconnect()` MUST pass this vector.

**Setup.** A remote proxy that has been brought to Active, then driven to TerminalFailure (via `transport.simulateTerminalFailure()` or equivalent — explicit `onClose` firing followed by the transport refusing further `send()`). The proxy's pending-entry queue is drained by the TerminalFailure transition per vector 27's rule.

```javascript
const transport1 = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport1);

transport1.emitInbound({
  type: "sync",
  values: { url: "/api/old" },
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

// Issue a pending setWithAck that will get drained on TerminalFailure.
const drainedPromise = proxy.setWithAck("url", "/api/users").catch(() => {});

// Drive to TerminalFailure.
transport1.simulateTerminalFailure();
await drainedPromise; // settle (rejected) per vector 27

// Action: reconnect with a fresh transport.
const transport2 = new RecordingTransport();
proxy.reconnect(transport2);
```

**Action.** Inspect what `transport2` observes, and verify `transport2` does NOT see any replay of the previously-rejected `setWithAck("url", "/api/users")` message.

**Expected.**
- `transport2.outboundMessages()` contains exactly ONE message immediately after `reconnect()`: a fresh `{ "type": "sync" }` envelope. The proxy MUST send a new sync request as part of reconnect — it MUST NOT assume the producer remembers any prior state.
- `transport2.outboundMessages()` MUST NOT contain a replayed `{ type: "set", name: "url", value: "/api/users", id: ... }` envelope — the previously-rejected pending entry has already been settled (Rejected) on the consumer's side, and the spec deliberately does NOT auto-replay drained entries against a new transport (the consumer cannot tell which entries already reached the producer over the dying transport — see [SPEC-extensions.md § Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference), "Terminal transport failure" row in the Retry guidance table).
- The proxy's cache MUST be preserved across the Reconnecting transition per vector 29 — `proxy.url === "/api/old"` immediately after `reconnect()` returns (still holding the pre-failure last-known value). The new value arrives once the fresh `sync` response lands on `transport2`.

**Negative companions (synchronous throws).**
- `proxy.dispose(); proxy.reconnect(transport3)` MUST throw synchronously — reconnect on a disposed proxy is a programmer error.
- `proxy.reconnect(anotherTransport)` while the existing transport is still healthy (Active state) MUST throw synchronously — re-attaching to a live connection is a programmer error.

**Spec reference.** [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods) (`reconnect` row), [§ Remote proxy lifecycle](SPEC-extensions.md#remote-proxy-lifecycle) (TerminalFailure → Reconnecting → PreSync transition), [§ Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (Retry guidance table, "Terminal transport failure" row).

---

### 29. Cache validity across TerminalFailure / Reconnecting

**Setup.** A remote proxy brought to Active with a non-trivial cache:

```javascript
const transport1 = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport1);

transport1.emitInbound({
  type: "sync",
  values: { value: 42, label: "hello" },
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

// Sanity: cache is populated.
console.assert(proxy.value === 42 && proxy.label === "hello");
console.assert("value" in proxy && "label" in proxy);
```

**Action.** Drive the proxy through TerminalFailure and Reconnecting, observing the cache at each step.

```javascript
// Step 1: TerminalFailure. Cache MUST be preserved.
transport1.simulateTerminalFailure();
const valueAfterTerminal  = proxy.value;
const labelAfterTerminal  = proxy.label;
const valueInAfterTerminal  = "value" in proxy;
const labelInAfterTerminal  = "label" in proxy;

// Step 2: Reconnect with a fresh transport. Cache MUST still be preserved
//          until the new sync response is processed.
const transport2 = new RecordingTransport();
proxy.reconnect(transport2);
const valueAfterReconnect = proxy.value;
const labelAfterReconnect = proxy.label;

// Step 3: New sync arrives. `value` updated to a new number; `label` no
//          longer in `values` or `undefinedProperties` (producer dropped it).
transport2.emitInbound({
  type: "sync",
  values: { value: 99 },
  capabilities: { setAck: true, undefinedProperties: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

const valueAfterResync = proxy.value;
const labelAfterResync = proxy.label;
const labelInAfterResync = "label" in proxy;
```

**Expected.**
- `valueAfterTerminal === 42` and `labelAfterTerminal === "hello"` — the cache is preserved through TerminalFailure. Reads MUST NOT return `undefined` merely because the transport is terminal.
- `valueInAfterTerminal === true` and `labelInAfterTerminal === true` — `name in proxy` stays `true` for cached names during TerminalFailure. The `has`-trap MUST NOT flip to `false` until a new `sync` response says so.
- `valueAfterReconnect === 42` and `labelAfterReconnect === "hello"` — Reconnecting before the new sync arrives is observationally identical to TerminalFailure for cache reads. The cache changes only as part of the new sync-response processing.
- After the new sync: `valueAfterResync === 99` (cache updated from the new snapshot, `onUpdate("value", 99)` re-fires per [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode)).
- After the new sync: `labelAfterResync === undefined` and `labelInAfterResync === false` — the producer dropped `label` from both `values` and `undefinedProperties`, so the cache entry MUST be removed and `has` MUST flip to `false`. NO synthetic removal event is dispatched (the protocol does not surface property removal as a `bind()` event — adapters that need to detect this should compare against their own snapshot, per the [§ Cache validity across transport lifecycle](SPEC-extensions.md#cache-validity-across-transport-lifecycle) diff rules).

**Variant — TransientFailure.** Same posture: simulate a transient outage (transport's own backoff layer is masking a network blip, the proxy has NOT been told the transport is terminal). The cache MUST behave identically to the TerminalFailure case above — preserved as-is, no entries cleared, no events re-fired on entering TransientFailure.

**Spec reference.** [SPEC-extensions.md § Cache validity across transport lifecycle](SPEC-extensions.md#cache-validity-across-transport-lifecycle) (the per-state behavior table and the diff rule on new `sync` arrival).

---

### 30. Locally-synthesized errors MUST carry `code`

**Setup.** A remote proxy in Active state with a mock producer that lets the test force each of the four canonical locally-synthesized failure modes.

**Action.** Trigger each failure mode and inspect `error.code` on the rejection:

```javascript
// (a) Timeout — short-deadline call against an unresponsive producer.
async function testTimeout() {
  let err;
  try {
    await proxy.setWithAckOptions("x", 1, { timeoutMs: 1 });
  } catch (e) { err = e; }
  return err.code; // expected: "WC_BINDABLE_TIMEOUT"
}

// (b) Abort — abort after send.
async function testAbort() {
  const ac = new AbortController();
  const p = proxy.invokeWithOptions("fetch", [], { signal: ac.signal });
  ac.abort();
  let err;
  try { await p; } catch (e) { err = e; }
  return err.code; // expected: "WC_BINDABLE_ABORTED"
}

// (c) Invalid JsonValue — value carries a Date.
async function testInvalidJson() {
  let err;
  try {
    await proxy.setWithAck("x", new Date());
  } catch (e) { err = e; }
  return err.code; // expected: "WC_BINDABLE_INVALID_JSON_VALUE"
}

// (d) Malformed sync ⇒ TerminalFailure drain (per vector 23).
async function testMalformedSync() {
  const t = new RecordingTransport();
  const p = createRemoteCoreProxy(declaration, t);
  const pending = p.setWithAck("x", 1).catch((e) => e);
  // Producer sends a malformed sync (missing `values`).
  t.emitInbound({ type: "sync" });
  const err = await pending;
  return err.code; // expected: "WC_BINDABLE_PROTOCOL_ERROR"
}
```

**Expected.**
- `testTimeout()` resolves to `"WC_BINDABLE_TIMEOUT"`.
- `testAbort()` resolves to `"WC_BINDABLE_ABORTED"`.
- `testInvalidJson()` resolves to `"WC_BINDABLE_INVALID_JSON_VALUE"`.
- `testMalformedSync()` resolves to `"WC_BINDABLE_PROTOCOL_ERROR"`.

**Application-throw companion.** Producer-side application throws (a setter or command implementation that throws a non-protocol error) MAY carry `code === "WC_BINDABLE_REMOTE_THROW"` or MAY omit `code` entirely, or MAY carry an application-namespaced code (e.g. `"MYAPP_VALIDATION_FAILED"`). The vector's strict rule is: an application throw MUST NOT carry any other `WC_BINDABLE_*` code from the registry — re-using e.g. `WC_BINDABLE_TIMEOUT` for an application throw is non-conformant because it would collide with the consumer's `code`-pattern-matching for the canonical timeout failure.

**Why the assertion is on `code` and not `name`.** `error.name` varies across runtimes (`"TimeoutError"` in some, `"AbortError"` in others, `"Error"` as a fallback). `error.message` is human-readable and may be localized. The `code` field exists specifically to survive both axes; tests that match on `name` or `message` instead are testing implementation drift rather than the protocol contract.

**Spec reference.** [SPEC-extensions.md § Error envelope → Producer-side code-emission rule](SPEC-extensions.md#error-envelope) (origin-conditional MUST / MAY) and the registry table immediately above it.

---

### 31. `getterFailures` does NOT touch cache; subsequent `update` recovers

**Setup.** A remote proxy that has cached a non-`undefined` value, then receives a re-sync (e.g. via reconnect) whose response advertises `getterFailures` for that property.

```javascript
const transport1 = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport1);

// First sync: v == 42, capability bits asserted.
transport1.emitInbound({
  type: "sync",
  values: { v: 42 },
  capabilities: { setAck: true, getterFailures: true, undefinedProperties: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

const calls = [];
const warns = [];
bind(proxy, (name, value) => calls.push([name, value]));
const proxyLogger = { warn: (msg) => warns.push(msg) }; // implementation-specific injection

// Sanity: cache and bind initial sync.
console.assert(proxy.v === 42);
console.assert(calls.length === 1 && calls[0][0] === "v" && calls[0][1] === 42);
calls.length = 0; // reset call tracker for the next phase

// Action 1: force a re-sync whose response says `v` failed to read.
const transport2 = new RecordingTransport();
proxy.reconnect(transport2);
transport2.emitInbound({
  type: "sync",
  values: {},                             // v intentionally omitted
  getterFailures: ["v"],                  // ... because the read threw on the producer
  capabilities: { setAck: true, getterFailures: true, undefinedProperties: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));
```

**Expected (re-sync arrival).**
- `proxy.v === 42` — the cache is **preserved**, NOT reverted to `undefined`. A getter failure is a *property-level* failure assertion, not a state assertion (see [SPEC-extensions.md § `getterFailures` semantics](SPEC-extensions.md#getterfailures-semantics)).
- `calls.length === 0` — no `onUpdate` is dispatched for `v` as part of the failed-getter sync. The legacy revert-to-`undefined` heuristic is NOT applied here because `capabilities.undefinedProperties: true` opts the consumer out (see [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode) step 2 vs step 3).
- `warns.length >= 1` and at least one entry mentions `v` — the consumer logs the producer-side getter failure for diagnostics.

**Action 2.** The producer recovers and emits a normal `update` for `v`:

```javascript
transport2.emitInbound({ type: "update", name: "v", value: 99 });
await new Promise((resolve) => setTimeout(resolve, 0));
```

**Expected (recovery).**
- `proxy.v === 99` — the cache updates normally; the getter failure does NOT permanently taint the property.
- `calls.length === 1` and `calls[0] === ["v", 99]` — `onUpdate` fires for the recovered value.

**Spec reference.** [SPEC-extensions.md § `getterFailures` semantics](SPEC-extensions.md#getterfailures-semantics) + [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode) (the "`getterFailures` does NOT touch the cache" notice in step 3) + [§ Cache validity across transport lifecycle](SPEC-extensions.md#cache-validity-across-transport-lifecycle) (re-sync diff rule for `getterFailures`).

---

### 32. Malformed `update` drops + warns; transport stays open; next valid `update` processed

**Setup.** A remote proxy in Active state with a recording transport and a known cached value:

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);

transport.emitInbound({
  type: "sync",
  values: { value: "initial" },
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

const calls = [];
const warns = [];
bind(proxy, (name, value) => calls.push([name, value]));
calls.length = 0; // reset for the malformed-injection phase

// Pre-condition: transport is open.
console.assert(!transport.isClosed());
```

**Action.** Inject a malformed `update`, then a valid one:

```javascript
// (a) Missing `name`.
transport.emitInbound({ type: "update", value: "oops" });
// (b) Non-string `name`.
transport.emitInbound({ type: "update", name: 42, value: "oops" });
// (c) Present `value` that fails JsonValue validation.
transport.emitInbound({ type: "update", name: "value", value: { d: new Date() } });

await new Promise((resolve) => setTimeout(resolve, 0));

// After the three malformed injections:
const callsAfterBad = calls.slice();
const transportOpenAfterBad = !transport.isClosed();
const valueAfterBad = proxy.value;

// (d) Valid update lands normally.
transport.emitInbound({ type: "update", name: "value", value: "ok" });
await new Promise((resolve) => setTimeout(resolve, 0));
```

**Expected.**
- `callsAfterBad.length === 0` — no `onUpdate` fires for the three malformed envelopes. The `bind()` consumer MUST NOT see any of them.
- `transportOpenAfterBad === true` — the malformed envelopes MUST NOT close the transport. Unlike malformed `sync` (vector 23), malformed `update` is per-message degradation, not connection-level failure.
- `valueAfterBad === "initial"` — the proxy's cache for `value` MUST NOT be touched by the malformed envelopes (the JsonValue-validation failure on case (c) MUST be detected *before* the cache write, not after).
- The proxy SHOULD log a warn-level entry naming the failing field for each malformed envelope (`name` missing, `name` non-string, `value` failed `JsonValue`).
- After (d) lands: `calls.length === 1`, `calls[0] === ["value", "ok"]`, and `proxy.value === "ok"` — the next valid `update` is processed normally. Subsequent `setWithAck` / `invoke` calls on the same proxy MUST continue to work.

**Spec reference.** [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) (malformed `update` row — drop + warn + connection liveness preserved).

---

### 33. Deferred initial-sync throw — `unbind()` is a literal no-op afterward

> **Applicability.** Same scope as vector 13 — general-purpose browser JS implementations claiming `{1O}` that support `syncOn: "connect"` on `HTMLElement` targets. Skip applies under the spec-defined fallback conditions (non-browser runtime, non-`HTMLElement` target, explicitly scoped profile that documents non-support).

**Setup.** A bindable custom element whose property getter throws on read, used via `syncOn: "connect"` so the throw lands inside the deferred-sync `MutationObserver` microtask:

```javascript
class T extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "value", event: "t:value-changed" }],
  };
  get value() { throw new Error("getter-throws-on-read"); }
}
const tag = `t-deferred-throw-${crypto.randomUUID()}`;
customElements.define(tag, T);
const target = document.createElement(tag);

// Track uncaught errors during the deferred-throw window.
const uncaught = [];
const onError = (e) => { uncaught.push(e.error ?? e.reason ?? e); e.preventDefault?.(); };
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onError);

// Track listener removals on `target` so we can assert cleanup ran.
const removedEvents = [];
const realRemove = target.removeEventListener.bind(target);
target.removeEventListener = (type, ...rest) => {
  removedEvents.push(type);
  realRemove(type, ...rest);
};

// bind() returns synchronously — the throw will land in the microtask.
const unbind = bind(target, () => {}, { syncOn: "connect" });
```

**Action.** Connect the target so the deferred sync runs (and throws), then call `unbind()` and assert it is a no-op:

```javascript
document.body.appendChild(target);
// Wait for the MutationObserver microtask + the deferred-sync throw to surface.
await new Promise((resolve) => setTimeout(resolve, 0));

// At this point: the getter throw fired inside the deferred-sync microtask,
// the adapter tore down its cleanups, the throw surfaced as an uncaught
// error on the microtask. Now call unbind:
let unbindThrew = false;
const removedCountBeforeUnbind = removedEvents.length;
try { unbind(); } catch { unbindThrew = true; }
const removedCountAfterUnbind = removedEvents.length;

// Second call must also be safe.
try { unbind(); } catch { unbindThrew = true; }

window.removeEventListener("error", onError);
window.removeEventListener("unhandledrejection", onError);
```

**Expected.**
- `uncaught.length >= 1` and at least one entry's message includes `"getter-throws-on-read"` — the deferred throw surfaces as an uncaught error on the microtask (`window.onerror` / `reportError`), NOT as a synchronous throw on the `bind()` call frame the caller was holding.
- `removedCountBeforeUnbind === removedCountAfterUnbind` — `unbind()` MUST be a literal no-op. The cleanup-on-throw path already removed every listener and disconnected the `MutationObserver` before the throw escaped; the closure's `disposed` re-entry guard was set during that path, so `unbind()` returns immediately without re-walking the cleanup list (which would trigger a second `removeEventListener` per registered listener and corrupt counters / produce duplicate calls).
- `unbindThrew === false` — `unbind()` MUST NOT throw, even though the underlying state machine reached Disposed via the install-throw path rather than via consumer-initiated cleanup.
- The second `unbind()` call MUST also be a safe no-op (re-entry idempotency).

**Why this matters.** Without the closure-level re-entry guard, a deferred throw cleans up the listener set inside the catch path, but the caller's later `unbind()` call would re-walk the cleanup list — calling `removeEventListener` a second time per listener. On a friendly target the DOM swallows the second removal; on a hostile `Proxy`-wrapped target whose `removeEventListener` counts each call, the second walk corrupts state and may throw, and the `bind()` API contract degrades from "deterministic no-op" to "implementation-dependent".

**Spec reference.** [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) (the "If a *deferred* initial-sync (`syncOn: \"connect\"`) throws" paragraph — "calling it after the deferred throw is a literal no-op thanks to the re-entry guard mandated by the idempotency MUST"), [§ bind() state machine summary](SPEC.md#bind-state-machine-summary) (InitialSyncing → Disposed via deferred throw → terminal).

---

### 34. `set()` — sync throw on terminal, no throw on transient outage

> **Why a mock transport.** [SPEC-extensions.md § Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) defines the terminal-vs-transient distinction in transport-implementation-defined terms (which signal each transport treats as terminal: `onClose`, `send`-throw, explicit `dispose()`). A canonical cross-implementation vector therefore uses a **mock transport with explicit `setTerminal()` / `setTransient()` hooks** so the test can force each state directly rather than depending on a real network's timing.

**Setup.** A mock transport with explicit state hooks, plus a proxy in Active state with at least one declared input.

```javascript
class MockTransport {
  constructor() {
    this.state = "active";            // "active" | "transient" | "terminal"
    this.sent = [];
    this.onMessageHandler = null;
    this.onCloseHandler = null;
  }
  send(msg) {
    if (this.state === "terminal") throw new Error("transport is terminal");
    if (this.state === "transient") { /* silently drop — masking the outage */ return; }
    this.sent.push(msg);
  }
  onMessage(h)  { this.onMessageHandler = h; }
  onClose(h)    { this.onCloseHandler = h; }
  emitInbound(m) { this.onMessageHandler?.(m); }
  setTransient() { this.state = "transient"; /* NO onClose fired */ }
  setTerminal()  { this.state = "terminal"; this.onCloseHandler?.(); }
}

const transport = new MockTransport();
const proxy = createRemoteCoreProxy(declaration, transport);

transport.emitInbound({
  type: "sync",
  values: {},
  capabilities: { setAck: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));
```

**Action — transient path.**

```javascript
transport.setTransient();

let threwOnTransient = false;
const sentCountBefore = transport.sent.length;
try { proxy.set("x", 1); } catch { threwOnTransient = true; }
const sentCountAfter = transport.sent.length;
```

**Expected — transient.**
- `threwOnTransient === false` — `set()` MUST NOT throw synchronously while the transport is transient. This is the gap `setWithAck` exists to make detectable; `set` is at-most-once by design and the silent-drop case is part of the contract.
- The proxy MAY queue the message internally for later delivery, OR MAY drop it silently — both are conformant. The observable rule is just "no synchronous throw".
- `sentCountAfter === sentCountBefore` — the mock's transient mode silently drops the call, so no message reaches the recorded `sent` list.

**Action — terminal path.**

```javascript
transport.setTerminal();

let threwOnTerminal = false;
let thrownError;
try { proxy.set("x", 2); } catch (e) { threwOnTerminal = true; thrownError = e; }
```

**Expected — terminal.**
- `threwOnTerminal === true` — `set()` MUST throw synchronously when the transport is in terminal state at call time.
- `thrownError.message` (or `thrownError.code`, if the implementation carries one) SHOULD clearly identify the failure as transport-terminal so the caller can distinguish it from a validation throw (`WC_BINDABLE_UNDECLARED_INPUT` / `WC_BINDABLE_INVALID_JSON_VALUE`). The exact `code` value is implementation-defined for the transport-terminal case (the registry table in [§ Error envelope](SPEC-extensions.md#error-envelope) does not pin one specifically for terminal-on-`set`; `WC_BINDABLE_PROTOCOL_ERROR` is a reasonable default).
- After the throw: `proxy.setWithAck("x", 3)` MUST return an already-rejected `Promise`; `proxy.invoke("fetch")` MUST likewise reject.

**Cross-profile invariant.** Validation throws still apply at the `set()` call site regardless of terminal/transient state — `proxy.set("not-a-declared-input", X)` and `proxy.set("validInput", { d: new Date() })` MUST throw synchronously on the validation gate, *before* the terminal-vs-transient gate runs. This composes with vector 17's call-site-validation rule.

**Why the bifurcation matters.** The `set()` row of [SPEC-extensions.md § Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (both the failure-and-recovery table and the retry-guidance table) calls this out as the spec's most-confused surface. A consumer that uses `set(); invoke()` over a flaky link without realizing `set` is at-most-once on transient outages will see `invoke` run against producer state that never received the `set` update — a class of silent corruption that `setWithAck` exists to make detectable. This vector exists so an implementation cannot pass the surrounding test suite while collapsing the two paths (e.g. always throwing, or never throwing) — the bifurcation is the canonical safety mechanism the consumer relies on.

**Spec reference.** [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `set` row, "Fast path — unsafe by design" and "transient outages — automatic reconnect attempts in progress ... are NOT terminal"), [§ Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2), [§ Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (the `set` rows in both tables).

---

## What this list does NOT cover

These vectors are deliberately narrow — they target rules that are easy to violate in ways that pass naive smoke tests. They are **not** a complete conformance suite. Additional areas worth covering in a richer test corpus:

- **Shadow-DOM attach** under `syncOn: "connect"` (the documented "observer doesn't traverse shadow roots" limitation)
- **`AbortSignal` pre-aborted at `setWithAckOptions` / `invokeWithOptions` call time** (rejects immediately without sending — distinct from vector 18's "aborted/timed-out after send" case, which IS covered)
- **Declaration fingerprint mismatch** on `sync` (MUST log warn, MUST continue accepting)
- **`MutationObserver` callback after host detach** under `syncOn: "connect"` (observer rechecks `isConnected`, stays armed)

Implementations targeting full conformance should grow their own test suite to cover at minimum the items above; the in-tree tests under `packages/core/tests/` and `packages/remote/tests/` cover much of this space and can be used as a starting reference.

Contributions that expand this file with additional canonical vectors are welcome — the test-vector format above (Setup → Action → Expected → Spec reference) is the template.
