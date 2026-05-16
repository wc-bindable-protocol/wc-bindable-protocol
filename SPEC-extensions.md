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
| `set` | `set(name: string, value: unknown): void` | Fire-and-forget assignment of an input property. **At-most-once delivery.** No acknowledgement. Throws synchronously only if `name` is not declared in `inputs`, the transport has terminally failed, or the proxy is disposed. |
| `setWithAck` | `setWithAck(name: string, value: unknown): Promise<void>` | Acknowledged assignment. **The promise MUST NOT resolve before the JS-level assignment `target[name] = value` has executed on the trusted side**; it MUST reject if the assignment throws, the remote rejects the message as undeclared/invalid, the transport closes, the call times out, or the proxy is disposed. The proxy does NOT wait for asynchronous side effects of the setter (e.g. a setter that schedules background work) — components that need to gate `invoke` on async post-set work SHOULD expose a command instead so the caller can `await invoke()`. **At-least-once delivery is NOT promised** — on transport failure the proxy rejects rather than silently retrying, because re-sending could re-apply a non-idempotent input (an increment, a write to an append-only log) twice, which the proxy cannot detect. The conservative default is at-most-once and the caller is responsible for any retry. Implementations MAY layer exactly-once on top via per-call idempotency keys but MUST document the choice. |
| `invoke` | `invoke(name: string, ...args: unknown[]): Promise<unknown>` | Calls a declared command. Resolves with the (serialized) return value, or rejects with a serialized form of the thrown error. Throws synchronously / rejects asynchronously if `name` is not in `commands`, the transport is closed, or the proxy is disposed. |

The set of declared inputs and commands MUST be the same as the declarations exposed in `target.constructor.wcBindable.inputs` / `.commands` so that local and remote behavior agree.

#### Call-order preservation

Implementations **MUST** preserve the caller's invocation order when serializing `set` / `setWithAck` / `invoke` onto a single logical channel. That is, the proxy itself MUST NOT reorder calls — message N is handed to the transport strictly before message N+1.

Wire-level ordering between two messages then depends on the transport's own delivery guarantees:

- Transports that preserve message order (e.g. WebSocket over TCP, in-process function calls) inherit this guarantee: a `set("url", X)` immediately followed by `invoke("fetch")` on the same proxy is observed by the remote side as `url ← X` then `fetch()`.
- Transports that do NOT preserve message order (hypothetical UDP-style or multi-channel transports) MUST document the gap, and consumers that need ordering across calls MUST sequence with `await setWithAck(...)` before issuing the dependent call.

The canonical `@wc-bindable/remote` WebSocket transport inherits TCP-level ordering, so the documented `set("url", "..."); await invoke("fetch")` pattern is safe on it. The same pattern on an unordered transport requires `await setWithAck("url", "...")` first.

### The `async` hint

The optional `async: boolean` field on a command descriptor is a **declaration**: it tells tooling that the underlying method returns a `Promise` and the value-carrying frame is the eventual resolution, not the synchronous return. Implementations of this extension SHOULD treat `invoke` as always asynchronous (returning a `Promise`) regardless of `async`; the hint exists for documentation, code generation, and devtools rendering.

The core protocol does NOT inspect this field.

### The `attribute` hint

The optional `attribute: string` field on an input descriptor is a **declaration** for tooling and Web Component attribute reflection. It tells a consumer "when you write `<my-input value="x">`, that maps to the `value` input property." This extension does not prescribe any automatic attribute → property reflection; that is the component's own `observedAttributes` / `attributeChangedCallback` responsibility.

The core protocol does NOT inspect this field.

### Error envelope

When `setWithAck` or `invoke` fails on the remote side, the consumer-side proxy SHOULD raise an `Error` whose `name`, `message`, and (when available) `stack` reflect the original throw. Implementations MAY attach the raw serialized payload as `cause`. Implementations MUST NOT silently swallow remote throws.

### Trust boundary

This extension transports `set` and `invoke` calls across a trust boundary. The receiving side MUST treat all arguments as untrusted input. In particular:

- The remote side MUST validate that the message references a declared `inputs` / `commands` name before reaching the Core.
- The remote side MUST NOT transport `getter` functions as code — `getter` is applied on the trusted side, and only the extracted value crosses the wire.
- Authentication, authorization, rate limiting, and payload schema validation are the responsibility of the layer that owns the transport, not of this extension.

See [packages/remote/README.md](packages/remote/README.md) for the canonical reference implementation and its concrete trust-boundary guidance.

---

## Extension 2 — Wire Format (Remote Proxying)

This section is the **normative** wire-format specification for any implementation that transports wc-bindable across a network. Third-party implementations of the consumer-side proxy or the producer-side proxy MUST conform to this contract to interoperate with `@wc-bindable/remote` (the reference implementation). Concrete usage examples, error-handling tips, back-pressure controls, and framework-integration snippets live in [packages/remote/README.md](packages/remote/README.md); the contract itself is here.

### Design invariants

