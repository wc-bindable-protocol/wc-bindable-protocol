# wc-bindable-protocol Extensions

This document describes optional contracts that build on the core [SPEC.md](SPEC.md). The core protocol intentionally interprets only `properties` — the `inputs` and `commands` declarations, along with the `attribute` and `async` hints, are purely declarative at the core level. Their *behavioral* meaning is layered on top by the extensions below.

Implementations MAY adopt one extension without adopting the others. A consumer that uses only `bind()` from `@wc-bindable/core` does not need any of this document.

---

## Extension 1 — Input/Command Invocation

This extension defines what it means for a consumer to **set an input** or **invoke a command** on a target that conforms to wc-bindable. It is implemented by `@wc-bindable/remote` (across a transport) and is expected to be implemented by future tooling such as devtools and automation runners.

### Methods

A *consumer-side proxy* that adopts this extension MUST expose the following surface:

| Method | Signature | Semantics |
|---|---|---|
| `set` | `set(name: string, value: unknown): void` | **Fast path — unsafe by design.** Fire-and-forget assignment of an input property. **At-most-once delivery, NO acknowledgement, silent drop on transient transport failure.** Throws synchronously if `name` is not declared in `inputs`, the transport is terminally failed, the proxy is disposed, or — when [Extension 2](#extension-2--wire-format-remote-proxying) is adopted — `value` fails the consumer-side `JsonValue` validation; but on a *transient* outage the message can simply not arrive and the caller will never know. Use this only when (a) you can tolerate the message being lost and (b) no later `invoke` depends on this assignment having been applied. For anything else, use `setWithAck`. The faster latency (no round-trip) is the only reason to choose this row. |
| `setWithAck` | `setWithAck(name: string, value: unknown): Promise<void>` | Acknowledged assignment. **The promise MUST NOT resolve before the JS-level assignment `target[name] = value` has executed on the trusted side**; it MUST reject if `name` is not declared in `inputs`, the assignment throws, the remote rejects the message, the transport is terminally failed, the call times out, the proxy is disposed, or — when [Extension 2](#extension-2--wire-format-remote-proxying) is adopted — `value` fails consumer-side `JsonValue` validation. Like `invoke`, **all protocol-level failures MUST reach the caller as a `Promise` rejection**, not a synchronous throw; the only sync throws permitted are programmer errors outside the protocol surface. The proxy does NOT wait for asynchronous side effects of the setter (e.g. a setter that schedules background work) — components that need to gate `invoke` on async post-set work SHOULD expose a command instead so the caller can `await invoke()`. **At-least-once delivery is NOT promised** — on transport failure the proxy rejects rather than silently retrying, because re-sending could re-apply a non-idempotent input (an increment, a write to an append-only log) twice, which the proxy cannot detect. The conservative default is at-most-once and the caller is responsible for any retry. Implementations MAY layer exactly-once on top via per-call idempotency keys but MUST document the choice. |
| `setWithAckOptions` | `setWithAckOptions(name: string, value: unknown, options?: AckOptions): Promise<void>` | Same semantics as `setWithAck` plus per-call lifecycle controls; see § AckOptions. |
| `invoke` | `invoke(name: string, ...args: unknown[]): Promise<unknown>` | Calls a declared command. Resolves with the (serialized) return value, or rejects with a serialized form of the thrown error. **MUST return a rejected `Promise`** (not a synchronous throw) for every protocol-level failure: `name` is not declared in `commands`, the proxy is disposed, the transport is terminally failed, the call timed out, the call was aborted, or — when [Extension 2](#extension-2--wire-format-remote-proxying) is adopted — any of `args` fails consumer-side `JsonValue` validation. Implementations SHOULD NOT throw synchronously except for programmer errors outside the protocol surface (e.g. `name` is not a string, the proxy receiver is not bound). Routing all protocol-level failures through `Promise` rejection keeps `await invoke(...)` totalizing — `try / catch` around the await catches every failure mode. |
| `invokeWithOptions` | `invokeWithOptions(name: string, args: unknown[], options?: AckOptions): Promise<unknown>` | Same semantics as `invoke` plus per-call lifecycle controls; see § AckOptions. Same always-reject rule applies. |

The set of declared inputs and commands MUST be the same as the declarations exposed in `target.constructor.wcBindable.inputs` / `.commands` so that local and remote behavior agree.

#### AckOptions

`setWithAckOptions` and `invokeWithOptions` accept an optional second/third argument:

```typescript
interface AckOptions {
  /**
   * Maximum milliseconds the proxy will keep the pending promise open before
   * rejecting with a TimeoutError. `0` disables the timeout for this call.
   * If omitted, the implementation's default applies; implementations MUST
   * document this default.
   */
  timeoutMs?: number;
  /**
   * If signalled before the pending promise settles, the promise rejects
   * with the signal's `reason` (or a synthetic AbortError). Abort is a
   * **local** cancellation — the proxy removes the pending entry and
   * rejects the caller's promise; the wire message MAY have already left
   * the proxy. Any subsequent `return` / `throw` envelope from the
   * producer for the same `id` MUST NOT re-settle the (already-rejected)
   * promise and MUST be dropped by the consumer; the consumer SHOULD log
   * the drop at warn level so the unexpected late envelope is visible to
   * diagnostics. The protocol does NOT send a wire-level cancellation.
   */
  signal?: AbortSignal;
}
```

Implementations MUST honor:

- A default timeout. The reference implementation uses `30_000` ms. Other implementations MAY choose a different default but MUST document it. `timeoutMs: 0` disables the timeout; `timeoutMs: undefined` (or `options` omitted) applies the default.
- Invalid `timeoutMs` (negative, non-finite, non-numeric) MUST cause the returned promise to reject synchronously with a `RangeError`-shaped error rather than be silently ignored.
- Pre-aborted signals (`signal.aborted === true` at call time) MUST cause the returned promise to reject immediately without sending any wire message.
- After timeout or abort settles the caller's promise, the proxy MUST NOT re-settle it if a late `return` / `throw` envelope arrives for the same `id`. The late envelope MUST be dropped, and the proxy SHOULD log the drop at warn level so the unexpected delivery is visible to diagnostics. (See § Transport lifecycle vocabulary for the terminal-vs-transient terminology that interacts with this.)

#### Call-order preservation

Implementations **MUST** preserve the caller's invocation order when serializing `set` / `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` (and any other future `*WithOptions` variant) onto a single logical channel. That is, the proxy itself MUST NOT reorder calls — message N is handed to the transport strictly before message N+1, regardless of which entry point the caller used.

Wire-level ordering between two messages then depends on the transport's own delivery guarantees:

- Transports that preserve message order (e.g. WebSocket over TCP, in-process function calls) inherit this guarantee: a `set("url", X)` immediately followed by `invoke("fetch")` on the same proxy is observed by the remote side as `url ← X` then `fetch()`.
- Transports that do NOT preserve message order (hypothetical UDP-style or multi-channel transports) MUST document the gap, and consumers that need ordering across calls MUST sequence with `await setWithAck(...)` before issuing the dependent call.

The canonical `@wc-bindable/remote` WebSocket transport inherits TCP-level ordering, so the documented `set("url", "..."); await invoke("fetch")` pattern is safe **on a healthy ordered channel**: while the connection is up the producer observes the messages in caller order. It is **not** sufficient under a transient outage — `set` is at-most-once, so on a connection blip the `set` can be dropped while a subsequent `invoke` lands, leaving the producer to run the command against a stale input with no error returned to the caller. Whenever `invoke` semantically depends on a prior `set` having been applied, sequence with `await setWithAck("url", "...")` (or its `setWithAckOptions` variant) first. The README remote example documents the same caveat alongside the snippet.

### The `async` hint

The optional `async: boolean` field on a command descriptor is a **declaration**: it tells tooling that the underlying method returns a `Promise` and the value-carrying frame is the eventual resolution, not the synchronous return. Implementations of this extension SHOULD treat `invoke` as always asynchronous (returning a `Promise`) regardless of `async`; the hint exists for documentation, code generation, and devtools rendering.

The core protocol does NOT inspect this field.

### The `attribute` hint

The optional `attribute: string` field on an input descriptor is a **declaration** for tooling and Web Component attribute reflection. It tells a consumer "when you write `<my-input value="x">`, that maps to the `value` input property." This extension does not prescribe any automatic attribute → property reflection; that is the component's own `observedAttributes` / `attributeChangedCallback` responsibility.

The core protocol does NOT inspect this field.

### Error envelope

When `setWithAck` or `invoke` fails on the remote side, the consumer-side proxy SHOULD raise an `Error` whose `name`, `message`, and (when available) `stack` reflect the original throw. Implementations MAY attach the raw serialized payload as `cause`. Implementations MUST NOT silently swallow remote throws.

> **Security note on `stack`.** A producer-side stack trace typically includes internal file paths, function names, and runtime version markers — sensitive metadata that should NOT cross an untrusted trust boundary. The `stack` field is therefore conditional:
>
> - On **trusted development transports** (in-process, same-team WebSocket between vetted services, local debugging tools) producers MAY include the full `stack` to ease diagnostics.
> - On **untrusted network boundaries** (anything reachable from a user-controlled client, third-party integration, public API surface) producers **SHOULD** omit `stack` entirely, or redact it (strip absolute paths / function names / leave only the producer-side line count) before serializing the throw envelope.
>
> Consumers MUST cope with `stack` being absent — it is already typed `stack?: string` (optional) precisely so producers can drop it without breaking the schema. This rule is symmetric with the existing principle that "auth / authorization / rate limiting / payload schema validation are the responsibility of the layer that owns the transport" — leaking internals via stack traces is the same class of concern, just on the reverse direction.

### Transport lifecycle vocabulary *(shared by Extensions 1 and 2)*

These transport-state terms are referenced by both the Extension 1 method semantics above and the Extension 2 wire format below. They are defined here for proximity to the Extension 1 throw-vs-reject table; Extension 2 cross-references this section rather than redefining the vocabulary.

- **Terminally failed.** The transport instance is past the point where it can recover without external action. Examples: the proxy has been `dispose()`d; the transport reported its `onClose` callback and the binding code has not reconnected; the underlying socket fired a non-resumable error (e.g. WebSocket close with policy-violation status, `MessagePort` close, Worker termination); the transport's `send` synchronously threw and the proxy decided to disconnect rather than buffer. **Transient outages — automatic reconnect attempts in progress, exponential-backoff retry windows, brief network blips that the transport is configured to mask — are NOT terminal.** A `set` call MUST throw synchronously when the transport is in the terminal state at call time; it MUST NOT throw on a transient outage. In the transient case the message either lands eventually (at-most-once semantics) or is dropped silently, which is exactly the gap `setWithAck` exists to make detectable.
- **Disposed.** The proxy itself has had `dispose()` called. `set` MUST throw, `setWithAck` MUST reject, `invoke` MUST reject. The proxy MUST NOT accept a new transport after `dispose()`.

A transport implementation MUST document which observable signal (`onClose` firing, `send` throwing, an explicit `dispose()` call) it treats as terminal, so callers know when to expect synchronous throws from `set`.

### Trust boundary *(shared by Extensions 1 and 2)*

Both Extension 1 (the call surface) and Extension 2 (the wire format) operate across a trust boundary. The receiving side MUST treat all arguments as untrusted input. In particular:

- The remote side MUST validate that the message references a declared `inputs` / `commands` name before reaching the Core.
- The remote side MUST NOT transport `getter` functions as code — `getter` is applied on the trusted side, and only the extracted value crosses the wire.
- Authentication, authorization, rate limiting, and payload schema validation are the responsibility of the layer that owns the transport, not of this extension.

The core protocol's trust-boundary contract is defined in [SPEC.md § Trust Boundaries](SPEC.md#trust-boundaries); the above is the network-specific specialization of that contract. The remote reference implementation's concrete guardrails (auth handshake placement, back-pressure caps, logger injection) live in [packages/remote/README.md § Security model](packages/remote/README.md#security-model--trust-boundary).

---

## Extension 2 — Wire Format (Remote Proxying)

This section is the **normative** wire-format specification for any implementation that transports wc-bindable across a network. Third-party implementations of the consumer-side proxy or the producer-side proxy MUST conform to this contract to interoperate with `@wc-bindable/remote` (the reference implementation). Concrete usage examples, error-handling tips, back-pressure controls, and framework-integration snippets live in [packages/remote/README.md](packages/remote/README.md); the contract itself is here.

### Design invariants

1. **Property-centric, not event-centric.** Each `properties[i]` becomes its own per-property message stream identified by `name`. Multiple property descriptors MAY share the same `event` name on the producer side; the wire MUST discriminate by `name`.
2. **`getter` runs on the producer side only.** Functions are NEVER transported as code; only the extracted value crosses the wire. The consumer-side proxy MUST rewrite each `properties[i].event` to a unique synthetic per-property event name on the local declaration so `bind()` on the consumer can discriminate properties that originally shared an event name on the producer. Concretely, the consumer-side proxy:
   - constructs its `constructor.wcBindable.properties` with each entry's `event` replaced by a synthetic name (the reference implementation uses `"@wc-bindable/remote:" + name`),
   - **OMITS** `getter` on every consumer-side property descriptor — when a wire `update` arrives, the proxy dispatches a `CustomEvent` whose `detail` is the already-extracted value, so the default `e => e.detail` getter (from SPEC.md § Default Getter) reads the right value with no remote-side function reference involved,
   - keeps `inputs` and `commands` as-is (these are purely declarative, with no per-descriptor function reference to translate).

   A consumer-side declaration that erroneously copied the original `getter` from the producer would re-apply extraction to an already-extracted value and silently corrupt the consumer's observed state.
3. **JSON-shape payloads only.** The wire's value type is formally defined as:

   ```typescript
   type JsonValue =
     | null
     | boolean
     | string
     | number              // finite only — NaN and ±Infinity are NOT JsonValue
     | JsonValue[]
     | { [key: string]: JsonValue };  // own enumerable string keys only
   ```

   `undefined`, `Date`, `Map`, `Set`, `BigInt`, typed arrays, class instances, functions, symbols, cyclic references, and non-finite numbers are out of contract. Transports whose native channel could preserve richer values (e.g. `MessagePort` structured clone) MUST serialize at the boundary so every transport presents the same lossy view.

   **`JSON.stringify` alone is NOT sufficient validation.** `JSON.stringify` silently coerces `NaN`/`Infinity` to `null`, silently drops object own-properties whose value is `undefined`, a function, or a symbol, and silently drops symbol-keyed properties. A value can therefore pass `JSON.stringify` without throwing while being silently mutated into a different shape on the wire. Producers MUST validate values as `JsonValue` via an explicit deep traversal **before** handing them to the transport — a typed predicate `isJsonValue(v)` is the conformant primitive. (Implementations MAY use `JSON.stringify` followed by a structural compare of the parsed result to the original; raw `try { JSON.stringify(v) }` is non-conformant.)

   **Object-shape requirements (deep validation algorithm).** When traversing an object, the validator MUST enforce all of the following per visited level; failing any of them makes the value non-conformant:

   - `Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null`. Plain objects only. Class instances, `Date`, `Map`, `Set`, `RegExp`, etc. carry custom prototypes and are out of contract — without this check they pass through as `{}` (no own enumerable keys) and the wire silently strips their semantics.
   - For every own enumerable string key, `Object.getOwnPropertyDescriptor(value, key)` MUST be a data descriptor (`"value" in desc`, neither `"get"` nor `"set"` in `desc`). Accessor properties are rejected outright. Beyond shape correctness, this also avoids invoking the getter during validation — a getter on an untrusted-source value could have side effects (information leak, state mutation) at exactly the trust boundary where the wire is meant to be defensive.
   - Symbol-keyed properties on an object are silently invisible to JSON and to `JSON.stringify`. The default normative rule is: if `Object.getOwnPropertySymbols(value).length > 0`, the value is non-conformant and MUST be rejected. This is the security-leaning choice — silently transmitting an object whose author meant to attach metadata via a symbol key would lose information across the wire without warning. Implementations MAY opt out of strict rejection for ecosystem compatibility (e.g. React adds `Symbol(react.element)` to JSX nodes; some immutable libraries tag values with private symbols), in which case they MUST: (a) document the opt-out explicitly in their public API surface, (b) ignore the symbol keys at serialization time without throwing, and (c) document that those keys are NEVER transmitted to the consumer. The reference implementation in `@wc-bindable/remote` chooses strict rejection.
   - Arrays: every element MUST itself satisfy `isJsonValue`. Sparse holes (positions where `i in arr === false`) MUST be **rejected**; the earlier "treat as `null`" alternative is removed because it introduces silent shape change between transports and defeats the validate-before-serialize principle. Callers that need to transmit "this index is unset" MUST encode it explicitly (`null`, or a sentinel they define).
   - Cyclic references: traversal MUST detect a cycle (typically via a `WeakSet` of seen objects) and reject the value; otherwise the validator stack-overflows on adversarial input.

   **Error reporting.** When `isJsonValue(v)` returns false, the validator SHOULD surface a **path-aware** error that names the failing sub-location, so the caller can diagnose the issue without re-walking the input by hand. The recommended format is a JSONPath-style expression rooted at `$`, with `.<key>` for object keys and `[<n>]` for array indices, plus the offending type. Examples:

   ```
   $.items[3].createdAt is Date, expected JsonValue
   $.config.timeout is NaN (non-finite numbers are not JsonValue)
   $ is cyclic at $.parent.child[0].parent
   $.payload[Symbol(meta)] is symbol-keyed (rejected; opt-in compatibility required)
   ```

   Implementations MAY use a different path syntax as long as the offending location can be located in the original input from the error message alone. Plain "value is not JsonValue" without a path is permitted but discouraged — it forces the caller into bisect-style debugging on large objects.

   **Handling of non-`JsonValue` values is normative — on both sides of the wire:**

   *Producer-side (server → client traffic):*

   - For an `update` / `sync` payload, the producer MUST emit a logger warning naming the affected property and MUST drop the value — no `update` message for that change; the consumer continues observing the last successfully-transmitted value.
   - For a `setWithAck` / `invoke` reply (`return` envelope), the producer MUST instead emit a `throw` envelope referencing the same `id`, so the pending consumer promise rejects with a typed error rather than hanging or resolving with corrupted data.
   - The producer MUST NOT substitute a sentinel like `null` for a failed serialization. Silent value mutation breaks the consumer's value-cache and the `bind()` `onUpdate` contract.

   *Consumer-side (client → server traffic):*

   - The consumer-side proxy MUST validate `set.value` and `cmd.args` against `JsonValue` **before** handing the message to the transport. The same deep-validation rule applies; `JSON.stringify`-and-catch alone is non-conformant for the reasons given above.
   - For `setWithAck` and `invoke`, a validation failure MUST cause the returned promise to reject locally with a typed error. No wire message is sent.
   - For fire-and-forget `set` (no `id`), a validation failure MUST cause `set()` to throw synchronously. The proxy MUST NOT silently drop a non-serializable input — the caller has no other channel to learn about it.

   *Producer-side handling of malformed inbound messages:*

   - The producer MUST reject any inbound message that fails JSON-shape validation (`set` without a string `name`; `cmd` without a string `name`, without a string `id`, or with `args` that is not an array; any envelope with extra unknown keys MUST still be processed, per the "ignore unknown fields" rule from core, but type-mismatched required keys MUST be rejected).
   - For an inbound `setWithAck` / `cmd` that has an `id` but is otherwise malformed, the producer MUST emit a `throw` envelope referencing that `id` so the consumer's pending promise rejects with a clear error rather than hanging.
   - For an inbound fire-and-forget `set` that is malformed (no `id`), the producer cannot reply. It MUST log a warning and drop the message. This is the documented gap of the fire-and-forget channel.
   - The producer MUST NOT touch the Core (no setter invocation, no command call) until validation succeeds. Validation is the first step on the producer side.
4. **FIFO ordering on a single (consumer, producer) channel.** The transport MUST preserve the order in which the proxy called `send()`. WebSocket-per-connection and `MessagePort`-per-port satisfy this; `BroadcastChannel` and fan-in / fan-out transports do not in general.
5. **Per-channel single-shell semantics.** A given producer-side shell MUST serve exactly one consumer proxy at a time. Multiplexing N consumers onto one shell is out of scope; spawn N shells (one per channel) instead.

### Message types — client → server

```
{ "type": "sync" }
{ "type": "set", "name": string, "value": JsonValue }
{ "type": "set", "name": string, "value": JsonValue, "id": string }   // setWithAck
{ "type": "cmd", "name": string, "id": string, "args": JsonValue[] }  // invoke
```

- `set` without an `id` is fire-and-forget (Extension 1 `set`); with an `id` it requires an acknowledgement (Extension 1 `setWithAck`).
- `cmd.id` is a client-allocated identifier (e.g. UUID v4) unique within the lifetime of the proxy. The producer MUST echo it back in the `return` / `throw` envelope.
- `{ type: "sync" }` carries no `id`. **At most one `sync` request MAY be outstanding per channel at a time.** The consumer-side proxy MUST NOT issue a new `sync` until the previous one has either received its `sync` response or the channel has been torn down. The producer MAY conflate back-to-back `sync` requests it has not yet answered into a single response. If a future revision needs concurrent `sync` requests (e.g. cross-shell snapshots on a multiplexed transport), introduce a new message type with an explicit `id` rather than overloading this one.

### Message types — server → client

```
// Initial sync response. `values` is { [name: string]: JsonValue }.
// `undefinedProperties` enumerates names whose current value is `undefined` —
// these are omitted from `values` because JSON cannot represent undefined.
// See "Undefined enumeration" below.
//
// `declarationFingerprint` lets the consumer detect a stale or mismatched
// local declaration before the mismatch surfaces as a per-message rejection.
// See "Declaration fingerprint" below.
{
  "type": "sync",
  "values": { [name: string]: JsonValue },
  "undefinedProperties"?: string[],
  "capabilities"?: {
    "setAck"?: boolean,
    "undefinedProperties"?: boolean,  // producer understands the field
    "getterFailures"?: boolean         // producer understands the field
  },
  "getterFailures"?: string[],
  "declarationFingerprint"?: {
    "version": number,
    "properties": string[],   // sorted, deduplicated property names
    "inputs":     string[],   // sorted, deduplicated input names
    "commands":   string[]    // sorted, deduplicated command names
  }
}

// Subsequent per-property change forwarded by the shell.
{ "type": "update", "name": string, "value": JsonValue }

// Reply to a setWithAck or invoke with matching id.
// `value` is OPTIONAL. Its absence and its concrete shape have different
// meanings depending on which client message the `id` came from — see the
// "Return envelope value field" subsection below.
{ "type": "return", "id": string, "value"?: JsonValue }
{ "type": "throw",  "id": string, "error": { "name": string, "message": string, "stack"?: string } }
```

- `update` is dispatched for every change event the producer-side shell observes, after applying the producer-side `getter`. The `name` MUST be one declared in `properties`.
- `return` / `throw` MUST reference an `id` issued by a prior client message. The producer MAY emit only ONE of `return` or `throw` for any given `id`. Implementations SHOULD reject unknown `id`s with a logger warning rather than throwing — late replies after an abort are normal.
- `capabilities.setAck === true` advertises that the producer honors `setWithAck`. Consumers that issued `setWithAck` calls **before** the `sync` response MUST reject all of them with a clear error if `setAck` is absent or `false`. Calls issued **after** a `sync` response whose `setAck` is absent or `false` MUST be rejected by the consumer-side proxy with the same clear error — concretely, `setWithAck` / `setWithAckOptions` MUST **synchronously return an already-rejected `Promise`** (not throw synchronously, consistent with the Promise-rejection rule for protocol-level failures in § Methods). The proxy MUST NOT send a `setWithAck` message it knows the producer will not handle. **Fire-and-forget `set` (the `id`-less variant) is unaffected by this capability bit** — it is part of the baseline wire contract and every producer MUST handle it regardless of `setAck` support. A producer that signals `setAck: false` is opting out only of the acknowledged path.
- `capabilities.undefinedProperties === true` advertises that the producer understands and emits the `undefinedProperties` field. Modern producers SHOULD always set this capability; the **capability bit, not the field's presence**, is the disambiguator that lets a consumer tell a modern producer with no undefined values (`undefinedProperties: true`, list empty or omitted) from a legacy producer that does not know about the field (`undefinedProperties` capability absent). The consumer-side revert-to-`undefined` legacy heuristic (see § Undefined enumeration "Legacy compatibility") MUST fire only when the capability is absent. A modern producer with the capability set MAY still omit the field when the list would be empty.
- `capabilities.getterFailures === true` advertises that the producer understands and emits the `getterFailures` field. Same disambiguation rationale as `undefinedProperties` above — a modern producer with no failures and a legacy producer that does not know about the field both result in `getterFailures` being absent on the wire; the capability bit is what tells them apart.

#### Return envelope value field

`value` is OPTIONAL on a `return` envelope. Because the wire is JSON-only (no `undefined` representation, see § Design invariants), the producer cannot transmit a literal `undefined` as the value; the producer MUST encode the absence-of-value case by omitting the `value` key entirely. The interpretation differs by which client message the `id` came from:

- **`setWithAck` ack.** The `Promise` resolves with `void`, so there is no return value to transmit. The producer MUST omit the `value` field. Consumers MUST ignore any `value` that does appear on a setWithAck `return` (treat as a producer bug worth logging) and MUST resolve the pending promise with `undefined`.
- **`invoke` return.** The producer represents the method's return value as follows:
  - Synchronous or eventual return of `undefined` → omit `value`. Consumers MUST resolve the pending promise with `undefined`.
  - Synchronous or eventual return of `null` → set `value: null`. Consumers MUST resolve the pending promise with `null`. **`null` and `undefined` are wire-distinguishable** via key presence (omitted vs. present-with-`null`).
  - Any other JsonValue → set `value: <that JsonValue>`. Consumers MUST resolve the pending promise with the deserialized value.

The earlier "value: undefined" pseudocode in the end-to-end diagrams was a JS-level shorthand; on the wire it always serialized as a missing key (because `JSON.stringify` drops own properties whose value is `undefined`), and that omission is now the normative encoding.

### Undefined enumeration

This rule mirrors core's `in`-operator initial-sync semantics across the wire. The producer-side shell computes the initial sync snapshot as follows for each declared property `name`:

- If `name in core` is `false` → omit from `values`, do NOT list in `undefinedProperties`. The consumer MUST treat this as "property not present" and MUST NOT dispatch an initial-sync event for it. (Subsequent `update` messages still apply normally.)
- If `name in core` is `true` AND `core[name] !== undefined` → emit `values[name] = core[name]`.
- If `name in core` is `true` AND `core[name] === undefined` → omit from `values` (JSON cannot represent `undefined`), AND list the `name` in `undefinedProperties`. The consumer MUST dispatch an initial-sync event with `value === undefined` for every `name` in `undefinedProperties`.

Producers MAY omit the `undefinedProperties` field entirely when no declared property is currently `undefined`. Consumers MUST treat a missing field as an empty list.

Legacy compatibility: a producer that predates the `undefinedProperties` field will simply omit it. Consumers SHOULD treat a re-sync that omits a previously-cached property as a revert-to-`undefined` event, even without the explicit list, so that long-running connections do not drift.

> **Known lossy interaction (legacy producers only).** A legacy producer that sends neither `undefinedProperties` nor `getterFailures` cannot let the consumer distinguish "the value is now `undefined`" from "the producer-side read threw and was skipped". Both cases reach the wire as "the property is omitted from `values`". The consumer-side revert-to-`undefined` heuristic above will therefore **misclassify a getter failure on a legacy producer as a value reset to `undefined`**, dispatching a spurious `undefined` event and replacing the cached value with `undefined` in the consumer's state. This is a known irrecoverable gap of the legacy wire shape — it cannot be fixed on the consumer side because the information is not on the wire. Producers SHOULD send `getterFailures` (and `undefinedProperties` when applicable) to opt out of this lossy classification. Consumers MAY surface a "legacy producer detected" warning in their logger to make the limitation visible.

#### `getterFailures` semantics

`getterFailures?: string[]` on the sync response enumerates declared property names for which the producer attempted the sync-time read (`getter` invocation, raw property access, or whatever the producer uses to materialize the value) and that attempt **threw**. These properties:

- MUST be omitted from `values` (the producer has no value to send for them).
- MUST be omitted from `undefinedProperties` (the producer cannot assert that the current value is `undefined`; it failed to read).
- Are NOT a protocol-level error. The wire stays well-formed; only the affected properties are skipped.

Consumer-side rules:

- The consumer MUST log a warning naming each property in `getterFailures` (the producer-side `Logger` will already have a matching entry, but the consumer should surface it too so app-level diagnostics see both sides).
- The consumer MUST NOT dispatch any initial-sync event for properties in `getterFailures`. Specifically: if such a property was previously cached at a non-`undefined` value, the consumer MUST NOT revert the cache to `undefined` on the basis of this sync (that revert is reserved for properties in `undefinedProperties` and for the legacy-fallback case). A getter failure is property-level and transient, not a state assertion.
- Subsequent `update` messages for the same `name` (after the getter recovers) MUST be applied normally — the failure does NOT taint the property permanently.

Producers MAY omit `getterFailures` when no read failed. Consumers MUST treat a missing field as an empty list.

#### Declaration fingerprint

The optional `declarationFingerprint` field on a sync response carries a canonical structural summary of the producer's `wcBindable`:

- `version` — the integer version of the producer's declaration.
- `properties`, `inputs`, `commands` — the **sorted, deduplicated** lists of declared `name`s on each surface. Event names are NOT included: the consumer-side proxy rewrites them to synthetic per-property identifiers (see § Design invariants invariant 2), so cross-the-wire event-name comparison would always report differences and defeat the purpose.

Producers SHOULD include the field on every sync response. The cost is `O(N)` in declaration size and a few hundred bytes of wire payload; the benefit is structural-mismatch detection before the first `set` / `invoke` reaches the producer.

Consumers SHOULD compute the same fingerprint from their **local** declaration (the one passed to `createRemoteCoreProxy` or its equivalent) at construction time, and on every received `sync` response SHOULD compare the local fingerprint to the remote one:

- If they are equal (or the producer omits the field — see legacy fallback below), do nothing.
- If they differ, the consumer MUST log a warning identifying the mismatch and SHOULD continue accepting the sync. Subsequent per-message rejections (an undeclared input name, an undeclared command name) will still fire normally; the fingerprint warning surfaces the root cause at handshake time so operators do not have to chase those rejections back to a version drift.

Consumers MAY suppress the warning after the first mismatch on a given transport to avoid log spam on re-sync; the warning state SHOULD reset on reconnect so a real fingerprint change after reconnect is reported again.

**Legacy fallback.** Producers from a release that predates the field omit it; consumers MUST treat absence as "no fingerprint comparison available" and proceed silently. This keeps the field purely additive on the wire.

**What the fingerprint does NOT cover.** Two declarations whose names match but whose event-name space, getter semantics, or runtime types differ will hash-equal. The fingerprint is a structural-surface check, not a semantic-equivalence check. Use it to catch the common operational case (consumer and producer on different `@my-app/core` package versions); pair it with version-pinning in your dependency lockfile for stronger guarantees.

#### Update-time getter failure

The same property-level, non-fatal treatment applies when a `getter` throws during the producer-side handling of a *subsequent* change event (i.e. when building an `update` message, not during initial sync):

- The producer MUST emit a logger warning naming the property whose getter threw.
- The producer MUST drop the affected `update` — no message is sent. The consumer continues observing the last successfully-transmitted value.
- This is NOT a protocol-level error. The wire stays well-formed, the connection stays open, and the producer keeps processing every other property's event stream normally.
- A subsequent successful event for the same property — whether on a different change or after the getter recovers — MUST be applied normally as an `update`. A previous failure does NOT taint the property permanently.

There is no in-band signal for update-time getter failures (no `updateGetterFailures` field), because change events are property-scoped and re-emit naturally; the next successful event carries the consumer back to a fresh value. If a getter is *permanently* broken, the consumer simply never observes a new `update` for that property — diagnostics live in the producer-side logger.

### `setWithAck` end-to-end

```
client                                producer
  │── { type: "set", name, value,    │
  │     id: "abc" }               ──►│  validate name ∈ inputs
  │                                   │  isReservedRemoteName(name)? throw  (†)
  │                                   │  try: core[name] = value
  │                                   │     (Extension 1: MUST execute before ack)
  │   ◄── { type: "return",       ── │  ack with no value key (Promise<void>)
  │         id: "abc" }               │     ↑ "value" field is omitted per
  │                                   │       § Return envelope value field
```

> **(†) Defense-in-depth.** Per § Reserved names, reserved-name declarations MUST be rejected at proxy construction time, so a conforming consumer-side proxy will never send a `set` whose `name` is reserved. The producer-side check here exists to handle non-conforming or hostile consumers that bypass construction-time validation (e.g. by hand-rolling the wire frame). Producers MUST keep this check in place even though conforming consumers should make it unreachable.

If the assignment throws synchronously, the producer MUST send a `throw` with the same `id`. If `name` is not declared as an input, the producer MUST send a `throw` with `id` (NOT a silent drop), so the client's pending `Promise` rejects with a useful error.

### `invoke` end-to-end

```
client                                producer
  │── { type: "cmd", name, id,       │
  │     args: [...] }              ─►│  validate name ∈ commands
  │                                   │  result = core[name](...args)
  │                                   │  if result instanceof Promise: await
  │   ◄── { type: "return",       ── │  resolve with serialized return value
  │         id, value: result }       │
  │   ◄── { type: "throw",        ── │  or with serialized thrown error
  │         id, error: { ... } }      │
```

The producer's return value (sync or eventual `Promise` resolution) MUST be JSON-serializable. Producers MAY choose to wrap thrown values in an explicit serializable shape; consumers MUST surface them as JavaScript `Error` instances at the proxy boundary (see Extension 1 § Error envelope).

### Reserved names

Implementations MAY reserve a small namespace of `name` values for protocol-internal use (e.g. the reference implementation reserves names beginning with `@wc-bindable/`). Reserved names in a declaration's `properties` / `inputs` / `commands` MUST be rejected at proxy construction time and MUST NOT generate wire traffic. This is a safety net so a typo or hostile declaration cannot silently shadow protocol-level messages.

### Transport adapter contract

A custom transport — anything other than the reference WebSocket transport bundled with `@wc-bindable/remote` — MUST implement two narrow interfaces, one per side of the wire:

```typescript
interface ClientTransport {
  /** Hand a single client message to the wire. MAY throw synchronously
   *  for a terminal failure; transient outages MUST be masked. */
  send(message: ClientMessage): void;

  /** Register the single handler that receives inbound server messages.
   *  Called once during proxy construction. Multiple registrations are
   *  out of contract. */
  onMessage(handler: (message: ServerMessage) => void): void;

  /** Optional. If implemented, called when the transport observes a
   *  terminal close. MUST fire at most once per connection lifetime.
   *  Subsequent transport events MUST be ignored after onClose. */
  onClose?(handler: () => void): void;

  /** Optional. MUST be idempotent. Releases transport resources; the
   *  proxy calls this on dispose() and on `_handleSendFailure`. */
  dispose?(): void;
}

interface ServerTransport {
  /** Symmetric to ClientTransport.send. */
  send(message: ServerMessage): void;
  /** Symmetric to ClientTransport.onMessage. */
  onMessage(handler: (message: ClientMessage) => void): void;
  /** Symmetric to ClientTransport.onClose. */
  onClose?(handler: () => void): void;
  /** Symmetric to ClientTransport.dispose. */
  dispose?(): void;
}
```

A transport implementation conforms when **all** of the following hold:

1. **FIFO delivery on a single channel.** Messages handed to `send()` are observed by the peer's `onMessage` in the same order. The fingerprint, sync-time `update` buffering, and `setWithAck` / `invoke` matching rules all depend on this. Per-connection WebSocket and per-port `MessagePort` satisfy it natively. `BroadcastChannel` and any fan-in / fan-out transport that does not collapse to a single ordered stream **do not** satisfy this in the general case and are non-conformant **by themselves**. A `BroadcastChannel`-based adapter is conformant **only if** it wraps the channel to provide single-producer / single-consumer / FIFO / no-fanout semantics (typically by negotiating a per-connection sub-channel identifier and filtering on it); the wrapper, not the raw channel, is the conformant transport.
2. **JSON-shape payload at the boundary — validate, then serialize.** The transport adapter MUST enforce that every value crossing the boundary matches `JsonValue` in two steps:
   1. **Validate** the value as `JsonValue` via explicit deep traversal (see § Design invariants invariant 3 for the algorithm: plain-object check, accessor rejection, symbol-key rule, finite-number rule, cycle detection). Raw `try { JSON.stringify(v) }` is **non-conformant** as the validation step because `JSON.stringify` silently coerces `NaN` / `Infinity` to `null`, silently drops object own-properties whose value is `undefined` / a function / a symbol, and silently drops symbol-keyed properties.
   2. **Then** serialize — `JSON.stringify` on send and `JSON.parse` on receive, or an equivalent that round-trips JsonValue faithfully. Even on transports whose native channel could carry structured-clone values (`MessagePort`, `Worker.postMessage`), serialization at the boundary is mandatory so every transport presents the same lossy view to the proxy/shell and a payload that survives one transport does not silently change shape on another.

   Doing only step 2 (skipping step 1) lets a `Date`, a `Map`, or an object containing `NaN` reach the wire and silently lose its semantics. Doing only step 1 (skipping step 2) lets a structured-clone-capable transport leak richer values to the consumer side that other transports cannot represent. Both steps are required.
3. **`onClose` is at-most-once.** Reconnect is modeled as constructing a fresh transport instance and passing it to `RemoteCoreProxy.reconnect()` (or equivalent), not as re-firing `onClose` on the same instance.
4. **`dispose()` is idempotent.** The proxy / shell call `dispose()` on terminal failure AND on its own teardown; double-invocation is normal traffic, not an error condition.
5. **Single-handler `onMessage`.** Exactly one handler is registered per transport lifetime; multiple registrations are out of contract.
6. **No silent message manipulation.** The transport MUST NOT rewrite message fields, coalesce frames, or insert synthetic messages. The proxy/shell rely on a 1:1 mapping between `send()` and `onMessage` invocations.

Transport-specific concerns *outside* the normative contract — back-pressure caps, logger injection, framework-integration examples, the concrete WebSocket / `BroadcastChannel` / `MessagePort` / `Worker` implementations bundled with `@wc-bindable/remote` — are documented in [packages/remote/README.md](packages/remote/README.md). That document is operational guidance, not normative; this section is the spec a third-party transport must satisfy to interoperate with any conformant proxy/shell.

### Conformance summary

A wire-format implementation conforms to this extension when:

1. Every client message and server message matches one of the shapes above.
2. The five design invariants (property-centric, getter-on-producer, JSON shape, FIFO, single-shell) hold.
3. `setWithAck` resolves only after the JS-level assignment has executed on the producer side (Extension 1).
4. The undefined-enumeration rule mirrors core's `in`-operator semantics.
5. Reserved names are rejected at proxy construction.

#### Implementation-defined behavior (interop variability flag)

The wire format is *almost* fully prescriptive, but a small number of validation behaviors are left to the implementation by design. Each is documented here so cross-implementation testing can target the spot where two conformant implementations might still differ:

- **Symbol-keyed property handling on `JsonValue` validation.** Default normative rule is "reject any object with own symbol keys" (see § Design invariants invariant 3). Implementations MAY opt out for ecosystem compatibility (React's `Symbol(react.element)`, tagged-immutable libraries) by ignoring symbol keys and documenting that they are never transmitted. Two conformant implementations MAY therefore disagree on whether a particular input is `JsonValue`-valid when symbol keys are present; cross-impl consumers SHOULD avoid relying on symbol-keyed values surviving across the wire under any implementation.

All other validation rules — finite-number gate, plain-object prototype check, accessor rejection, sparse-hole rejection, cycle detection — are fully prescriptive and admit no implementation-defined variation. A `JsonValue` predicate that rejects on one of them in implementation A but accepts in implementation B is non-conformant.

`@wc-bindable/remote` 0.7.x is the reference implementation; [packages/remote/README.md](packages/remote/README.md) documents its operational specifics (back-pressure caps, logger injection, transport adapter contract for `BroadcastChannel` / `MessagePort` / `Worker`).

---

## Extension 3 — Initial-Sync Timing for HTMLElements (informational)

The core protocol's `bind(target, onUpdate, { syncOn: "connect" })` option (see [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection)) handles the common case where the consumer calls `bind()` before the element is attached to the document. The right default depends on **how** the binder gets hold of the target, not just on whether the target is a DOM element:

- **Framework / lifecycle adapters** that call `bind()` from a mounted-element lifecycle hook (React `useEffect`, Vue `onMounted`, Solid `onMount`, Preact `useEffect`, Stencil `componentDidLoad`, Angular `AfterViewInit`, Lit `ReactiveController.hostConnected`, Marko `<lifecycle onMount>`, Mithril `oncreate`, Qwik `useVisibleTask$`, Riot `onMounted`, the element's own `connectedCallback`, …) **SHOULD use the default `syncOn: "call"`**. The host already guarantees the element is attached before the hook runs, so deferring is unnecessary and the shadow-DOM limitation on `MutationObserver` (see SPEC.md § Deferring the Initial Sync Until Connection) does not apply to this path.
- **Imperative binders** that hand the consumer an `el` reference and let the consumer decide when to append it — typical of the VanJS, MobX, RxJS, and Signals adapters in this repository — **MAY default to `syncOn: "connect"`** so that callers do not have to sequence `appendChild()` and `binder.bind(el)` manually. The shadow-DOM limitation still applies; consumers who plan to mount into a shadow tree MUST switch to `syncOn: "call"` from inside the shadow-root host's `connectedCallback` instead.
- **Headless / non-DOM adapters** (Node, Deno, Workers; or DOM environments where `target` may be a plain `EventTarget` subclass) MUST behave as if `syncOn: "call"` were always in effect. The core implementation already falls back to immediate sync when `HTMLElement` / `document` / `MutationObserver` are unavailable; binders SHOULD NOT request the deferred path on headless targets even when defaults pick it implicitly.

This is informational — it is not a normative requirement of the protocol, but adapter authors choosing a default for their published wrapper API SHOULD follow it so that consumers' mental model stays consistent across the ecosystem.

---

## License

MIT
