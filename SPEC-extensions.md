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
| `setWithAck` | `setWithAck(name: string, value: unknown): Promise<void>` | Acknowledged assignment. The promise resolves when the remote side has accepted (or applied) the value, and rejects on remote validation failure, transport closure, timeout, or disposal. **At-least-once delivery is NOT promised** — that is, on transport failure the proxy will reject the pending call rather than silently retrying. Re-sending could re-apply a non-idempotent input (e.g. an increment, a write to an append-only log) twice, which the proxy has no way to detect; the conservative default is at-most-once and the caller is responsible for any retry. Implementations MAY layer exactly-once on top via per-call idempotency keys but MUST document the choice. |
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

Implementations that transport wc-bindable across a network MUST conform to a wire format that the consumer-side proxy and the producer-side proxy both agree on. The `@wc-bindable/remote` package defines one such format (JSON-only over a transport-agnostic message channel). A summary:

- The wire is **property-centric**, not event-centric. Each `properties[i]` becomes its own per-property message stream. This is necessary because multiple property descriptors may share the same `event` name on the Core side, and the wire must discriminate by `name`.
- `getter` is applied on the producer side. Only the extracted value crosses the wire.
- Initial `sync` carries a snapshot of currently-defined property values, mirroring core's `in` operator semantics: a property where `name in core` is `true` is transmitted (including when the value is `undefined`), and a property where `name in core` is `false` is omitted. Because JSON cannot represent `undefined` directly, the wire format MUST enumerate the names of properties whose current value is `undefined` in a separate field so the consumer can dispatch an explicit `undefined` event during initial sync rather than reading the omission as "not present". This is the cross-the-wire equivalent of the core's "exists-but-undefined → deliver / does-not-exist → skip" rule. See `packages/remote/README.md` § Connection lifecycle.
- All values that cross the wire MUST be JSON-serializable. Implementations MAY support richer payloads on transports that allow it, but MUST NOT extend the contract in a way that breaks JSON-only consumers.

A full wire-format specification lives in [packages/remote/README.md](packages/remote/README.md).

---

## Extension 3 — Initial-Sync Timing for HTMLElements (informational)

The core protocol's `bind(target, onUpdate, { syncOn: "connect" })` option (see [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection)) handles the common case where the consumer calls `bind()` before `appendChild()`. Implementations that wrap `bind()` in a binder/adapter SHOULD default to `syncOn: "connect"` when their target type is constrained to DOM elements, and to `syncOn: "call"` when the target may be a headless `EventTarget`.

This is informational — it is not a normative requirement of the protocol.

---

## License

MIT