1. **Property-centric, not event-centric.** Each `properties[i]` becomes its own per-property message stream identified by `name`. Multiple property descriptors MAY share the same `event` name on the producer side; the wire MUST discriminate by `name`.
2. **`getter` runs on the producer side only.** Functions are NEVER transported as code; only the extracted value crosses the wire. The consumer-side proxy MUST rewrite each `properties[i].event` to a unique synthetic per-property event name on the local declaration so `bind()` on the consumer can discriminate properties that originally shared an event name on the producer.
3. **JSON-shape payloads only.** Every value the wire carries MUST round-trip through `JSON.stringify` / `JSON.parse`: plain objects, arrays, strings, finite numbers, booleans, `null`. `undefined`, `Date`, `Map`, `Set`, `BigInt`, typed arrays, class instances, functions, and cyclic objects are out of contract. Transports whose native channel could preserve richer values (e.g. `MessagePort` structured clone) MUST serialize at the boundary so every transport presents the same lossy view.
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

### Message types — server → client

```
// Initial sync response. `values` is { [name: string]: JsonValue }.
// `undefinedProperties` enumerates names whose current value is `undefined` —
// these are omitted from `values` because JSON cannot represent undefined.
// See "Undefined enumeration" below.
{
  "type": "sync",
  "values": { [name: string]: JsonValue },
  "undefinedProperties"?: string[],
  "capabilities"?: { "setAck"?: boolean },
  "getterFailures"?: string[]
}

// Subsequent per-property change forwarded by the shell.
{ "type": "update", "name": string, "value": JsonValue }

// Reply to a setWithAck or invoke with matching id.
{ "type": "return", "id": string, "value": JsonValue }
{ "type": "throw",  "id": string, "error": { "name": string, "message": string, "stack"?: string } }
```

- `update` is dispatched for every change event the producer-side shell observes, after applying the producer-side `getter`. The `name` MUST be one declared in `properties`.
- `return` / `throw` MUST reference an `id` issued by a prior client message. The producer MAY emit only ONE of `return` or `throw` for any given `id`. Implementations SHOULD reject unknown `id`s with a logger warning rather than throwing — late replies after an abort are normal.
- `capabilities.setAck === true` advertises that the producer honors `setWithAck`. Consumers that issued `setWithAck` calls before the `sync` response MUST reject all of them with a clear error if `setAck` is absent or `false`.

### Undefined enumeration

This rule mirrors core's `in`-operator initial-sync semantics across the wire. The producer-side shell computes the initial sync snapshot as follows for each declared property `name`:

- If `name in core` is `false` → omit from `values`, do NOT list in `undefinedProperties`. The consumer MUST treat this as "property not present" and MUST NOT dispatch an initial-sync event for it. (Subsequent `update` messages still apply normally.)
- If `name in core` is `true` AND `core[name] !== undefined` → emit `values[name] = core[name]`.
- If `name in core` is `true` AND `core[name] === undefined` → omit from `values` (JSON cannot represent `undefined`), AND list the `name` in `undefinedProperties`. The consumer MUST dispatch an initial-sync event with `value === undefined` for every `name` in `undefinedProperties`.

Producers MAY omit the `undefinedProperties` field entirely when no declared property is currently `undefined`. Consumers MUST treat a missing field as an empty list.

Legacy compatibility: a producer that predates the `undefinedProperties` field will simply omit it. Consumers SHOULD treat a re-sync that omits a previously-cached property as a revert-to-`undefined` event, even without the explicit list, so that long-running connections do not drift.

### `setWithAck` end-to-end

```
client                                producer
  │── { type: "set", name, value,    │
  │     id: "abc" }               ──►│  validate name ∈ inputs
  │                                   │  isReservedRemoteName(name)? throw
  │                                   │  try: core[name] = value
  │                                   │     (Extension 1: MUST execute before ack)
  │   ◄── { type: "return",       ── │  ack with value: undefined
  │         id: "abc",                │
  │         value: undefined }        │
```

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

### Conformance summary

A wire-format implementation conforms to this extension when:

1. Every client message and server message matches one of the shapes above.
2. The five design invariants (property-centric, getter-on-producer, JSON shape, FIFO, single-shell) hold.
3. `setWithAck` resolves only after the JS-level assignment has executed on the producer side (Extension 1).
4. The undefined-enumeration rule mirrors core's `in`-operator semantics.
5. Reserved names are rejected at proxy construction.

`@wc-bindable/remote` 0.7.x is the reference implementation; [packages/remote/README.md](packages/remote/README.md) documents its operational specifics (back-pressure caps, logger injection, transport adapter contract for `BroadcastChannel` / `MessagePort` / `Worker`).

---

## Extension 3 — Initial-Sync Timing for HTMLElements (informational)

The core protocol's `bind(target, onUpdate, { syncOn: "connect" })` option (see [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection)) handles the common case where the consumer calls `bind()` before `appendChild()`. Implementations that wrap `bind()` in a binder/adapter SHOULD default to `syncOn: "connect"` when their target type is constrained to DOM elements, and to `syncOn: "call"` when the target may be a headless `EventTarget`.

This is informational — it is not a normative requirement of the protocol.

---

## License

MIT
