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
| **`{2}`** | Drop-in Core JS API compatibility — exports `bind`, `getWcBindableDeclaration`, `isWcBindable` with the exact normative signatures. The three exports are observer-side surfaces, so `{2}` implies `{1O}`. If the same implementation also ships producer targets or producer helpers (component base classes, declaration generators, etc.), that producer surface MUST additionally satisfy `{1P}`; an observer-only library that ships no producer helpers is `{2}` conformant on `{1O}` alone. See [SPEC.md § Level 1 facets → Facet implication for higher levels](SPEC.md#level-1-facets) for the authoritative rule |
| **`{3-consumer}`** | Remote consumer-side proxy — implements Extension 2's wire format and Extension 1's call methods (`set`, `setWithAck`, `invoke`) from the consumer side |
| **`{3-producer}`** | Remote producer-side shell — accepts the wire format on the producer side, dispatches per-property updates, runs `getter` server-side |
| **`{3-both}`** | Implementation that ships both sides (the reference `@wc-bindable/remote` is `{1O + 1P, 2, 3-both}` — it ships the consumer-side proxy `{1O}`, the producer-side shell `{1P}`, the Level 2 JS API, and both Level 3 sides) |

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
| 10 | setWithAck legacy | `{3-consumer}` and `{3-both}` (the consumer-side rejection rule is what is tested; producer side participates only as a stub that omits `setAck`) | If the producer's `sync` response omits / sets-false `capabilities.setAck`, `setWithAck` MUST return an already-rejected `Promise` whose `error.code === "WC_BINDABLE_SET_ACK_UNSUPPORTED"` and MUST NOT send an id-bearing `set` on the wire. The pinned code is what makes consumer recovery (typical pattern: fall back to fire-and-forget `set`) robust against `error.message` localization / runtime differences | [SPEC-extensions.md § Message types — server → client](SPEC-extensions.md#message-types--server--client) (setAck capability bullets) + [§ Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_SET_ACK_UNSUPPORTED` row) |
| 11 | onUpdate validity | **`{2}` MUST**; `{1O without 2}` SHOULD (MAY defer to first invocation — see body) | **`{2}` (binding pass/fail):** `bind(target, "not-a-function")` (and other non-function `onUpdate` values) MUST throw a synchronous `TypeError` at `bind()` entry, **including** on an empty-`properties` target where deferred detection would never fire. **`{1O without 2}` (informational):** SHOULD throw synchronously; an implementation that defers MUST still surface the `TypeError` at the first attempted `onUpdate` invocation, so a non-empty-`properties` target produces the throw at initial-sync delivery time | [SPEC.md § onUpdate validity](SPEC.md#onupdate-validity) |
| 12 | Hostile discovery | `{1O, 2}` (any implementation exposing `getWcBindableDeclaration` / `isWcBindable`) | A target whose `constructor.wcBindable` access throws (Proxy `get` trap that raises, throwing accessor on a Schema field, null-prototype constructor) MUST result in `getWcBindableDeclaration() === undefined`, `isWcBindable() === false`, and `bind()` returning a non-bindable no-op cleanup — no error escapes the helpers | [SPEC.md § Discovery API](SPEC.md#discovery-api) (MUST NOT throw) |
| 13 | Deferred sync ordering | `{1O}` for general-purpose browser JS implementations targeting `HTMLElement` with `syncOn: "connect"`. MAY be skipped **only** under the spec-defined fallback conditions: non-browser runtime without DOM globals, non-`HTMLElement` / synthetic / already-connected target, or an explicitly scoped profile that documents non-support of browser DOM deferred-sync. A `{1O}` implementation **SHOULD NOT** skip this vector merely by ignoring `syncOn: "connect"` — see body | Under `syncOn: "connect"`, a setter-driven property mutation on the still-unconnected target (which dispatches the change event as a side effect) MUST surface the event to `onUpdate` first; the deferred initial sync runs afterward and delivers `target[prop.name]` as read at connection time | [SPEC.md § Initial Value Synchronization → Ordering vs subsequent events](SPEC.md#ordering-vs-subsequent-events) |
| 14 | Cleanup-throw containment | `{1O, 2}` (and any 1O implementation that hands a cleanup function back to the caller) | If the first listener removal in the cleanup chain throws (hostile `removeEventListener`), the remaining listeners and `MutationObserver`s registered by the same `bind()` call MUST still be torn down; the secondary cleanup-time error is swallowed | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) (the "MUST continue running the remaining cleanup callbacks" paragraph) |
| 15 | Reserved names | `{3-consumer}` and `{3-producer}` (and `{3-both}`) | A declaration containing a `properties` / `inputs` / `commands` `name` that begins with `@wc-bindable/` MUST cause the consumer-side proxy constructor and the producer-side shell constructor to throw synchronously with an `Error` whose `error.code === "WC_BINDABLE_RESERVED_NAME"`; no wire traffic MUST be sent for such a name even if validation is bypassed. The pinned code follows from the locally-synthesized-error MUST in [SPEC-extensions.md § Error envelope](SPEC-extensions.md#error-envelope) — the construction-time rejection is a known protocol condition and the `Error` is built by the proxy / shell itself | [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) (Normative minimum) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_RESERVED_NAME` row) |
| 16 | Queue not transactional | `{3-consumer}` and `{3-both}` | A queued `setWithAck` whose settlement rejects does NOT cancel a queued `invoke` issued after it. **FIFO ordering preserves order, not dependency** — a failed queued entry does not auto-cancel later entries; each settles per its own rules | [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) ("Queue ordering is not transactional") |
| 17 | `set` pre-sync queue | `{3-consumer}` and `{3-both}` | Pre-sync fire-and-forget `set` SHOULD queue with id-bearing calls so caller order is preserved across mixed traffic (default profile). A low-latency-profile implementation MAY send `set` immediately and MUST document the choice in its public API surface. Both profiles MUST throw synchronously from `set()` on declared-name / JsonValue validation failure | [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) (`set` row) |
| 18 | Late envelope drop | `{3-consumer}` and `{3-both}` | A `return` / `throw` envelope arriving for an `id` whose pending entry has already timed out or been aborted MUST be silently dropped (with SHOULD warn-log); the consumer `Promise` MUST NOT re-settle | [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) |
| 19 | Re-entrant getter dispatch | `{1O}` (any 1O-claiming bind implementation observing a non-conformant producer) | A producer-side property getter that synchronously dispatches its declared change event during initial sync produces a double `onUpdate` (dispatch-first, sync-second). The adapter MUST faithfully deliver both calls in that order; deduplication / detection / repair is NOT the adapter's job — the producer MUST NOT cause the re-entry | [SPEC.md § Event detail vs Property Read](SPEC.md#event-detail-vs-property-read) (producer-side rule) + [§ Producer Obligations](SPEC.md#producer-obligations) |
| 20 | Reserved prototype-pollution names | `{3-consumer}` and `{3-producer}` (and `{3-both}`) | A declaration containing a `properties` / `inputs` / `commands` `name` exactly equal to `"__proto__"`, `"constructor"`, or `"prototype"` MUST cause the consumer-side proxy constructor and the producer-side shell constructor to throw synchronously with an `Error` whose `error.code === "WC_BINDABLE_RESERVED_NAME"`; no wire traffic MUST be sent for such a name. The same rule as the `@wc-bindable/` prefix vector (#15) — including the same pinned `code` — applied to the second normative reserved-name rule | [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) (rule 2) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_RESERVED_NAME` row) |
| 21 | Duplicate pending `id` rejection | `{3-producer}` and `{3-both}` | If the producer receives a `cmd` or id-bearing `set` whose `id` matches a pending entry (return/throw not yet emitted), the producer MUST NOT execute the later message and **MUST NOT emit a `return` / `throw` envelope carrying the duplicate `id` as the response to the later message** (the wire `id` would be ambiguous and a conformant consumer would settle the original call against it). Two conformant producer responses, with different effects on the original pending entry: (a) **log + drop path** — keep the first pending entry untouched (MUST NOT cancel, reject, or otherwise settle it; the original call continues to its natural settlement); silently drop the later duplicate-`id` message. (b) **TerminalFailure path** — transition the channel to TerminalFailure with a synthetic `WC_BINDABLE_DUPLICATE_ID` reason; as part of standard channel teardown the producer MAY reject every outstanding pending entry (including the original whose `id` was duplicated). Neither path emits a wire `return` / `throw` carrying the duplicate `id` as the later message's reply | [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id-constraints bullet) |
| 22 | Empty-string `id` rejection | `{3-producer}` and `{3-both}` | An inbound `cmd` or id-bearing `set` whose `id` is `""` (or any non-string) MUST be treated as malformed. The producer MUST log + drop (no `throw` reply is reachable, since no conformant consumer allocates `""` to await on) and MUST NOT touch the Core | [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id-constraints bullet, first sub-bullet) |
| 23 | Malformed `sync` ⇒ terminal | `{3-consumer}` and `{3-both}` | A malformed `sync` response (missing `values`, type-mismatched fields) MUST cause the consumer-side proxy to settle every queued pending entry as Rejected in caller order with a `WC_BINDABLE_PROTOCOL_ERROR`-coded error, transition to TerminalFailure, and signal the transport to dispose. This is the one consumer-side path where a single malformed envelope escalates to teardown | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| 24 | Malformed `return`/`throw` ⇒ drop or per-entry reject | `{3-consumer}` and `{3-both}` | A malformed `return` or `throw` envelope MUST NOT close the transport. If the `id` field is well-formed AND matches a pending entry, the proxy MUST reject that entry with a `WC_BINDABLE_PROTOCOL_ERROR`-coded synthetic error built locally (NOT pass-through the malformed `error` object). Otherwise drop + warn-log | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| 25 | `update.value` absence via key-presence | `{3-consumer}` and `{3-both}` | The consumer-side proxy MUST distinguish "the `value` key is absent" from "the `value` key is present and holds `undefined`" via key-presence check (`Object.hasOwn(msg, "value")`), not via `msg.value === undefined`. The two are equivalent post-`JSON.parse` but the spec contract is key-presence, not value comparison — implementations that use `=== undefined` are non-conformant against non-`JSON.parse` boundaries (in-process test harnesses, hand-rolled envelopes) | [SPEC-extensions.md § Update envelope value field](SPEC-extensions.md#update-envelope-value-field) (hasOwn rule) |
| 26 | Transport at-most-once delivery | Any transport adapter packaged with `{3-consumer}` / `{3-producer}` / `{3-both}` | A conformant transport adapter MUST deliver each accepted `send(message)` to the peer's `onMessage` at most once. Adapters built on a medium that may duplicate frames MUST either de-duplicate at the adapter boundary (e.g. via a per-frame sequence number the adapter strips before invoking `onMessage`) or treat any observed duplication as a terminal transport failure (`onClose` fires; subsequent traffic dropped). Test by injecting a duplicate frame at the adapter's underlying medium and asserting one of the two behaviors; silent double-delivery to `onMessage` is non-conformant. **For transports whose underlying medium cannot duplicate frames under test** (a strict in-process mock, WebSocket-over-TCP with no proxy in front of it, single-`MessagePort` peer-to-peer), the duplicate-injection setup is not reachable and the vector MAY be satisfied by inspecting the adapter's `send` / `onMessage` paths and asserting it contains no retry / replay code path that can call `onMessage` twice for one accepted `send()` — i.e. the at-most-once property holds by construction rather than by runtime defense. Implementations SHOULD document which of the two satisfaction modes their adapter uses | [SPEC-extensions.md § Transport adapter contract](SPEC-extensions.md#transport-adapter-contract) (invariant 7) |
| 27 | `dispose()` rejects pending in caller order; late envelopes dropped | `{3-consumer}` and `{3-both}` | `dispose()` MUST reject every pending `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` entry in **caller order** (FIFO across the pending table) before returning. Each rejection MUST carry `error.code === "WC_BINDABLE_DISPOSED"` per [§ Error envelope](SPEC-extensions.md#error-envelope) (the locally-synthesized-error MUST applies). Any subsequent inbound `return` / `throw` envelope referencing one of the already-rejected `id`s MUST be silently dropped (SHOULD warn-log) — the consumer `Promise` MUST NOT re-settle. `set()` after `dispose()` MUST throw synchronously with the same `WC_BINDABLE_DISPOSED` code on the thrown Error; `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` after `dispose()` MUST return an already-rejected `Promise` with the same code. `dispose()` itself MUST be idempotent (safely re-callable as a no-op) | [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods) + [§ Pending-call lifecycle](SPEC-extensions.md#pending-call-lifecycle-setwithack--setwithackoptions--invoke--invokewithoptions) + [§ AckOptions](SPEC-extensions.md#ackoptions) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_DISPOSED` row) |
| 28 | `reconnect()` after TerminalFailure: fresh `sync`; old pending NOT replayed | `{3-consumer}` and `{3-both}` that ship `reconnect()` (OPTIONAL per [§ Lifecycle methods](SPEC-extensions.md#lifecycle-methods); implementations that omit `reconnect` are conformant and this vector is N/A) | After the channel enters TerminalFailure, every pending entry MUST have been rejected (per vector 27's drain rule applied to TerminalFailure). On `reconnect(transport)` with a fresh transport, the proxy MUST send a new `{ "type": "sync" }` envelope and MUST NOT replay any of the previously-rejected pending messages on the new transport. `reconnect()` MUST throw synchronously when the proxy is already disposed OR when the existing transport is still active (re-attaching to a healthy connection is a programmer error) | [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods) (reconnect row) + [§ Remote proxy lifecycle](SPEC-extensions.md#remote-proxy-lifecycle) (TerminalFailure → Reconnecting → PreSync) |
| 29 | Cache validity across TerminalFailure / Reconnecting | `{3-consumer}` and `{3-both}` | During TransientFailure, TerminalFailure, and Reconnecting (before the next `sync` response arrives), the per-property cache MUST be preserved as last-known-value: `proxy.<N>` reads the same value it returned before the lifecycle transition, and `N in proxy` stays `true` for `N` that was cached before the transition. The proxy MUST NOT zero / clear / mark-stale the cache merely because the transport state changed. The new `sync` response (after reconnect) re-applies the [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode) rules diff-style: `N` now present in `values` / `undefinedProperties` updates the cache and re-fires `onUpdate`; `N` now omitted from both (and not in `getterFailures`) removes the cache entry and flips `has` back to `false` without dispatching a synthetic removal event | [SPEC-extensions.md § Cache validity across transport lifecycle](SPEC-extensions.md#cache-validity-across-transport-lifecycle) |
| 30 | Locally-synthesized errors MUST carry `code` | `{3-consumer}` and `{3-both}` (consumer-side synthetic errors); `{3-producer}` and `{3-both}` (producer-side `throw` envelope emission for locally-synthesized failures) | Every locally-synthesized protocol error reaching the consumer's `catch` MUST carry `error.code` drawn from the registry in [SPEC-extensions.md § Error envelope → Machine-readable code field](SPEC-extensions.md#error-envelope). Concretely test: (a) `setWithAckOptions(name, value, { timeoutMs: 1 })` against an unresponsive producer rejects with `error.code === "WC_BINDABLE_TIMEOUT"`; (b) `invokeWithOptions(name, args, { signal })` aborted after send rejects with `error.code === "WC_BINDABLE_ABORTED"`; (c) `setWithAck(name, new Date())` (or any non-`JsonValue`) rejects with `error.code === "WC_BINDABLE_INVALID_JSON_VALUE"`; (d) malformed inbound `sync` (per vector 23) drains pending with `error.code === "WC_BINDABLE_PROTOCOL_ERROR"`; (e) `proxy.dispose()` with one or more pending calls drains them with `error.code === "WC_BINDABLE_DISPOSED"` (per vector 27); (f) transport-induced TerminalFailure drains pending with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"` (per vector 28); (g) `setWithAckOptions(name, value, { timeoutMs: -1 })` (or any negative / non-finite / non-numeric `timeoutMs`) rejects with `error.code === "WC_BINDABLE_INVALID_ACK_OPTIONS"` AND `error.name === "RangeError"` (the RangeError-shaped minimum requirement per [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions)). The spec additionally requires the returned Promise to be **synchronously** already-rejected (not microtask-deferred), but this vector's `try / await / catch` shape verifies the observable error shape only — synchrony timing is tracked as future-work, see "[Synchrony of `setWithAckOptions` / `invokeWithOptions` invalid-`timeoutMs` rejection](#what-this-list-does-not-cover)". Application throws from the producer's command / setter (canonical example: `target.fetch()` throws a `RangeError`) MAY omit `code` or carry `WC_BINDABLE_REMOTE_THROW` — application throws MUST NOT repurpose any other registered `WC_BINDABLE_*` code | [SPEC-extensions.md § Error envelope → Code-emission rule for locally-synthesized errors](SPEC-extensions.md#error-envelope) (origin-conditional MUST / MAY, both emission sites) |
| 31 | `getterFailures` does NOT touch cache; subsequent `update` recovers | `{3-consumer}` and `{3-both}` | Setup: producer's first `sync` response includes `values: { v: 42 }` and `capabilities: { setAck: true, getterFailures: true }`. After consumer caches `v === 42`, force a re-sync (via reconnect or a producer-issued fresh `sync`) whose response carries `values: {}` and `getterFailures: ["v"]`. Expected: (a) `proxy.v === 42` is preserved (cache NOT reverted to `undefined`); (b) no `onUpdate` event is dispatched for `v` as part of the failed-getter sync; (c) the consumer logger receives a warn-level message naming `v`; (d) a subsequent `{ type: "update", name: "v", value: 99 }` from the producer normally updates the cache to `99` and dispatches `onUpdate("v", 99)` — the getter failure does NOT permanently taint the property | [SPEC-extensions.md § `getterFailures` semantics](SPEC-extensions.md#getterfailures-semantics) + [§ Consumer-side sync-response handling](SPEC-extensions.md#consumer-side-sync-response-handling--reference-pseudocode) |
| 32 | Malformed `update` drops + warns; transport stays open; next valid `update` processed | `{3-consumer}` and `{3-both}` | Inject a malformed `update` envelope (missing `name`, non-string `name`, or present `value` that fails `JsonValue` deep validation). Expected: (a) the proxy does NOT throw, does NOT close the transport, and does NOT write the cache for the property whose `name` was malformed (if any); (b) the consumer's `bind()` callback receives NO event for the malformed envelope; (c) the proxy logger receives a warn-level entry naming the field that failed; (d) a subsequent well-formed `{ type: "update", name: "value", value: "ok" }` envelope is processed normally — the cache updates, `onUpdate("value", "ok")` fires. This is the asymmetry from vector 23: malformed `sync` escalates to TerminalFailure, malformed `update` degrades gracefully | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) (malformed `update` row) |
| 33 | Deferred initial-sync throw — `unbind()` is a literal no-op afterward | `{1O}` for general-purpose browser JS implementations that support `syncOn: "connect"` (skip applies under the same conditions as vector 13) | A `syncOn: "connect"` bind where the deferred initial-sync throws (e.g. a property getter throws on read inside the `MutationObserver` microtask). Expected: (a) the adapter's installed cleanups (listeners + the `MutationObserver`) MUST be torn down before the throw escapes the microtask; (b) the throw surfaces as an uncaught error on the dispatching microtask (`window.onerror` / `reportError` / `process.on('uncaughtException')`), NOT as a synchronous throw from the original `bind()` call frame; (c) the `unbind` function the caller received at `bind()` time MUST still be safe to invoke after the throw — calling `unbind()` MUST be a literal no-op (the closure-level `disposed` re-entry guard was set by the cleanup-on-throw path); (d) the `unbind()` call MUST NOT re-walk the cleanup list, MUST NOT throw, MUST NOT trigger any further uncaught error | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) (the "If a deferred initial-sync (`syncOn: \"connect\"`) throws" paragraph) + [§ bind() state machine summary](SPEC.md#bind-state-machine-summary) (InitialSyncing → Disposed via deferred throw) |
| 34 | `set()` — sync throw on terminal (with `WC_BINDABLE_TERMINAL_FAILURE` code), no throw on transient outage | `{3-consumer}` and `{3-both}` — the line between terminal and transient is transport-implementation-defined per [SPEC-extensions.md § Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2); the canonical vector uses a controllable mock transport that lets the test force each state explicitly | Setup: a mock transport with explicit `setTerminal()` / `setTransient()` hooks. Bring the proxy to Active. Expected — terminal path: after `mockTransport.setTerminal()` (e.g. emit `onClose` and refuse to accept further `send()`), `proxy.set("x", 1)` MUST throw synchronously at the call site, and the thrown Error MUST carry `error.code === "WC_BINDABLE_TERMINAL_FAILURE"` per the locally-synthesized-error MUST in [§ Error envelope](SPEC-extensions.md#error-envelope) (NOT `WC_BINDABLE_PROTOCOL_ERROR`, which is reserved for wire-protocol bugs; NOT `WC_BINDABLE_DISPOSED`, which is reserved for consumer-initiated teardown — keeping the three transport-side codes distinct is what lets the consumer pick the right recovery branch). Expected — transient path: after `mockTransport.setTransient()` (the transport's own reconnect/backoff layer is masking an outage; the proxy has NOT been notified of terminal failure), `proxy.set("x", 1)` MUST NOT throw — the message is either eventually delivered or silently lost (at-most-once contract). Verifying the silent-drop case: the test asserts only the absence of a synchronous throw and the absence of a wire frame on the underlying socket; whether the message lands on a later recovery is implementation-defined. The bifurcation is the canonical safety mechanism `setWithAck` is designed around | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `set` row) + [§ Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_TERMINAL_FAILURE` registry entry + locally-synthesized-error MUST) + [SPEC-extensions.md § Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (the `set` rows in both tables) |
| 35 | Fingerprint `protocol` mismatch ⇒ TerminalFailure (always, regardless of strict mode) | `{3-consumer}` and `{3-both}` | Setup: proxy constructed against a local declaration with `protocol: "wc-bindable"`; producer emits a `sync` whose `declarationFingerprint.protocol` is a different string (e.g. `"wc-bindable-2"`) and whose other fingerprint fields match. Expected: (a) every queued pending entry rejects in caller order with `error.code === "WC_BINDABLE_PROTOCOL_ERROR"` (this is the code for the *trigger* — the wire-protocol disagreement that drove the transition); (b) the proxy transitions to TerminalFailure; (c) **after** the transition, subsequent `set` throws synchronously with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"`, and subsequent `setWithAck` / `invoke` return already-rejected promises with the same `WC_BINDABLE_TERMINAL_FAILURE` code (this is the code for *new calls against an already-terminal proxy*, per vector 34's terminal-path rule — distinct from the drain code so the consumer's recovery branch can tell "wire-protocol disagreement caused teardown" apart from "I called set on an already-dead proxy"); (d) **no wire reply is emitted** for the offending `sync` (the new `protocol` identifier means the consumer can no longer prove its envelope shapes would be understood); (e) the transport is signaled to dispose. **Strict mode setting is irrelevant** — the `protocol`-mismatch terminal posture is a MUST regardless of `strictFingerprint` opt-in. This is the breaking-compatibility boundary defined in [SPEC.md § Versioning](SPEC.md#versioning); continuing past a `protocol` mismatch would let a v1 consumer silently process v2-shaped envelopes, the exact silent-corruption scenario [§ Wire format versioning](SPEC-extensions.md#wire-format-versioning) item 4 exists to prevent | [SPEC-extensions.md § Declaration fingerprint](SPEC-extensions.md#declaration-fingerprint) (`protocol differs` bullet) + [§ Wire format versioning](SPEC-extensions.md#wire-format-versioning) item 4 + [§ Error envelope](SPEC-extensions.md#error-envelope) (the three-way code split: `WC_BINDABLE_PROTOCOL_ERROR` for the trigger, `WC_BINDABLE_TERMINAL_FAILURE` for subsequent calls, `WC_BINDABLE_DISPOSED` for consumer-initiated teardown) |
| 36 | Legacy fingerprint without `protocol` is NOT malformed — falls through to non-`protocol` comparison | `{3-consumer}` and `{3-both}` | Setup: producer emits a `sync` whose `declarationFingerprint` object contains exactly `{ version, properties, inputs, commands }` — the `protocol` field is **omitted entirely** (the legacy-fingerprint shape from before the field was added). Expected: (a) the proxy does NOT transition to TerminalFailure; (b) the proxy does NOT reject any pending entry on the basis of the missing field; (c) the consumer does NOT log a fingerprint-shape / malformed-envelope error (the missing-`protocol`-field case is the legacy-fingerprint bridge, NOT a malformed envelope, and is explicitly carved out from the malformed-`sync` ⇒ terminal rule of vector 23); (d) the proxy proceeds to Active and per-message rules apply normally. The missing-`protocol` axis is treated as **comparison-unavailable** — equivalent to the no-fingerprint legacy fallback applied to that field only. If the remaining fields also match the consumer's local fingerprint, no warning fires; if they differ, the standard non-`protocol` mismatch rule (vector 37) applies | [SPEC-extensions.md § Declaration fingerprint](SPEC-extensions.md#declaration-fingerprint) (`Legacy fingerprint shape (no protocol)` paragraph) |
| 37 | Non-`protocol` fingerprint mismatch — warn+continue (default mode), TerminalFailure (strict mode) | `{3-consumer}` and `{3-both}`. The strict-mode branch is conditional on implementations that ship a `strictFingerprint` (or equivalent) option; implementations that do not ship strict mode satisfy only the default-mode sub-case | Setup: proxy constructed with a local declaration that agrees with the producer on `protocol` but differs on at least one of `version` / `properties` / `inputs` / `commands` (e.g. local declares `commands: ["fetch"]`, producer's fingerprint carries `commands: ["fetch", "abort"]`). Two sub-cases: **Default mode** — (a) the proxy does NOT transition to TerminalFailure; (b) the consumer logger receives a warn-level entry identifying which field(s) differ; (c) pending queue entries are NOT rejected on the basis of the mismatch (subsequent per-message rejections — e.g. an `invoke("abort")` against a consumer that doesn't know `"abort"` — still fire per their own rules); (d) the proxy proceeds to Active. **Strict mode** (`strictFingerprint: true` or implementation-equivalent) — (a) every queued pending entry rejects in caller order with `error.code === "WC_BINDABLE_PROTOCOL_ERROR"` (the trigger code); (b) the proxy transitions to TerminalFailure; (c) **after** the transition, subsequent `set` throws synchronously with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"`, and subsequent `setWithAck` / `invoke` return already-rejected promises with the same `WC_BINDABLE_TERMINAL_FAILURE` code (per vector 34's terminal-path rule — distinct from the drain code, same separation as vector 35); (d) **no wire reply is emitted**; (e) the transport is signaled to dispose. The split — `protocol` always terminal (vector 35), non-`protocol` opt-in terminal — is the canonical asymmetry between the two compatibility tiers | [SPEC-extensions.md § Declaration fingerprint](SPEC-extensions.md#declaration-fingerprint) (`Non-protocol mismatch` bullet + `Strict-mode opt-in` paragraph) |

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
- `proxy.setWithAck("url", "/api/users")` returns an **already-rejected** `Promise` (synchronously). The rejection `Error` MUST carry `error.code === "WC_BINDABLE_SET_ACK_UNSUPPORTED"` per the locally-synthesized-error MUST in [SPEC-extensions.md § Error envelope → Code-emission rule for locally-synthesized errors](SPEC-extensions.md#error-envelope). Pattern-matching on `error.message` substrings is non-conformant — the `code` is the testable signal because it survives `message` localization, runtime variation, and implementation-specific phrasing
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
- Construction MUST throw synchronously with an `Error` whose `error.code === "WC_BINDABLE_RESERVED_NAME"` per [SPEC-extensions.md § Error envelope](SPEC-extensions.md#error-envelope) (locally-synthesized-error MUST). The `error.message` SHOULD additionally name the offending reserved string so operators can diagnose the rejection from log output alone, but the `code` is the testable signal — pattern-matching on `error.message` substrings is non-conformant for the same reason as vector 10. The call site sees the throw on its own frame
- No reference to the constructed proxy / shell is returned to the caller — the failure is total
- The transport stub MUST observe **zero** outbound messages — rejection happens at construction, before any `sync` request is sent
- If the consumer-side proxy somehow advances past construction (non-conformant), the producer's per-message reserved-name gate MUST still reject any wire frame whose `name` is reserved (with a `throw` envelope carrying `error.code === "WC_BINDABLE_RESERVED_NAME"` for id-bearing inbound messages); this is the defense-in-depth check called out in [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) and the producer-side dispatcher footnote

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

### 20. Reserved prototype-pollution names — `__proto__` / `constructor` / `prototype` reject at proxy / shell construction

**Setup.** Three declarations, one per reserved name, used to construct a consumer-side proxy and a producer-side shell. The reserved-name check MUST fire at construction time for both sides regardless of which descriptor list (`properties` / `inputs` / `commands`) the name lives in:

```javascript
const declProto = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "__proto__", event: "x:p-changed" }],
};

const declConstructor = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "v", event: "x:v-changed" }],
  inputs: [{ name: "constructor" }],
};

const declPrototype = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "v", event: "x:v-changed" }],
  commands: [{ name: "prototype" }],
};

class Producer extends EventTarget {}
Producer.wcBindable = declProto;  // (and the same shape for the other two)
```

**Action.** For each of the three declarations:
1. `createRemoteCoreProxy(decl, transport)` on the consumer side.
2. `new RemoteShellProxy(new Producer(), transport)` on the producer side.

Use a recording transport that asserts nothing was sent on the wire.

**Expected.**
- Both calls MUST throw synchronously with an `Error` whose `error.code === "WC_BINDABLE_RESERVED_NAME"`.
- Neither the consumer-side proxy nor the producer-side shell MUST emit any wire envelope (no `sync`, no `set`, no `cmd`) for the offending name — the check is at the construction-time gate, not at message-send time.
- The thrown Error's `message` SHOULD identify which name was rejected (so callers do not have to re-walk the declaration to find the culprit), but `error.code` is the load-bearing classifier.
- The same expectation holds whether the reserved name appears in `properties`, `inputs`, or `commands`; the gate is descriptor-list-agnostic.

**Implementation note.** This is the same rule as the `@wc-bindable/` prefix vector (#15), applied to the second normative reserved-name rule. Implementations that materialize per-property caches via plain `{}` (e.g. `cache[name] = value`) without this check would pollute the host object's prototype chain on a `__proto__` / `constructor` / `prototype` declaration — the construction-time rejection is the cross-implementation single-checkpoint mitigation. Implementations MAY *additionally* use null-prototype containers internally; the reservation is the simpler defense that this vector verifies.

**Spec reference.** [SPEC-extensions.md § Reserved names](SPEC-extensions.md#reserved-names) (rule 2) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_RESERVED_NAME` row).

---

### 21. Duplicate pending `id` rejection (producer side)

**Setup.** A producer-side shell in Active state. The consumer (or a test harness simulating one) sends two `cmd` envelopes carrying the **same `id`** before the first one has been settled (no `return` / `throw` emitted yet). The producer's command implementation is asynchronous so the first call is still pending when the second arrives:

```javascript
class SlowProducer extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [],
    commands: [{ name: "slow", async: true }],
  };
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return "first-done";
  }
}

const transport = new RecordingTransport();
const shell = new RemoteShellProxy(new SlowProducer(), transport);

transport.emitInbound({ type: "cmd", name: "slow", id: "dup-1", args: [] });
transport.emitInbound({ type: "cmd", name: "slow", id: "dup-1", args: [] });
```

**Action.** Wait long enough for both the original `slow()` to complete and any duplicate-handling settlement to fire. Inspect `transport.sentMessages`.

**Expected.** Two conformant producer responses are defined; an implementation MUST follow exactly one of them:

**Path (a) — Log + drop (default; SHOULD prefer this for accidental-duplicate resilience):**
- The producer logs a warning naming the duplicate `id`.
- The duplicate (second) message MUST NOT execute — no second invocation of `target.slow()`.
- The original pending entry MUST NOT be canceled, rejected, or otherwise settled by the duplicate-handling code path — it continues to its natural settlement (`target.slow()` still runs and emits its `return`).
- Exactly one `{ type: "return", id: "dup-1", value: "first-done" }` envelope is sent on the wire (the original's natural reply).
- **No `return` or `throw` envelope is ever sent that carries the duplicate `id` as the response to the later message** — the response `id` would be ambiguous from the consumer's perspective (a conformant consumer would settle the *original* against it).

**Path (b) — TerminalFailure (MAY, for strict deployments treating duplicate-`id` as a protocol violation):**
- The producer transitions the channel to TerminalFailure with a synthetic `WC_BINDABLE_DUPLICATE_ID`-coded reason.
- The transport is signaled to dispose; `onClose` fires.
- As part of standard channel teardown the producer MAY reject every outstanding pending entry — including the original `slow()` whose `id` was duplicated — typically by surfacing a local synthetic error to producer-side observers; this is part of teardown, not a per-duplicate response.
- The producer SHOULD NOT emit a final wire `throw` envelope carrying the duplicate `id` (or the original `id`) merely to surface the duplicate-detection reason — local synthetic rejection plus the transport `onClose` is the cleaner channel-failure signal.

**Both paths.** No double execution of `target.slow()`. No wire `return` / `throw` carrying the duplicate `id` as the later message's reply.

**Spec reference.** [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id-constraints bullet → "On the producer side, if an inbound `cmd` or id-bearing `set` carries an `id` that matches an entry the producer has not yet settled").

---

### 22. Empty-string `id` rejection (producer side)

**Setup.** A producer-side shell in Active state. The harness emits malformed inbound messages whose `id` is `""` (or otherwise not a non-empty string):

```javascript
const transport = new RecordingTransport();
const shell = new RemoteShellProxy(new Producer(), transport);

transport.emitInbound({ type: "cmd", name: "doThing", id: "", args: [] });
transport.emitInbound({ type: "set", name: "x", value: 1, id: "" });
transport.emitInbound({ type: "cmd", name: "doThing", id: 42, args: [] });  // non-string
```

**Action.** Inspect `transport.sentMessages` and any logger output.

**Expected.**
- The producer MUST treat each as malformed and **log + drop**.
- **No `throw` reply is emitted** — a wire `throw` whose `id: ""` is unreachable for any conformant consumer (the consumer never allocates `""` to await on), so echoing it back has no recipient.
- The producer MUST NOT touch the Core: no `doThing()` invocation, no `target.x = 1` setter call.
- The transport MUST stay open — the malformed message does NOT escalate to TerminalFailure on its own (it is treated as a malformed-inbound message, not a wire-protocol disagreement).

**Conformance interpretation.** This is the carve-out from the "id-bearing malformed inbound" rule that drives vector 21 / the spec's "if any well-formed `id`-bearing message is reachable the producer MUST `throw`" requirement. Empty-string `id` does NOT count as "well-formed `id`-bearing" because the consumer cannot disambiguate the echoed reply, so the conformant action is silent drop with diagnostic logging — distinct from the `throw`-with-`WC_BINDABLE_PROTOCOL_ERROR` path that applies to malformed-but-id-bearing messages.

**Spec reference.** [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id-constraints bullet, first sub-bullet → "id MUST be a non-empty string ... An empty-string id does not count as 'well-formed id-bearing'").

---

### 23. Malformed `sync` ⇒ TerminalFailure (consumer side)

**Setup.** A consumer-side proxy with several queued pre-sync pending entries (one `setWithAck`, one `invoke`, plus a fire-and-forget `set`). A recording transport that delivers a malformed `sync` response (missing the required `values` field, or with `values` typed as a non-object):

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);

const p1 = proxy.setWithAck("url", "/api/a");
const p2 = proxy.invoke("fetch");
proxy.set("flag", true);  // fire-and-forget

// Producer responds with a malformed sync — no `values` field.
transport.emitInbound({ type: "sync" });  // missing `values`
```

**Action.** Inspect the settlement of `p1` and `p2`, the proxy's lifecycle state, and whether the transport was disposed.

**Expected.**
- Both `p1` and `p2` MUST reject **in caller order** (`p1` before `p2`).
- Each rejection's `error.code === "WC_BINDABLE_PROTOCOL_ERROR"`.
- The proxy MUST transition to TerminalFailure.
- The transport's `dispose()` MUST be called (the proxy signals teardown).
- Any subsequent `set()` MUST throw synchronously with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"` (NOT `WC_BINDABLE_PROTOCOL_ERROR` — the trigger code is distinct from the post-terminal-call code per vector 34's terminal-path rule).
- Any subsequent `setWithAck` / `invoke` MUST return an already-rejected `Promise` with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"`.
- The same vector holds for any other malformed-`sync` shape: `values` present but a non-object (e.g. an array or string), `capabilities` present but non-object, `getterFailures` present but not an array of strings, `undefinedProperties` present but not an array of strings — any wire-shape rule violation on the `sync` envelope follows this path.

**Conformance interpretation.** Malformed `sync` is the **one consumer-side path** where a single malformed envelope escalates to TerminalFailure — distinct from malformed `update` (vector 32) which degrades gracefully, and distinct from malformed `return` / `throw` (vector 24) which is per-entry-recoverable. The asymmetry is deliberate: `sync` is the handshake, and continuing past a malformed handshake means the consumer cannot prove its envelope shapes will be understood by the peer (the same reasoning behind the protocol-mismatch terminal posture in vector 35).

**Spec reference.** [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) (malformed `sync` row).

---

### 24. Malformed `return` / `throw` ⇒ drop or per-entry reject (consumer side)

**Setup.** A consumer-side proxy in Active state with one outstanding `setWithAck` pending entry. The harness delivers two malformed envelopes back-to-back: (a) one with a well-formed `id` matching the pending entry but a malformed body; (b) one whose `id` is non-string / missing (no pending entry could match):

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(declaration, transport);
// (bring to Active via a valid sync response — omitted here for brevity)

const pending = proxy.setWithAck("name", "value");
const id = transport.lastSentId();  // the `id` the proxy allocated

// (a) malformed envelope whose id matches the pending entry
transport.emitInbound({ type: "return", id, value: { /* non-JsonValue */ NaN: true } });

// (b) malformed envelope with no usable id
transport.emitInbound({ type: "throw", id: 42, error: { code: "X" } });
```

**Action.** Inspect the settlement of `pending`, the proxy's lifecycle state, and any subsequent traffic.

**Expected.**
- The transport MUST NOT be closed by either malformed envelope — the proxy stays Active.
- **(a) id-matches path:** the proxy MUST reject the pending entry with `error.code === "WC_BINDABLE_PROTOCOL_ERROR"`. The rejection MUST be a **locally-synthesized synthetic error built by the consumer-side proxy** — the proxy MUST NOT pass-through the malformed `error` object (it has no protocol-defined shape).
- **(b) no-matching-id path:** the proxy MUST **drop the envelope + warn-log**. No pending entry is affected. The consumer `Promise` for any previously-issued call MUST NOT re-settle.
- A subsequent `setWithAck` / `invoke` issued after both malformed envelopes MUST behave normally (the channel stays usable; malformed `return` / `throw` is per-entry-recoverable, not channel-fatal).

**Conformance interpretation.** This is the asymmetry from vector 23 (malformed `sync` ⇒ terminal) and vector 32 (malformed `update` ⇒ drop). Malformed `return` / `throw` is **per-entry**: if the consumer can locate the pending entry via a well-formed `id`, it can synthesize a meaningful rejection (giving the caller a deterministic error.code) without escalating; if it cannot, dropping is the only safe action.

**Spec reference.** [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) (malformed `return` / `throw` row).

---

### 25. `update.value` absence via key-presence check (consumer side)

**Setup.** A consumer-side proxy in Active state. Three `update` envelopes for the same property, hand-rolled to exercise the `value`-key-presence distinction:

```javascript
const observed = [];
const unbind = bind(proxy, (name, value) => observed.push([name, value]));

// 1. `value` key present, holds a defined value.
transport.emitInbound({ type: "update", name: "v", value: 42 });

// 2. `value` key present, holds `undefined`.
//    (Reachable in-process — JSON.parse would strip this. The spec
//    contract is key-presence, not value comparison.)
transport.emitInbound({ type: "update", name: "v", value: undefined });

// 3. `value` key entirely absent.
transport.emitInbound({ type: "update", name: "v" });
```

**Action.** Inspect `observed`.

**Expected.**
- After envelope 1: `observed` ends with `["v", 42]`; `proxy.v === 42`.
- After envelope 2: `observed` ends with `["v", undefined]` (or `["v", null]` on the documented `CustomEvent.detail` divergence — see vector 6); the proxy's `value`-key-present envelope is treated as carrying the value, even when that value is `undefined`. The cache reflects `undefined`.
- After envelope 3: `observed` ends with `["v", undefined]` (or `["v", null]` per vector 6's divergence); the proxy's missing-`value`-key envelope is treated as the "current value is `undefined`" wire signal per the out-of-band-undefined rule. The cache reflects `undefined`.
- The conformant detection MUST use `Object.hasOwn(msg, "value")` (or an equivalent own-key check) — **not** `msg.value === undefined`. Implementations that conflate the two are non-conformant against any non-`JSON.parse` boundary (in-process test harnesses, hand-rolled envelopes, structured-clone-capable transports that bypass JSON serialization).

**Conformance interpretation.** Post-`JSON.parse` the two cases (`value: undefined` and no `value` key) are equivalent — JSON drops own-properties whose value is `undefined` during stringify. But the spec contract is key-presence, not value comparison, because the proxy's deserializer MAY not be `JSON.parse` (a transport adapter could `JSON.parse` once and forward the parsed object, or a test could hand the proxy a synthesized envelope directly). Using `=== undefined` on the consumer side makes the proxy non-conformant on those boundaries even though it would pass against a pure WebSocket+JSON setup.

**Spec reference.** [SPEC-extensions.md § Update envelope value field](SPEC-extensions.md#update-envelope-value-field) (the `Object.hasOwn` rule).

---

### 26. Transport at-most-once delivery (transport adapter)

**Setup.** Two test modes for the transport adapter under test. The adapter wraps some underlying medium (WebSocket, MessagePort, custom pub/sub, …). The vector applies to **any** transport adapter packaged with a `{3-consumer}` / `{3-producer}` / `{3-both}` implementation:

**Mode A — duplicate-injectable medium.** The adapter's underlying medium can be coerced into duplicating frames (a controllable mock, an adapter wrapping a pub/sub bus, a transport whose retry layer can replay an accepted send):

```javascript
const peer = createRecordingPeer();
const adapter = new MyTransport(peer.underlying);
adapter.send({ type: "set", name: "x", value: 1 });

// Inject a duplicate at the underlying medium.
peer.duplicateLastFrame();
```

**Mode B — non-duplicating medium.** The adapter's underlying medium cannot duplicate frames under test (strict in-process mock, WebSocket-over-TCP with no proxy in front of it, single-`MessagePort` peer-to-peer). The duplicate-injection setup is unreachable.

**Action.**

- **Mode A:** record every `onMessage` invocation on the peer. Inject one duplicate at the underlying medium.
- **Mode B:** inspect the adapter's `send` and `onMessage` code paths.

**Expected.**

**Mode A — at-most-once via runtime defense.** The adapter MUST satisfy ONE of:
- **(i) De-duplication at the adapter boundary.** The peer's `onMessage` fires **exactly once** for the original frame; the duplicate is silently filtered before invoking `onMessage`. The adapter's de-duplication metadata (sequence number, nonce, etc.) MUST live outside the wc-bindable protocol envelope (typically on the adapter's own framing layer) and MUST be stripped before `onMessage` invocation — see the spec's "De-duplication metadata is transport-private" rule.
- **(ii) Terminal-failure on observed duplication.** The adapter detects the duplicate and treats it as a non-resumable transport failure: `onClose` fires, subsequent traffic is dropped, no further `onMessage` invocations occur.

Silent double-delivery (peer's `onMessage` fires twice for one accepted `send()`) is **non-conformant** under Mode A.

**Mode B — at-most-once by construction.** The adapter satisfies the vector by inspection:
- The adapter's `send` and `onMessage` paths contain no retry / replay code that can call `onMessage` twice for one accepted `send()`.
- The at-most-once property holds by construction (the underlying medium delivers each accepted frame exactly once and the adapter is a thin pass-through).

Implementations SHOULD document which of the two satisfaction modes their adapter uses, so reviewers can locate the right test surface.

**Conformance interpretation.** Silent duplicate delivery is the most dangerous mode the spec defends against: fire-and-forget `set` (no `id`, at-most-once by design) has **no application-layer deduplication mechanism**, so a duplicated `set("count", n+1)` against a non-idempotent setter applies twice with no detectable signal at either end. Id-bearing call methods (`setWithAck` / `invoke`) tolerate adapter-level duplication only when the proxy's `id → pending` table happens to settle the duplicate as a late-envelope drop (vector 18) — that is incidental, not a design guarantee, and the adapter MUST NOT rely on it.

**Spec reference.** [SPEC-extensions.md § Transport adapter contract](SPEC-extensions.md#transport-adapter-contract) invariant 7 (At-most-once delivery) + the "De-duplication metadata is transport-private" paragraph immediately below it.

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
- `settleOrder.length === 3` and the entries appear in **caller order** — `[["p1", "WC_BINDABLE_DISPOSED", ...], ["p2", "WC_BINDABLE_DISPOSED", ...], ["p3", "WC_BINDABLE_DISPOSED", ...]]` — regardless of `Map` iteration order in the proxy's internal `id → pending` table. Both the **caller-order** rule and the `error.code === "WC_BINDABLE_DISPOSED"` rule are load-bearing per [SPEC-extensions.md § Error envelope](SPEC-extensions.md#error-envelope) (the locally-synthesized-error MUST). Implementations MAY also carry a richer `error.name` / `error.message` for human diagnostics, but the `code` value MUST be `WC_BINDABLE_DISPOSED` (not `WC_BINDABLE_PROTOCOL_ERROR`, which is reserved for wire-protocol bugs per the registry).
- `lateReSettle === false` — none of the three late envelopes injected after dispose re-settles the corresponding `Promise`. The proxy SHOULD log a warn-level entry for each late envelope it drops, but MUST NOT throw, MUST NOT reopen the transport, and MUST NOT re-fire `onUpdate` for any property.
- The second `proxy.dispose()` call returns without throwing — `dispose()` is unconditionally idempotent.
- After `dispose()`: `proxy.set("x", 1)` MUST throw synchronously with the same `error.code === "WC_BINDABLE_DISPOSED"` on the thrown Error; `proxy.setWithAck("x", 1)` / `proxy.invoke("fetch")` MUST return an already-rejected `Promise` with the same code.

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
let drainCode;
const drainedPromise = proxy.setWithAck("url", "/api/users")
  .catch((e) => { drainCode = e?.code; });

// Drive to TerminalFailure.
transport1.simulateTerminalFailure();
await drainedPromise; // settle (rejected) per vector 27 — drainCode now set

// Action: reconnect with a fresh transport.
const transport2 = new RecordingTransport();
proxy.reconnect(transport2);
```

**Action.** Inspect what `transport2` observes, and verify `transport2` does NOT see any replay of the previously-rejected `setWithAck("url", "/api/users")` message.

**Expected.**
- `drainCode === "WC_BINDABLE_TERMINAL_FAILURE"` — the pending entry drained by the TerminalFailure transition MUST reject with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"` per [SPEC-extensions.md § Error envelope](SPEC-extensions.md#error-envelope) (distinct from `WC_BINDABLE_DISPOSED` because the consumer did not call `dispose()`; the transport itself reached terminal state).
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

// (e) dispose() drains pending (per vector 27).
async function testDisposed() {
  const t = new RecordingTransport();
  const p = createRemoteCoreProxy(declaration, t);
  t.emitInbound({ type: "sync", values: {}, capabilities: { setAck: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = p.setWithAck("x", 1).catch((e) => e);
  p.dispose();
  const err = await pending;
  return err.code; // expected: "WC_BINDABLE_DISPOSED"
}

// (f) Transport TerminalFailure drains pending (per vector 28).
async function testTerminalFailure() {
  const t = new RecordingTransport();
  const p = createRemoteCoreProxy(declaration, t);
  t.emitInbound({ type: "sync", values: {}, capabilities: { setAck: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = p.setWithAck("x", 1).catch((e) => e);
  t.simulateTerminalFailure();
  const err = await pending;
  return err.code; // expected: "WC_BINDABLE_TERMINAL_FAILURE"
}

// (g) Invalid AckOptions.timeoutMs (negative / non-finite / non-numeric).
async function testInvalidAckOptions() {
  const t = new RecordingTransport();
  const p = createRemoteCoreProxy(declaration, t);
  t.emitInbound({ type: "sync", values: {}, capabilities: { setAck: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let err;
  try {
    await p.setWithAckOptions("x", 1, { timeoutMs: -1 });
  } catch (e) { err = e; }
  return { code: err.code, name: err.name };
  // expected: { code: "WC_BINDABLE_INVALID_ACK_OPTIONS", name: "RangeError" }
}
```

**Expected.**
- `testTimeout()` resolves to `"WC_BINDABLE_TIMEOUT"`.
- `testAbort()` resolves to `"WC_BINDABLE_ABORTED"`.
- `testInvalidJson()` resolves to `"WC_BINDABLE_INVALID_JSON_VALUE"`.
- `testMalformedSync()` resolves to `"WC_BINDABLE_PROTOCOL_ERROR"`.
- `testDisposed()` resolves to `"WC_BINDABLE_DISPOSED"` (NOT `WC_BINDABLE_TERMINAL_FAILURE` and NOT `WC_BINDABLE_PROTOCOL_ERROR` — the dispose was consumer-initiated, not a transport outage or wire bug).
- `testTerminalFailure()` resolves to `"WC_BINDABLE_TERMINAL_FAILURE"` (NOT `WC_BINDABLE_DISPOSED` — the transport reached terminal state on its own; the consumer did not call `dispose()`).
- `testInvalidAckOptions()` resolves to `{ code: "WC_BINDABLE_INVALID_ACK_OPTIONS", name: "RangeError" }`. The `code` value MUST NOT be `WC_BINDABLE_PROTOCOL_ERROR` — nothing on the wire is malformed; this is a call-site argument validation failure, symmetric with `WC_BINDABLE_INVALID_JSON_VALUE` for the `value` / `args` validation gate. The `name` value MUST be exactly `"RangeError"` per the RangeError-shaped definition in [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) — the spec's minimum requirement is `error.name === "RangeError"` regardless of whether the implementation actually constructs the rejection with `new RangeError(...)` (cross-realm / non-JS implementations are not required to preserve `instanceof RangeError`, so the test asserts on `name` rather than prototype identity).

  > **Vector scope: error-shape only, not synchrony.** The spec ALSO requires the returned `Promise` to be **synchronously** already-rejected (not microtask-deferred) per [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions), but this vector's `try / await / catch` shape cannot distinguish the two — both produce identical observable behavior under `await`. The "did not throw synchronously" half of the spec rule IS exercised here (a synchronous throw would skip the `catch` branch and fail the test), but "the returned Promise was already in rejected state at function return" is not. Tightening that check requires a different observation pattern (`Promise.race` against a sentinel, inspecting Promise state via host introspection, etc.) and is tracked as future-work — see "[Synchrony of `setWithAckOptions` / `invokeWithOptions` invalid-`timeoutMs` rejection](#what-this-list-does-not-cover)". An implementation that passes vector 30 (g) is conformant on the error-shape rule; conformance on the synchrony rule rests on the spec text alone until the future-work vector lands.

**Why the three transport-side codes are distinct.** `WC_BINDABLE_DISPOSED` is a consumer-intentional teardown (the proxy is, by contract, never reusable; `reconnect()` MUST throw on it). `WC_BINDABLE_TERMINAL_FAILURE` is a transport-level outage (the proxy stays alive for `reconnect()` if the implementation supports it). `WC_BINDABLE_PROTOCOL_ERROR` is a wire bug (malformed envelope, unexpected wire state — investigate the producer / consumer / transport adapter version mismatch). Conflating any two of them into the same code prevents the consumer from making the right recovery decision (reconstruct vs reconnect vs file a bug).

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
- `thrownError.code === "WC_BINDABLE_TERMINAL_FAILURE"` — the locally-synthesized-error MUST in [SPEC-extensions.md § Error envelope](SPEC-extensions.md#error-envelope) applies to `set()`'s terminal throw (the consumer-side proxy builds the Error from a known protocol condition). Implementations MUST NOT use `WC_BINDABLE_PROTOCOL_ERROR` for this case (that code is reserved for wire-protocol bugs / version mismatches) and MUST NOT use `WC_BINDABLE_DISPOSED` (that code is reserved for consumer-initiated `dispose()`). Implementations MAY also carry a richer `thrownError.message` for human diagnostics, but the `code` value is the load-bearing assertion.
- After the throw: `proxy.setWithAck("x", 3)` MUST return an already-rejected `Promise` (with the same `code === "WC_BINDABLE_TERMINAL_FAILURE"`); `proxy.invoke("fetch")` MUST likewise reject.

**Cross-profile invariant.** Validation throws still apply at the `set()` call site regardless of terminal/transient state — `proxy.set("not-a-declared-input", X)` and `proxy.set("validInput", { d: new Date() })` MUST throw synchronously on the validation gate, *before* the terminal-vs-transient gate runs. This composes with vector 17's call-site-validation rule.

**Why the bifurcation matters.** The `set()` row of [SPEC-extensions.md § Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (both the failure-and-recovery table and the retry-guidance table) calls this out as the spec's most-confused surface. A consumer that uses `set(); invoke()` over a flaky link without realizing `set` is at-most-once on transient outages will see `invoke` run against producer state that never received the `set` update — a class of silent corruption that `setWithAck` exists to make detectable. This vector exists so an implementation cannot pass the surrounding test suite while collapsing the two paths (e.g. always throwing, or never throwing) — the bifurcation is the canonical safety mechanism the consumer relies on.

**Spec reference.** [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (the `set` row, "Fast path — unsafe by design" and "transient outages — automatic reconnect attempts in progress ... are NOT terminal"), [§ Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2), [§ Failure & recovery quick reference](SPEC-extensions.md#failure--recovery-quick-reference) (the `set` rows in both tables).

---

### 35. Fingerprint `protocol` mismatch ⇒ TerminalFailure (always)

> **Why this vector is load-bearing.** `protocol` is the single field on `declarationFingerprint` whose disagreement marks a **breaking-compatibility boundary** per [SPEC.md § Versioning](SPEC.md#versioning). An implementation that warn-logs and continues here (treating `protocol` like the other fingerprint fields) silently breaks the design that [SPEC-extensions.md § Wire format versioning](SPEC-extensions.md#wire-format-versioning) item 4 relies on: a v1 consumer would keep parsing v2-shaped envelopes as if they were v1, producing exactly the silent corruption the breaking-change identifier was meant to prevent. This vector exists because that failure mode looks correct under naive testing — happy-path envelopes from a v2 producer often resemble v1 envelopes structurally — and only manifests when a renamed or repurposed field carries an unintended meaning.

**Setup.** A consumer-side proxy constructed with a local declaration whose `protocol` is `"wc-bindable"`, a recording mock transport that exposes `dispose()` / `send` instrumentation, and at least one queued pending entry so the rejection-in-caller-order rule is observable. The producer emits a `sync` whose `declarationFingerprint.protocol` is `"wc-bindable-2"` (the other fingerprint fields match the consumer's local fingerprint to isolate the `protocol`-only mismatch):

```javascript
const localDeclaration = {
  protocol: "wc-bindable",
  version:  1,
  properties: [{ name: "v", event: "x:v-changed" }],
  inputs:     [{ name: "url" }],
  commands:   [{ name: "fetch", async: true }],
};

const transport = new RecordingTransport();   // captures send() + disposed flag
const proxy = createRemoteCoreProxy(localDeclaration, transport);

// Queue two pending entries before the sync response arrives, so the
// caller-order rejection contract is observable on a non-trivial queue.
const p1 = proxy.setWithAck("url", "/api/users");
const p2 = proxy.invoke("fetch");

transport.emitInbound({
  type:   "sync",
  values: {},
  capabilities: { setAck: true },
  declarationFingerprint: {
    protocol:   "wc-bindable-2",      // <— the only disagreement
    version:    1,
    properties: ["v"],
    inputs:     ["url"],
    commands:   ["fetch"],
  },
});
```

**Action.** `await Promise.allSettled([p1, p2])`; inspect each rejection's `error.code`, the proxy's lifecycle state, the recorded outbound traffic on `transport.send`, and the `transport.disposed` flag.

**Expected.**
- `p1` is rejected; `p1`'s error carries `error.code === "WC_BINDABLE_PROTOCOL_ERROR"`.
- `p2` is rejected; `p2`'s error carries the same code.
- The two rejections settle **in caller order** (`p1` before `p2`), per the TerminalFailure-drain rule referenced from [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine).
- The proxy has transitioned to TerminalFailure: `proxy.set("url", "/x")` MUST throw synchronously with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"`; `proxy.setWithAck("url", "/x")` and `proxy.invoke("fetch")` MUST return already-rejected promises with the same `WC_BINDABLE_TERMINAL_FAILURE` code per vector 34's terminal-path rule.
- `transport.sent.length === 0` for **any wire message emitted in response to the offending sync** — the consumer MUST NOT emit a reply (no `throw` envelope, no diagnostic frame). The new `protocol` identifier means the consumer can no longer prove its envelope shapes would be understood by the producer.
- `transport.disposed === true` — the proxy signaled the transport to dispose as part of TerminalFailure transition.

**Action — strict-mode invariance.** Re-run the entire scenario with `strictFingerprint: true` (or the implementation's equivalent option). The expected behavior MUST be **bit-identical** — every assertion above passes the same way.

**Expected — strict-mode invariance.** Same as above. Strict mode does NOT change the `protocol`-mismatch path; it only governs the **non-`protocol`** mismatch path (vector 37). An implementation that conditionally applies the terminal posture only under strict mode is non-conformant.

**Conformance interpretation.** This is the canonical breaking-change-detection vector. The `WC_BINDABLE_PROTOCOL_ERROR` code is the load-bearing assertion — it tells the consumer's application-level error handler that the failure is a wire-protocol disagreement (suggesting "upgrade one side or pin both") rather than a transport outage (suggesting "retry / reconnect") or a consumer-initiated teardown (suggesting "dispose was called somewhere"). Implementations MUST NOT substitute `WC_BINDABLE_TERMINAL_FAILURE` here — that code is reserved for transport failures and would obscure the actual root cause from operators following up on the failure.

**Spec reference.** [SPEC-extensions.md § Declaration fingerprint](SPEC-extensions.md#declaration-fingerprint) (`protocol differs` bullet) + [§ Wire format versioning](SPEC-extensions.md#wire-format-versioning) item 4 + [§ Remote proxy lifecycle](SPEC-extensions.md#remote-proxy-lifecycle) (PreSync → TerminalFailure transition) + [§ Error envelope](SPEC-extensions.md#error-envelope) (`WC_BINDABLE_PROTOCOL_ERROR` registry entry).

---

### 36. Legacy fingerprint without `protocol` is NOT malformed

> **Why this vector exists.** The fix that added `protocol` to `declarationFingerprint` (a clarification, not a breaking change) leaves a transition window where producers emit the four-field legacy shape. A naive strict-validator implementation would reject the legacy shape as malformed and escalate to TerminalFailure via vector 23's malformed-`sync` rule, refusing to interoperate with every producer that predates the clarification. The legacy bridge exists precisely to prevent that regression; this vector checks the bridge.

**Setup.** A consumer-side proxy with a local declaration whose `protocol` is `"wc-bindable"`, plus a sync response whose `declarationFingerprint` contains exactly the four legacy fields and **omits** `protocol`:

```javascript
const localDeclaration = {
  protocol: "wc-bindable",
  version:  1,
  properties: [{ name: "v", event: "x:v-changed" }],
  inputs:     [{ name: "url" }],
  commands:   [{ name: "fetch", async: true }],
};

const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(localDeclaration, transport);
const logEntries = [];                              // intercept warn / error
proxy.setLogger?.({ warn: (...a) => logEntries.push(["warn", ...a]),
                    error:(...a) => logEntries.push(["error", ...a]) });

transport.emitInbound({
  type:   "sync",
  values: {},
  capabilities: { setAck: true },
  declarationFingerprint: {
    // protocol intentionally omitted — legacy fingerprint shape
    version:    1,
    properties: ["v"],
    inputs:     ["url"],
    commands:   ["fetch"],
  },
});

await new Promise((resolve) => setTimeout(resolve, 0));
```

**Action.** Inspect the proxy's lifecycle state, the log entries, and whether any rejections fired.

**Expected.**
- The proxy is in **Active** (NOT TerminalFailure). `proxy.setWithAck("url", "/api")` returns a pending promise that the recording transport observes as an outbound `setWithAck` envelope — i.e. the channel is alive and processing wire traffic.
- `logEntries` contains **NO** error-level entry naming a malformed `declarationFingerprint` or missing required field. The legacy shape is explicitly NOT treated as malformed.
- `logEntries` contains **NO** warn-level fingerprint mismatch entry either (the remaining four fields match in this setup, so no warning fires — equivalent to the all-equal case for the four non-`protocol` axes plus comparison-unavailable for the protocol axis).
- No pending entry is rejected on the basis of the legacy shape; no `WC_BINDABLE_PROTOCOL_ERROR` is synthesized.

**Variant — legacy shape with non-`protocol` mismatch.** Re-run with the producer's fingerprint differing on one of the non-`protocol` fields (e.g. `commands: ["fetch", "abort"]` while the local declares only `["fetch"]`), still omitting `protocol`. Expected: the proxy remains in Active, a warn-level entry fires identifying the differing field (per the non-`protocol` mismatch rule, vector 37), and no terminal transition occurs. The missing-`protocol` field does NOT block the non-`protocol` comparison from running.

**Conformance interpretation.** The combination "fingerprint object present + `protocol` field absent" is the **legacy fingerprint shape**, not a malformed envelope. Implementations that close the transport here are conflating vector 23's malformed-`sync` rule with the legacy-bridge carve-out. The carve-out is one-directional: producers writing to the current spec MUST include `protocol`; consumers MUST accept the legacy shape from older producers without escalation.

**Spec reference.** [SPEC-extensions.md § Declaration fingerprint](SPEC-extensions.md#declaration-fingerprint) (`Legacy fingerprint shape (no protocol)` paragraph) + [§ Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) (the malformed-`sync` row, whose scope explicitly excludes this case).

---

### 37. Non-`protocol` fingerprint mismatch — warn+continue (default), TerminalFailure (strict mode)

> **Why two sub-cases.** This vector covers the **default-mode** path that every conformant `{3-consumer}` / `{3-both}` MUST satisfy, plus the **strict-mode** path that implementations shipping a strict-fingerprint option MUST also satisfy. Implementations that do not ship strict mode satisfy only the default-mode sub-case. The split is what makes "non-`protocol`" mismatches operationally distinct from the always-terminal `protocol` mismatch in vector 35.

**Setup.** A consumer-side proxy with a local declaration that matches the producer on `protocol` but disagrees on `commands` (the easiest mismatch to construct that does not trip another rule):

```javascript
const localDeclaration = {
  protocol: "wc-bindable",
  version:  1,
  properties: [{ name: "v", event: "x:v-changed" }],
  inputs:     [{ name: "url" }],
  commands:   [{ name: "fetch", async: true }],     // local knows only "fetch"
};

function emitMismatchingSync(transport) {
  transport.emitInbound({
    type:   "sync",
    values: {},
    capabilities: { setAck: true },
    declarationFingerprint: {
      protocol:   "wc-bindable",                    // matches
      version:    1,
      properties: ["v"],
      inputs:     ["url"],
      commands:   ["fetch", "abort"],               // producer additionally knows "abort"
    },
  });
}
```

**Action — default mode.**

```javascript
const transport = new RecordingTransport();
const proxy = createRemoteCoreProxy(localDeclaration, transport);
const logEntries = [];
proxy.setLogger?.({ warn: (...a) => logEntries.push(["warn", ...a]),
                    error:(...a) => logEntries.push(["error", ...a]) });

const p1 = proxy.setWithAck("url", "/api/users");
emitMismatchingSync(transport);
await new Promise((resolve) => setTimeout(resolve, 0));
```

**Expected — default mode.**
- The proxy reaches **Active** (NOT TerminalFailure). `transport.disposed === false`.
- `logEntries` contains **exactly one** warn-level entry identifying the mismatching field(s) — at minimum naming `commands` and the diff `["abort"]`. The exact log shape is implementation-defined; what matters is that the warning fires once and identifies the differing field.
- `p1` settles per its own rules (the producer sees the `setWithAck` and replies normally on the recording transport, or the test asserts only that `p1` is still pending immediately after the sync, depending on whether the producer-stub is wired to reply). The mismatch does NOT reject `p1` on its own.
- A subsequent `proxy.invoke("abort")` follows the normal "undeclared command" path from the consumer-side proxy's `commands` membership check — that path is governed by [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) and is observable independently; the fingerprint warning surfaces the root cause of why that membership check fails.

**Action — strict mode.**

```javascript
const strictProxy = createRemoteCoreProxy(localDeclaration, transport, {
  strictFingerprint: true,                          // implementation-equivalent option name OK
});
const sp1 = strictProxy.setWithAck("url", "/api/users");
const sp2 = strictProxy.invoke("fetch");
emitMismatchingSync(transport);
const settled = await Promise.allSettled([sp1, sp2]);
```

**Expected — strict mode.**
- Both `sp1` and `sp2` are rejected, with `error.code === "WC_BINDABLE_PROTOCOL_ERROR"` on each. Caller-order rule applies (`sp1` before `sp2`).
- `strictProxy` has transitioned to TerminalFailure: subsequent `set` throws synchronously with `error.code === "WC_BINDABLE_TERMINAL_FAILURE"`; subsequent `setWithAck` / `invoke` return already-rejected promises with the same `TERMINAL_FAILURE` code per vector 34's terminal-path rule.
- `transport.sent` records **no outbound wire message** in response to the offending sync (no diagnostic frame, no `throw` envelope — the consumer's local synthesis is the conformant signal).
- `transport.disposed === true`.

**Skip rule for strict mode.** An implementation that does NOT ship a strict-fingerprint option is exempt from the strict-mode sub-case (the default-mode sub-case is still REQUIRED). Implementations claiming strict-mode support in their public API MUST pass the strict-mode sub-case; implementations that omit the option entirely MAY skip the strict-mode actions and assertions.

**Conformance interpretation.** The default-mode behavior reflects the operational reality of partial deploys: a `commands` superset on the producer (added a new command before the consumer was upgraded) is a deployment drift, not a wire-protocol bug, and tearing down the channel would refuse interop with every healthy upgrade window. Strict mode is the appropriate escalation **only** when consumer and producer ship from the same versioned bundle and any drift is by definition a deployment bug. The asymmetry with vector 35's `protocol`-mismatch path is intentional: `protocol` carries breaking-compatibility weight that the other fingerprint fields do not.

**Spec reference.** [SPEC-extensions.md § Declaration fingerprint](SPEC-extensions.md#declaration-fingerprint) (`Non-protocol mismatch` bullet + `Strict-mode opt-in` paragraph + the "Strict mode does NOT govern `protocol` mismatch" blockquote).

---

## What this list does NOT cover

These vectors are deliberately narrow — they target rules that are easy to violate in ways that pass naive smoke tests. They are **not** a complete conformance suite. Additional areas worth covering in a richer test corpus:

- **Shadow-DOM attach** under `syncOn: "connect"` (the documented "observer doesn't traverse shadow roots" limitation)
- **`AbortSignal` pre-aborted at `setWithAckOptions` / `invokeWithOptions` call time** (rejects immediately without sending — distinct from vector 18's "aborted/timed-out after send" case, which IS covered)
- **`MutationObserver` callback after host detach** under `syncOn: "connect"` (observer rechecks `isConnected`, stays armed)
- **Synchrony of `setWithAckOptions` / `invokeWithOptions` invalid-`timeoutMs` rejection.** Vector 30's `testInvalidAckOptions()` sub-case verifies the `code === "WC_BINDABLE_INVALID_ACK_OPTIONS"` rule, but its `try { await ... } catch` shape cannot distinguish "synchronously already-rejected Promise" (the normative requirement per [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions)) from "Promise rejected on the next microtask" — both produce identical observable behavior under `await`. A dedicated vector that asserts the synchrony explicitly (e.g. via `Promise.race([call, Promise.resolve("sync-marker")])` ordering, or by inspecting the returned Promise's state before any await) would catch the easy-to-miss implementation bug of returning a Promise that rejects on a microtask hop. Implementations following the spec text already get this right; the vector is a future hardening rather than a current correctness gap.

Implementations targeting full conformance should grow their own test suite to cover at minimum the items above; the in-tree tests under `packages/core/tests/` and `packages/remote/tests/` cover much of this space and can be used as a starting reference.

Contributions that expand this file with additional canonical vectors are welcome — the test-vector format above (Setup → Action → Expected → Spec reference) is the template.
