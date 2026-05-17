# wc-bindable-protocol Extensions

> **Authoritative scope of this document.** SPEC-extensions.md is the **authoritative source for the optional contracts layered on top of core**: Extension 1 (input/command invocation — `set` / `setWithAck` / `invoke` and their lifecycle surface), Extension 2 (the remote wire format — message shapes, JsonValue validation, capability bits, transport adapter contract, the consumer-side `has`-trap rule, `CustomEvent.detail` undefined preservation), and Extension 3 (informational `syncOn` guidance). Core rules (`bind()`, discovery, teardown, conformance levels, versioning) live in [SPEC.md](SPEC.md); runnable test vectors live in [CONFORMANCE.md](CONFORMANCE.md). Where README, packages-level docs, or CONFORMANCE vectors disagree with the rules below, this document is authoritative.

This document describes optional contracts that build on the core [SPEC.md](SPEC.md). The core protocol intentionally interprets only `properties` — the `inputs` and `commands` declarations, along with the `attribute` and `async` hints, are purely declarative at the core level. Their *behavioral* meaning is layered on top by the extensions below.

> The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY**, **REQUIRED**, **RECOMMENDED**, and **OPTIONAL** carry the [BCP 14](https://www.rfc-editor.org/info/bcp14) / [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) meanings when they appear in all capitals. See [SPEC.md § Requirements language](SPEC.md#requirements-language).

Implementations MAY adopt one extension without adopting the others. A consumer that uses only `bind()` from `@wc-bindable/core` does not need any of this document.

---

## Extension 1 — Input/Command Invocation

This extension defines what it means for a consumer to **set an input** or **invoke a command** on a target that conforms to wc-bindable. It is implemented by `@wc-bindable/remote` (across a transport) and is expected to be implemented by future tooling such as devtools and automation runners.

### Naming: factory vs class

The reference implementation `@wc-bindable/remote` exposes two shapes for the consumer-side proxy:

| Symbol | Kind | Purpose |
|---|---|---|
| `RemoteCoreProxy` | class | The underlying constructor. Subclassed internally per declaration to give each instance an isolated `constructor.wcBindable` (see [SPEC.md § Discovery Contract](SPEC.md#discovery-contract)). Most consumers do NOT construct it directly. |
| `createRemoteCoreProxy(declaration, transport, options?)` | factory function | Returns an instance of a per-declaration subclass of `RemoteCoreProxy`, additionally wrapped in a JavaScript `Proxy` so declared property names (e.g. `proxy.value`) resolve from the internal cache. **This is the recommended entry point.** |

`set` / `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` / `reconnect` / `dispose` are **instance methods on the object returned by `createRemoteCoreProxy()`**. References elsewhere in this document of the form `RemoteCoreProxy.<method>` mean "invoked on a `RemoteCoreProxy` instance", not "a static on the class". These methods divide into two surfaces with different normative status:

- **Call methods** (`set`, `setWithAck`, `setWithAckOptions`, `invoke`, `invokeWithOptions`) — defined in § Methods. All are mandatory.
- **Lifecycle methods** (`dispose`, `reconnect`) — defined separately in § Lifecycle methods. `dispose` is mandatory; `reconnect` is OPTIONAL and MUST be omitted entirely when unsupported (rather than exposed as a stub that throws).

Third-party implementations of Extension 1 MAY use any factory name as long as the returned object exposes the mandatory call methods in § Methods and the lifecycle surface in § Lifecycle methods; only the *method* names are normative to the call-site interop (consistent with the discovery-helper naming rule in [SPEC.md § Conformance Levels](SPEC.md#conformance-levels)).

### Methods

> **`setWithAck` is an *assignment-execution* acknowledgement, not a *state-stability* acknowledgement.** The name is shorter than the contract: `setWithAck(name, value)` resolves once `target[name] = value` has executed on the producer side and **for no stronger reason**. It does NOT acknowledge that the resulting state is externally visible, durable, replicated, persisted, observed by downstream subscribers, or that any asynchronous side effect the setter scheduled has completed. A setter that internally `await`s a database write resolves the `setWithAck` promise *when the assignment ran*, not *when the write committed* — components that need to gate a later call on async post-set work MUST expose that work as a `command` so the caller can `await invoke(...)` instead. This precise contract is what the `setWithAck` row of the table below pins; the name is convenience shorthand for that contract, not a stronger guarantee.

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
- Invalid `timeoutMs` (negative, non-finite, non-numeric) is a **protocol-level failure** — the implementation MUST surface it via Promise rejection, never a synchronous throw, consistent with the same rule for all `setWithAck` / `invoke` protocol-level failures in § Methods. Concretely, `setWithAckOptions` / `invokeWithOptions` MUST **synchronously return an already-rejected Promise** carrying a `RangeError`-shaped error rather than throw synchronously or silently coerce / ignore the value. The phrase "synchronously reject" in this spec always means "synchronously return a rejected Promise", never "throw".
- Pre-aborted signals (`signal.aborted === true` at call time) MUST cause the returned promise to reject immediately without sending any wire message.
- After timeout or abort settles the caller's promise, the proxy MUST NOT re-settle it if a late `return` / `throw` envelope arrives for the same `id`. The late envelope MUST be dropped, and the proxy SHOULD log the drop at warn level so the unexpected delivery is visible to diagnostics. (See § Transport lifecycle vocabulary for the terminal-vs-transient terminology that interacts with this.)

#### Lifecycle methods

In addition to the call surface above, the consumer-side proxy exposes a small set of lifecycle methods. Their normative status differs from the call methods because their presence depends on whether the implementation supports reconnect, not on the protocol contract itself:

| Method | Signature | Required? | Semantics |
|---|---|---|---|
| `dispose` | `dispose(): void` | **MUST** be implemented on the consumer-side proxy. | Idempotently releases proxy and transport resources. After `dispose()`: `set` MUST throw, `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` MUST reject (returning an already-rejected Promise per § Methods). `dispose()` itself MUST be safely re-callable as a no-op. Implementations MUST NOT accept a new transport after `dispose()`. |
| `reconnect` | `reconnect(transport: ClientTransport): void` | **OPTIONAL** (MAY be implemented). | If implemented: attaches a fresh transport after the previous one closed, MUST send a fresh `sync`, MUST throw synchronously if the proxy is already disposed OR if the existing transport is still active (re-attaching to a healthy connection is a programmer error). Implementations that do not support reconnect MUST omit `reconnect` from their public surface entirely (rather than expose a stub that throws on every call); consumers can `dispose()` and construct a new proxy as the equivalent operation. |

The reference `@wc-bindable/remote` implementation provides both methods. Third-party implementations that omit `reconnect` should document the omission so consumers know to use the dispose-and-reconstruct path instead.

#### Call-order preservation

Implementations **MUST** preserve the caller's invocation order when serializing `set` / `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` (and any other future `*WithOptions` variant) onto a single logical channel. That is, the proxy itself MUST NOT reorder calls — message N is handed to the transport strictly before message N+1, regardless of which entry point the caller used.

Wire-level ordering between two messages then depends on the transport's own delivery guarantees:

- Transports that preserve message order (e.g. WebSocket over TCP, in-process function calls) inherit this guarantee: a `set("url", X)` immediately followed by `invoke("fetch")` on the same proxy is observed by the remote side as `url ← X` then `fetch()`.
- Transports that do NOT preserve message order (hypothetical UDP-style or multi-channel transports) MUST document the gap, and consumers that need ordering across calls MUST sequence with `await setWithAck(...)` before issuing the dependent call.

The canonical `@wc-bindable/remote` WebSocket transport inherits TCP-level ordering, so the documented `set("url", "..."); await invoke("fetch")` pattern is safe **on a healthy ordered channel**: while the connection is up the producer observes the messages in caller order. For the at-most-once semantics of `set` and the recommendation to use `setWithAck` when `invoke` depends on the prior assignment having been applied, see the canonical statement in [§ Methods](#methods) (the `set` row, "Fast path — unsafe by design"). The same caveat is repeated alongside the README remote example for snippet-level discoverability; the Methods row is the authoritative source.

### The `async` hint

The optional `async: boolean` field on a command descriptor is a **declaration**: it tells tooling that the underlying method returns a `Promise` and the value-carrying frame is the eventual resolution, not the synchronous return. Implementations of this extension SHOULD treat `invoke` as always asynchronous (returning a `Promise`) regardless of `async`; the hint exists for documentation, code generation, and devtools rendering.

The core protocol does NOT inspect this field.

### The `attribute` hint

The optional `attribute: string` field on an input descriptor is a **declaration** for tooling and Web Component attribute reflection. It tells a consumer "when you write `<my-input value="x">`, that maps to the `value` input property." This extension does not prescribe any automatic attribute → property reflection; that is the component's own `observedAttributes` / `attributeChangedCallback` responsibility.

The core protocol does NOT inspect this field.

### Error envelope

When `setWithAck` or `invoke` fails on the remote side, the consumer-side proxy **MUST reject the returned `Promise` with a JavaScript `Error` instance** regardless of the thrown shape on the producer side — the `Error` boundary at the proxy preserves `try { await invoke() } catch (e) { ... }` ergonomics without leaking the producer-side throw oddity into the consumer's catch. The Error instance **SHOULD** preserve the original `name`, `message`, and (when available and permitted by the producer's stack-transmission policy) `stack`; implementations MAY attach the raw serialized payload as `cause`. Implementations MUST NOT silently swallow remote throws.

#### Canonical mapping for non-Error throws

JavaScript allows throwing any value (`throw "oops"`, `throw null`, `throw { code: 42 }`, …), not only `Error` instances. The producer-side proxy MUST canonicalize whatever was thrown into the `{ name, message, stack?, cause? }` envelope shape according to the following rules:

| Thrown value | `name` | `message` | `stack` |
|---|---|---|---|
| An `Error` instance (or subclass) | `error.name \|\| "Error"` | safely stringified `error.message` (empty string is permitted; see safe-stringification rule below) | `error.stack` if present, defensively read (see stack-read rule below), and the producer's trust-boundary policy permits transmission (see Security note on `stack` below) |
| Any other value (string / number / boolean / null / plain object / etc.) | `"NonErrorThrow"` | safely stringified `thrownValue` — typically the value's default coercion (`String(null)` → `"null"`, `String({a:1})` → `"[object Object]"`, etc.) (see safe-stringification rule below) | Omitted (no stack exists for a non-Error throw) |

**Safe-stringification rule.** Naive `String(v)` can itself throw — `String(Object.create(null))` raises because the null-prototype object has no `toString`, and hostile objects with throwing `toString` / `valueOf` / `Symbol.toPrimitive` traps can throw arbitrarily. The producer MUST shield the canonicalization step, **and the shield MUST cover the property read itself, not only the `String(...)` coercion**. A helper that accepts an already-read value does NOT protect against hostile getters: in `safeString(error.name)` the `error.name` read happens at the call site, before any try/catch inside the helper can run. The conformant pattern is to pass the read as a thunk:

```javascript
// Reference safe-stringification used by both rows of the table above.
// `read` is a thunk so the property access happens INSIDE the try/catch,
// shielding the canonicalization step against hostile getters that throw.
function safeStringFrom(read, fallback) {
  try {
    const s = String(read());
    return s || fallback;
  } catch {
    return fallback;
  }
}

const name    = safeStringFrom(() => error.name,    "Error");                       // Error row
const message = safeStringFrom(() => error.message, "");                            // Error row
const messageForNonError = safeStringFrom(() => thrownValue, "<unstringifiable thrown value>"); // non-Error row
```

The fallback strings shown above (`"Error"`, `""`, `"<unstringifiable thrown value>"`) match the rows of the table above; implementations MAY choose different non-empty sentinels for the unstringifiable case as long as the chosen string clearly identifies the safe-stringification fallback. Implementations that prefer an inline `try { ... } catch` over the helper MUST still keep the property read inside the catch — wrapping only the `String(...)` call is non-conformant.

**Stack-read rule.** `error.stack` is also a property access and a subclass MAY install a hostile getter that throws, so the same defensive-read posture applies. Because `stack` is OPTIONAL on the wire (the envelope schema types it `stack?: string`), the producer MUST simply **omit** `stack` from the envelope when reading or stringifying it throws — there is no need for a sentinel fallback because the consumer is already required to cope with an absent `stack` (per the Security note on `stack` below, producers routinely drop it on untrusted transports). Reference shape:

```javascript
// Best-effort, optional. Omit on any failure — never substitute a sentinel.
let stack;
try {
  const raw = error.stack;
  if (raw !== undefined) stack = String(raw);
} catch { /* leave `stack` undefined → omitted from the envelope */ }
// Producers MAY additionally redact / drop `stack` here per the security
// note's untrusted-transport rule; that policy layer composes on top of
// the defensive read, not in place of it.
```

The "omit on read-throw" behavior is also what makes the stack field's optionality robust under hostile inputs: the Security note on `stack` below already requires consumers to handle `stack === undefined`, so a producer that drops a throwing stack adds nothing the consumer has to learn.

The literal string `"NonErrorThrow"` is normative: consumers MAY pattern-match on it to distinguish thrown-non-Error from thrown-Error at the surface.

**`cause` field on the wire.** Producers MAY additionally attach the original thrown value as `cause` in the throw envelope's `error` object (see wire schema in § Message types — server → client) if it survives `JsonValue` validation (§ Design invariants invariant 3); non-JsonValue thrown values MUST be omitted from `cause` (the `name` + `message` pair is the canonical fallback). The validation runs *before* serialization, so a producer that violates JsonValue cannot leak silently. Consumers MAY surface a successfully-transmitted `cause` via JavaScript `Error.cause` on the proxy-side Error instance; the wire `cause` is OPTIONAL on both sides and consumers MUST cope with its absence.

(The "consumer MUST surface as a JavaScript `Error` instance" rule is the same one stated at the top of § Error envelope; it is repeated here only as a reminder when reading the canonical mapping table in isolation.)

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

> **⚠ This wire format is NOT an authorization protocol.** Extension 2 defines how wc-bindable observations and invocations travel across a network. It does **not** define authentication, authorization, rate limiting, per-message payload validation, or trust between the peers. A conformant producer-side shell connected to an untrusted peer will accept every `set` against any declared `input` and every `invoke` against any declared `command` with any `JsonValue`-shape payload — that is the contract, not a bug. **A conformant producer MUST be placed behind an application-owned security layer** (auth handshake at the transport, allow-list filter at the `ServerTransport` adapter, per-command authorization in the Core's command implementation, etc.) before being exposed to an arbitrary peer. Treat `RemoteShellProxy` and `RemoteCoreProxy` as a protocol layer, never as a trust boundary. The full treatment of what this extension does and does NOT provide lives in [§ Trust boundary](#trust-boundary-shared-by-extensions-1-and-2) and in [packages/remote/README.md § Security model / trust boundary](packages/remote/README.md#security-model--trust-boundary).

### Design invariants

1. **Property-centric, not event-centric.** Each `properties[i]` becomes its own per-property message stream identified by `name`. Multiple property descriptors MAY share the same `event` name on the producer side; the wire MUST discriminate by `name`.
2. **`getter` runs on the producer side only.** Functions are NEVER transported as code; only the extracted value crosses the wire. The consumer-side proxy MUST rewrite each `properties[i].event` to a unique synthetic per-property event name on the local declaration so `bind()` on the consumer can discriminate properties that originally shared an event name on the producer. Concretely, the consumer-side proxy:
   - constructs its `constructor.wcBindable.properties` with each entry's `event` replaced by a synthetic name (the reference implementation uses `"@wc-bindable/remote:" + name`),
   - **OMITS** `getter` on every consumer-side property descriptor — when a wire `update` arrives, the proxy dispatches a `CustomEvent` whose `detail` is the already-extracted value, so the default `e => e.detail` getter (from SPEC.md § Default Getter) reads the right value with no remote-side function reference involved. The **only documented exception** is the undefined-preservation carve-out in § CustomEvent `detail` and undefined preservation: a sentinel-unwrapping `getter` is permitted on the consumer-side declaration *solely* to round-trip `undefined` across the `CustomEvent` boundary, where WebIDL's `detail` default would otherwise coerce it to `null`. Any other use of a consumer-side getter is non-conformant,
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
   - Arrays: every element MUST itself satisfy `isJsonValue`. Sparse holes (positions where `i in arr === false`) MUST be **rejected**; the earlier "treat as `null`" alternative is removed because it introduces silent shape change between transports and defeats the validate-before-serialize principle. Callers that need to transmit "this index is unset" MUST encode it explicitly (`null`, or a sentinel they define). Arrays MUST also be **dense and surface-only** — that is, no own enumerable or non-enumerable string keys other than the dense indices `0..length-1`, no own symbol keys, no `length` mutated away from the actual element count. Code like `const arr = [1, 2]; arr.foo = "bar";` is **non-conformant** because `JSON.stringify` silently drops `foo` — the same silent-mutation failure mode that drove the symbol-key rule. Implementations **MUST NOT** opt out of this rule; the silent-loss surface is too easy to introduce by accident and the wire's interop guarantees depend on every conformant impl rejecting it.
   - Plain objects (after the prototype check above): MUST NOT have own **non-enumerable** string-keyed properties. `Object.defineProperty(obj, "hidden", { value: 123, enumerable: false })` is non-conformant for the same reason — `JSON.stringify` silently drops the key, the wire loses the field, and the consumer's value-cache diverges from the producer's intent without any error. Implementations **MUST NOT** opt out of this rule, for the same reason as above. (The symbol-key opt-out below is the only ecosystem-compatibility carve-out; it exists because `Symbol(react.element)`-style tagging is widespread enough that strict rejection breaks practical inputs. The array and non-enumerable cases have no comparable widespread idiom to accommodate.)
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

   - The producer MUST reject any inbound message that fails JSON-shape validation (`set` without a string `name`; `cmd` without a string `name`, without a string `id`, or with `args` that is not an array; type-mismatched required keys MUST be rejected). Unknown extra keys on the envelope are governed by the separate wire-envelope rule below (§ Wire envelope unknown-fields rule), not by core's declaration-level unknown-fields rule — the two rules live at different layers and MUST be reasoned about independently.
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

#### Wire envelope unknown-fields rule

Wire envelopes (client → server **and** server → client) MAY contain unknown top-level fields. Receivers MUST ignore unknown fields after validating `type` and all required fields for the matched message shape. Unknown fields MUST NOT change the semantics of the known fields. This rule:

- is **wire-format-scoped** — it does not depend on, and is not the same as, core's "ignore unknown fields" rule on the `wcBindable` declaration schema (SPEC.md § Schema). The two rules govern different layers (network envelope vs. JavaScript declaration object) and may evolve independently in future spec revisions;
- applies uniformly to every envelope shape defined in § Message types — client → server / server → client (`sync`, `set`, `cmd`, `update`, `return`, `throw`), as well as to **schema-owned nested metadata objects** inside them (`error`, `capabilities`, `declarationFingerprint`). This rule does **NOT** apply to application payload objects carried in `values`, `update.value`, `return.value`, `set.value`, or `cmd.args[i]` — those are `JsonValue` payloads owned by application code, and their keys are user data, not envelope fields. A validator that strips "unknown" keys from a payload object would corrupt the application's data; payload-shape constraints live under § Design invariants invariant 3 (`JsonValue` validation), not under this rule;
- is the forward-compatibility hinge that lets a future spec revision add an optional field (e.g. a new capability bit, a new diagnostic key) without breaking older peers — they keep parsing the known fields and silently drop the new one.

A receiver that rejects on unknown fields (or, equivalently, fails validation when an unknown key is present) is non-conformant. A receiver that *processes* an unknown field — assigning it semantic meaning, mutating state based on it, echoing it back into a different envelope — is also non-conformant: ignore means ignore.

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
// `value` is OPTIONAL by the same JSON-no-undefined rule as the return
// envelope: an absent `value` key represents a transition to `undefined`
// on the producer side. See "Update envelope value field" below.
{ "type": "update", "name": string, "value"?: JsonValue }

// Reply to a setWithAck or invoke with matching id.
// `value` is OPTIONAL. Its absence and its concrete shape have different
// meanings depending on which client message the `id` came from — see the
// "Return envelope value field" subsection below.
{ "type": "return", "id": string, "value"?: JsonValue }
{ "type": "throw",  "id": string, "error": { "name": string, "message": string, "stack"?: string, "cause"?: JsonValue } }
```

- `update` is dispatched for every change event the producer-side shell observes, after applying the producer-side `getter`. The `name` SHOULD be one declared in the producer's `properties` (see § Undeclared-name update handling below for the consumer-side behavior when it is not).
- `return` / `throw` MUST reference an `id` issued by a prior client message. The producer MAY emit only ONE of `return` or `throw` for any given `id`. Implementations SHOULD reject unknown `id`s with a logger warning rather than throwing — late replies after an abort are normal.
- `capabilities.setAck === true` advertises that the producer honors `setWithAck`. **For an Extension 2 producer to claim current conformance, `setAck` MUST be advertised as `true`** (`setWithAck` is part of the consumer-side proxy's mandatory surface in § Methods; a producer that does not implement it leaves a documented safety mechanism unusable across the wire). A producer that omits `capabilities.setAck` or advertises `false` is a **legacy / non-current** producer — it can be interoperated with for fire-and-forget `set` and for property observation, but it does not satisfy the current version of this extension. Consumers MUST still cope with legacy producers (their `setWithAck` calls reject as described below) for backward compatibility, but new producer implementations MUST advertise `setAck: true`.

  > **Wire schema vs conformance.** The capabilities object and its fields are typed OPTIONAL in the wire schema above so legacy producers that predate any given capability can still send a well-formed `sync` response. Conformance levels for each capability differ by safety impact:
  >
  > - `setAck: true` — **MUST** for current Extension 2 producer conformance. `setWithAck` is a safety mechanism (it prevents silent drops on transient outages from corrupting downstream `invoke` calls), so a producer that does not implement it leaves a documented hazard unguarded; that is the threshold for refusing the conformance label.
  > - `undefinedProperties: true` and `getterFailures: true` — **SHOULD** be advertised by new producer implementations. These are diagnostic / classification fields; their absence degrades the consumer-side disambiguation between "modern producer with no undefined values" and "legacy producer" (see the per-capability rules below), but no safety mechanism breaks. Producers that omit them are still current-conformant, just less informative.
  >
  > The split between MUST and SHOULD here is what lets the consumer side detect a legacy peer via field absence while keeping the consumer's parser happy with both shapes.
- Consumers that issued `setWithAck` calls **before** the `sync` response MUST reject all of them with a clear error if `setAck` is absent or `false`. Calls issued **after** a `sync` response whose `setAck` is absent or `false` MUST be rejected by the consumer-side proxy with the same clear error — concretely, `setWithAck` / `setWithAckOptions` MUST **synchronously return an already-rejected `Promise`** (not throw synchronously, consistent with the Promise-rejection rule for protocol-level failures in § Methods). The proxy MUST NOT send a `setWithAck` message it knows the producer will not handle. See § Pre-sync call state machine below for the full pre-sync queueing rules.

##### Pre-sync call state machine

The behavior of `setWithAck` / `setWithAckOptions` calls issued **between proxy construction and the arrival of the first `sync` response** is normative, because optimistic-send vs. queue-then-replay vs. immediate-reject produce wildly different interop bugs in the field. The contract is:

| Call site | Pre-sync behavior (before first `sync` response) |
|---|---|
| `setWithAck` / `setWithAckOptions` | **MUST queue.** Do NOT send the wire message yet — `setAck` capability is unknown, and sending a `setWithAck` to a producer that ends up advertising `setAck: false` (or absent) is forbidden by the "MUST NOT send a message it knows the producer will not handle" rule above. The returned `Promise` stays pending. |
| `invoke` / `invokeWithOptions` | MUST queue on the same queue, so per-caller FIFO is preserved across mixed `setWithAck` + `invoke` traffic. |
| `set` (fire-and-forget) | **SHOULD queue.** Per-caller FIFO across mixed `set` / `setWithAck` / `invoke` traffic is the default behavior — queueing keeps the wire-arrival order consistent with the caller's invocation order, so a later `invoke` can rely on every earlier `set` having reached the producer first. Implementations MAY send immediately as a documented **low-latency profile** — appropriate only when (a) the consumer never sequences a `setWithAck` / `invoke` after a `set` whose effect the dependent call relies on, and (b) the implementation accepts the resulting "queued `setWithAck` lands after immediate `set`" reorder window in exchange for lower latency on isolated `set` calls. A low-latency-profile implementation MUST document the choice in its public API surface so consumers can audit. The reference implementation queues (the default-conformant choice). Fire-and-forget `set` is unaffected by `setAck` either way (it is part of the baseline wire contract; see the bullet above) — the queue/no-queue choice is purely about ordering relative to other queued calls. **Both kinds of synchronous-throw validation listed for `set` in § Methods (the `set` row) MUST happen at the `set()` call site regardless of whether the message is then queued or sent immediately** — that is, both (a) `name ∈ inputs` membership and (b) JsonValue validation of `value`. The reason is symmetric: `set()` returns `void`, so the caller has no other channel to learn about a validation failure; if either check fails, `set()` MUST throw synchronously and the message MUST NOT be queued. Deferring either check to send time would silently swallow a programmer error a queueing implementation would otherwise reliably surface. |

On `sync` response arrival, the proxy MUST replay the queue **in caller order** (FIFO across all queued call sites — `setWithAck`, `setWithAckOptions`, `invoke`, `invokeWithOptions`, and `set` if it was queued):

- If `setAck === true`: each queued `setWithAck` / `setWithAckOptions` is serialized onto the wire after `sync`-response processing completes. Each queued `invoke` / `invokeWithOptions` is serialized in the same order. Queued fire-and-forget `set` (if any) is sent in order too.
- If `setAck` is absent or `false`: each queued `setWithAck` / `setWithAckOptions` MUST reject (returning an already-settled rejected `Promise` if not yet observed by the caller) with the same clear error described in the bullet above; no wire message is sent for them. Queued `invoke` / `invokeWithOptions` and `set` are unaffected — they MUST be sent in caller order (their semantics do not depend on `setAck`).
- The proxy MUST NOT issue any of the deferred wire messages until the `sync` response has been fully processed (capability bits applied, fingerprint compared, initial-sync events dispatched). Doing so earlier risks the producer seeing an `invoke` whose semantics depend on an input the queued `setWithAck` was supposed to apply first, except inverted relative to the consumer's intended order.

On transport-terminal-failure (no `sync` response will ever arrive — `onClose` fired, send threw, etc.) before the queue drains: every pending entry on the queue MUST reject with the terminal-failure error, in caller order. Queue order is the only order observable to the caller, so settling out of order would corrupt user-level error-handling logic that expects "the first failed call is the first one I made".

The consumer-side proxy SHOULD expose its queue depth as a diagnostic; large pre-sync bursts on a slow handshake are a common cause of memory growth that is invisible from outside the proxy.

**Queue ordering is not transactional.** The FIFO replay rule above preserves *order*, not *dependency*. Concretely: if a queued `setWithAck` later rejects (because the producer turned out to be a legacy peer that does not advertise `setAck`, or because the assignment threw on the producer side), every subsequent queued `invoke` / `setWithAck` / `set` MUST still be processed per its own rules — the queue's failure of one entry does NOT cancel later entries automatically. A pattern like:

```javascript
proxy.setWithAck("url", "/api/users");  // queued
proxy.invoke("fetch");                   // also queued, will run regardless of how the setWithAck settles
```

is unsafe if the `invoke` semantically depends on the `setWithAck` having been applied. The conformant pattern when an `invoke` depends on a prior input assignment is to `await` the assignment first:

```javascript
await proxy.setWithAck("url", "/api/users");  // throws if the assignment fails for any reason
const result = await proxy.invoke("fetch");   // only reached if the assignment succeeded
```

This rule applies symmetrically to the steady-state (post-sync) case — the pre-sync queue is just the most visible place the distinction matters, because that is where a single sync response can convert a queue of optimistic calls into a mixture of rejections and successes in one step. The protocol does NOT model transactional batches; consumers that need all-or-nothing semantics across multiple proxy calls MUST build that on top.
- **Fire-and-forget `set` (the `id`-less variant) is unaffected by this capability bit** — it is part of the baseline wire contract and every producer (legacy and current alike) MUST handle it regardless of `setAck` support.

  > **Legacy producer + id-bearing `set` from a non-conforming consumer.** A conforming consumer never sends an `id`-bearing `set` (i.e. a `setWithAck` request) to a legacy producer, because the consumer-side proxy rejects such calls synchronously when `setAck` is absent or `false`. The case "non-conforming or hand-rolled consumer sends an `id`-bearing `set` to a legacy producer" is therefore **out of scope** for this extension — both peers are outside the current contract, so behavior is implementation-defined. Legacy producers MAY reply with a `throw` envelope referencing the `id` (the most diagnostically useful response), MAY drop the message with a logger warning, or MAY ignore the `id` and silently apply the `set` as if it were fire-and-forget. None of these is non-conformant, because the consumer that sent the message is already non-conformant; the spec only governs interactions between conformant peers.
- `capabilities.undefinedProperties === true` advertises that the producer understands and emits the `undefinedProperties` field. Modern producers SHOULD always set this capability; the **capability bit, not the field's presence**, is the disambiguator that lets a consumer tell a modern producer with no undefined values (`undefinedProperties: true`, list empty or omitted) from a legacy producer that does not know about the field (`undefinedProperties` capability absent). The consumer-side revert-to-`undefined` legacy heuristic (see § Undefined enumeration "Legacy compatibility") MUST fire only when the capability is absent. A modern producer with the capability set MAY still omit the field when the list would be empty.
- `capabilities.getterFailures === true` advertises that the producer understands and emits the `getterFailures` field. Same disambiguation rationale as `undefinedProperties` above — a modern producer with no failures and a legacy producer that does not know about the field both result in `getterFailures` being absent on the wire; the capability bit is what tells them apart.

#### Proxy and pending-call lifecycle (state machine summary)

The rules in §§ [Methods](#methods), [Lifecycle methods](#lifecycle-methods), [AckOptions](#ackoptions), [Transport lifecycle vocabulary](#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2), and [Pre-sync call state machine](#pre-sync-call-state-machine) combine into two state machines that a conformant proxy MUST obey. These tables are **non-normative** — the linked sections are authoritative — but they let third-party implementers cross-check "which state is my proxy / my pending entry in, and which transitions are legal." The state names here are descriptive, not normatively pinned, so an implementation that uses different internal names is still conformant as long as the observable transitions match.

##### Remote proxy lifecycle

| State | Entry condition | Behavior in state | Permitted exits |
|---|---|---|---|
| **Constructed** | `createRemoteCoreProxy()` returned (or `RemoteCoreProxy` instance built); transport attached | Has not yet sent the initial `{ "type": "sync" }`; call methods accept input and apply the [Pre-sync call state machine](#pre-sync-call-state-machine) rules | → PreSync (proxy hands the initial `{ "type": "sync" }` to the transport) |
| **PreSync** | Initial `{ "type": "sync" }` handed to transport | `setWithAck` / `invoke` MUST queue; `set` SHOULD queue (default profile per § Pre-sync call state machine — low-latency-profile implementations MAY send immediately); `setAck` capability still unknown | → SyncProcessing (`sync` response received) <br> → TerminalFailure (transport terminal before sync response — every pending entry rejects in caller order per § Pre-sync call state machine) <br> → Disposed (consumer calls `dispose()`) |
| **SyncProcessing** | `sync` response arrived | Applying `values` / `undefinedProperties` / `getterFailures` per the [consumer-side sync-response handler](#consumer-side-sync-response-handling--reference-pseudocode); dispatching initial-sync events; comparing fingerprint; NOT YET draining the queue (the replay rule REQUIRES sync-response processing to complete first) | → Active (sync processed; queue replay begins and completes) <br> → Disposed |
| **Active** | Sync processed; queued calls (if any) drained in caller order | Steady state; new calls hit the wire directly; per-channel FIFO preserved by the transport contract | → TransientFailure (transient transport outage that the transport masks via its own reconnect / backoff) <br> → TerminalFailure (`onClose` fires, `send` synchronously throws, or any non-resumable transport error) <br> → Disposed |
| **TransientFailure** | Transport observed a recoverable outage masked by its own reconnect/backoff layer | `set` MUST NOT throw synchronously (this is the gap `setWithAck` exists to make detectable); `setWithAck` / `invoke` either remain pending until transport recovery OR eventually reject via their AckOptions timeout — both are conformant | → Active (transport recovers transparently) <br> → TerminalFailure (transport gives up; recovery deadline elapsed; explicit `onClose`) <br> → Disposed |
| **TerminalFailure** | Transport in terminal state per [§ Transport lifecycle vocabulary](#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) | `set` MUST throw synchronously; `setWithAck` / `invoke` MUST reject with terminal-failure error; no further wire traffic is sent; every pending entry is settled | → Reconnecting (ONLY if `reconnect()` is implemented AND proxy not yet disposed AND existing transport is past-active) <br> → Disposed |
| **Reconnecting** | `reconnect(transport)` called with a fresh transport while proxy not disposed and previous transport had reached terminal | Fresh transport attached; proxy MUST send a new `{ "type": "sync" }`; pending-entry queue is empty (terminal-failure already drained it) | → PreSync (new initial sync issued) |
| **Disposed** | `dispose()` called from any non-Disposed state | `dispose()` is idempotent (safely re-callable as a no-op); `set` MUST throw, `setWithAck` / `invoke` MUST reject; **proxy MUST NOT accept a new transport** per [§ Lifecycle methods](#lifecycle-methods) | (terminal — the consumer must construct a new proxy to interact again) |

Notes:

- **Disposed is the only terminal state visible to the consumer.** TerminalFailure is potentially recoverable via `reconnect()` if the implementation supports it; implementations that omit `reconnect()` leave TerminalFailure → Disposed as the only exit.
- **Reconnecting is NOT reachable from Disposed** — `reconnect()` MUST throw synchronously if the proxy is already disposed.
- **Reconnecting is NOT reachable from Active or PreSync or SyncProcessing or TransientFailure when the transport is still healthy** — `reconnect()` MUST throw synchronously if the existing transport is still active. Re-attaching to a healthy connection is a programmer error per [§ Lifecycle methods](#lifecycle-methods).
- **Implementations MAY omit `reconnect()` entirely.** In that case Reconnecting is unreachable for that implementation, and the conformant equivalent for the consumer is `dispose()` followed by constructing a new proxy.

##### Pending-call lifecycle (`setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions`)

A "pending entry" is the in-memory record corresponding to one acknowledged call awaiting settlement. Fire-and-forget `set` does NOT appear here because it has no acknowledgement and no pending entry — its only normative settle path is synchronous throw at the call site per § Methods.

| State | Entry condition | Behavior in state | Permitted exits |
|---|---|---|---|
| **Created** | Consumer invoked `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` | Synchronous validation: `name` declared in inputs/commands; consumer-side `JsonValue` check on `value` / `args`; pre-aborted signal check; disposed-proxy check | → Queued (proxy is Constructed or PreSync) <br> → Sent (proxy is Active) <br> → Rejected (validation failed, pre-aborted signal, disposed proxy, or — for `setWithAck` after sync arrival showing `setAck` absent — see below) |
| **Queued** | Created AND proxy is Constructed / PreSync | Holding caller's `Promise` pending; entry sits in the pre-sync queue; FIFO across all queued call sites per § Pre-sync call state machine | → Sent (sync response arrived AND, for `setWithAck`, `setAck: true` advertised) <br> → Rejected (sync response arrived AND `setAck` absent/`false` for `setWithAck`; OR transport terminal before sync response) <br> → Aborted (caller's `AbortSignal` fired before send) <br> → TimedOut (`timeoutMs` elapsed before send) |
| **Sent** | Message handed to `transport.send()` (either directly from Created in Active, or via queue replay) | Entry recorded in proxy's `id → pending` table; awaiting matching `return` / `throw` envelope | → Resolved (`return` envelope with matching `id` received) <br> → Rejected (`throw` envelope with matching `id`; transport terminal; inbound JsonValue validation failure) <br> → Aborted (caller's `AbortSignal` fired) <br> → TimedOut (`timeoutMs` elapsed) |
| **Resolved** | `return` envelope received | Consumer `Promise` resolved with the deserialized value (or `undefined` for `setWithAck`); entry removed from `id → pending` table | (terminal) |
| **Rejected** | `throw` envelope received, OR transport terminal, OR validation failure, OR `setAck`-absent rejection | Consumer `Promise` rejected with a JavaScript `Error` instance per [§ Error envelope](#error-envelope); entry removed from `id → pending` table | (terminal) |
| **Aborted** | `AbortSignal` fired before settlement (Queued or Sent) | Consumer `Promise` rejected with the signal's `reason` (or a synthetic `AbortError`); entry removed; **no wire-level cancellation is sent** (abort is local-only per § AckOptions); if the message had already left the proxy, the producer continues processing it | (terminal) |
| **TimedOut** | `timeoutMs` elapsed before settlement (Queued or Sent) | Consumer `Promise` rejected with a `TimeoutError`; entry removed; same wire posture as Aborted (no cancellation sent) | (terminal) |

Notes:

- **"Late envelope drop" is NOT a pending-call state.** A `return` / `throw` envelope arriving for an `id` whose pending entry has already reached a terminal state (Rejected / Aborted / TimedOut — Resolved cannot apply because the producer MUST emit only one of `return` / `throw` per `id`, so a second envelope for an already-resolved `id` is a producer bug) is a behavior of the proxy's `id → pending` table, not a state of the entry. The proxy MUST drop the envelope without re-settling the consumer `Promise` and SHOULD log at warn level. See [§ AckOptions](#ackoptions) for the timeout / abort late-envelope rule and the [pre-sync `setWithAck`-against-legacy-producer rejection](#pre-sync-call-state-machine) path.
- **Aborted and TimedOut are observationally equivalent from the producer's perspective.** Both terminate the consumer-side `Promise` and drop the pending entry locally; neither emits a wire-level cancellation. The producer continues running the corresponding command or setter to completion and eventually emits a `return` / `throw` envelope that the consumer's late-envelope rule then silently drops.
- **Queue ordering is not transactional** (per § Pre-sync call state machine "Queue ordering is not transactional"). A queued entry transitioning to Rejected does NOT cancel later queued entries — each transitions per its own rules. The pending-call lifecycle of entry N is independent of entry N-1's terminal state, even when N depends on N-1 semantically.
- **The `id → pending` table is the integration point between the two state machines above.** Proxy lifecycle TerminalFailure / Disposed transitions drain the table by settling every entry as Rejected; pending-entry terminal transitions (Resolved / Rejected / Aborted / TimedOut) remove themselves from the table. An implementation MUST keep the two consistent — for example, draining the table on TerminalFailure MUST settle each entry in caller order, not in arbitrary `Map` iteration order, so the consumer's error-handling sees the same FIFO it issued.

#### Return envelope value field

`value` is OPTIONAL on a `return` envelope. Because the wire is JSON-only (no `undefined` representation, see § Design invariants), the producer cannot transmit a literal `undefined` as the value; the producer MUST encode the absence-of-value case by omitting the `value` key entirely. The interpretation differs by which client message the `id` came from:

- **`setWithAck` ack.** The `Promise` resolves with `void`, so there is no return value to transmit. The producer MUST omit the `value` field. Consumers MUST ignore any `value` that does appear on a setWithAck `return` (treat as a producer bug worth logging) and MUST resolve the pending promise with `undefined`.
- **`invoke` return.** The producer represents the method's return value as follows:
  - Synchronous or eventual return of `undefined` → omit `value`. Consumers MUST resolve the pending promise with `undefined`.
  - Synchronous or eventual return of `null` → set `value: null`. Consumers MUST resolve the pending promise with `null`. **`null` and `undefined` are wire-distinguishable** via key presence (omitted vs. present-with-`null`).
  - Any other JsonValue → set `value: <that JsonValue>`. Consumers MUST resolve the pending promise with the deserialized value.

The earlier "value: undefined" pseudocode in the end-to-end diagrams was a JS-level shorthand; on the wire it always serialized as a missing key (because `JSON.stringify` drops own properties whose value is `undefined`), and that omission is now the normative encoding.

#### Update envelope value field

The exact same key-presence rule applies to the `update` envelope: `value` is OPTIONAL, and an absent `value` represents the producer-side state transition to `undefined`. This is how a producer signals a **post-sync transition into `undefined`** — sync-time `undefined` lives in the snapshot's `undefinedProperties` list (because it concerns multiple properties at once), but per-property transitions during normal operation use the update envelope, and JSON's inability to carry `undefined` would otherwise leave producers no way to express the transition at all.

- The producer-side shell observes a change event for `name` and reads (or recomputes) the current value:
  - If the value is `undefined` → emit `{ "type": "update", "name": <name> }` (omit `value`).
  - If the value is `null` → emit `{ "type": "update", "name": <name>, "value": null }`. Like the return envelope, `null` and `undefined` are wire-distinguishable by key presence.
  - Otherwise → emit `{ "type": "update", "name": <name>, "value": <JsonValue> }` after `JsonValue` validation.
- The consumer-side proxy treats absent `value` as `undefined`: it updates its local cache to `undefined` and MUST surface the transition to `bind()` consumers as `onUpdate(name, undefined)` — **NOT** as `onUpdate(name, null)`. See § CustomEvent detail and undefined preservation below for why the obvious `new CustomEvent(eventName, { detail: undefined })` path does not satisfy this and what conformant mitigations look like.
- Producers that need to advertise their understanding of this rule SHOULD set `capabilities.undefinedProperties: true` on the sync response — the same capability bit already covers the sync-time `undefined` enumeration and now also confirms post-sync `undefined` transitions are emitted. Legacy producers (capability absent) cannot signal post-sync `undefined` transitions at all; the consumer's only recovery in that case is a fresh `sync` request, which the producer MAY trigger by closing and reopening the transport. This is a known irrecoverable gap of the legacy wire shape (see § Undefined enumeration "Known lossy interaction").

#### CustomEvent `detail` and undefined preservation

WebIDL coerces `undefined` to a dictionary member's default value, and the `CustomEventInit.detail` member defaults to `null`. As a consequence, in every conformant runtime (browsers, Node, Deno, Workers):

```javascript
new CustomEvent("x", { detail: undefined }).detail === null  // true, NOT undefined
```

This breaks the obvious "the proxy dispatches a per-property `CustomEvent` whose `detail` is the undefined value, and the default `e => e.detail` getter (Design invariants invariant 2) reads the right value" path: the dispatched event's `detail` is `null`, the default getter returns `null`, and the `bind()` consumer observes `onUpdate(name, null)` while the proxy's internal cache (read via `proxy.<name>`) reads `undefined`. The wire faithfully encoded the producer's `undefined` via key omission, but the last hop — the consumer-side `CustomEvent` boundary — silently re-coerced it to `null`, producing a cache-vs-listener divergence that the consumer has no way to repair.

**Normative consumer-side rule.** A consumer-side proxy MUST surface every undefined transition (both initial-sync via `undefinedProperties` per § Undefined enumeration and post-sync via the absent-`value` `update` rule above) to `bind()` callbacks as `value === undefined`. The proxy MUST NOT rely on `CustomEvent.detail` round-tripping `undefined`. Conformant mitigation choices include, but are not limited to:

- **Sentinel + custom getter.** Place a per-proxy private sentinel on `detail` for the undefined-bearing transition, and include a `getter` on the consumer-side property descriptor that unwraps the sentinel back to `undefined` (returning `e.detail` otherwise). This is the **only documented exception** to Design invariants invariant 2's "OMITS `getter` on every consumer-side property descriptor" rule — the carve-out exists solely to preserve `undefined` across the `CustomEvent` boundary; consumer-side getters MUST NOT be used for any other purpose.
- **Direct listener invocation.** Bypass `CustomEvent` dispatch entirely for the undefined case and invoke the registered listener callbacks directly (the proxy already owns the listener registry through its own `addEventListener` implementation).
- **Any equivalent mechanism** that delivers `undefined` (not `null`) to the consumer-observed `onUpdate` for both the initial-sync and the post-sync transition paths, *and* keeps the proxy's internal cache and the listener-delivered value in agreement.

> **Reference implementation status (informative).** `@wc-bindable/remote` as of 0.7.x currently dispatches `new CustomEvent(eventName, { detail: undefined })` for both paths and therefore lets `bind()` callbacks observe `null` while `proxy.<name>` reads `undefined`. This is a documented divergence from the rule above and is tracked for a follow-up release; the spec text is the authoritative target. Consumers writing against the spec contract SHOULD treat post-sync `null` observed on a property the producer drove to `undefined` as the symptom of this gap.

#### Consumer-side proxy `has` trap contract

Core's initial-sync rule (SPEC.md § Initial Value Synchronization) gates per-property delivery on `prop.name in target`. For a remote proxy the producer's value is not present locally until the `sync` response lands, so the consumer's `bind()` MUST skip initial sync on first call and receive the value via the post-`sync` dispatch path instead. This depends on the proxy returning `false` from the `in` check for un-synced names — a requirement that becomes load-bearing the moment the consumer-side proxy is built on a JS `Proxy` (the obvious implementation, since the reference impl uses it to resolve `proxy.<name>` reads from the internal cache).

**Normative rule.** A consumer-side proxy MUST satisfy the following `has`-trap contract **for every declared `properties` name `N`** (the rule does NOT extend to `inputs` / `commands` names — see the "Scope" note below):

- **Before the `sync` response has been processed:** `N in proxy === false`.
- **After the `sync` response has been processed:** `N in proxy === true` for `N` that appeared in `values` or `undefinedProperties`; `N in proxy === false` for `N` that the producer omitted from both (per § Undefined enumeration, this means "property not present on the producer" and core's `in`-operator gate MUST continue to skip it).
- **For names NOT in the declaration's `properties` at all:** behavior is unspecified by this contract — the proxy MAY return `true` (e.g. for inherited `EventTarget` method names) or `false`. Core's `bind()` only consults `in` for declared property names, so this does not affect initial-sync correctness.
- **After a re-sync** (e.g. on reconnect): the same rules re-apply with respect to the new `sync` response.

**Scope: inputs and commands.** The `has`-trap contract applies to declared `properties` only. `inputs` and `commands` are not part of the initial-value synchronization gate — core's `bind()` never consults `N in proxy` for them, and `values` / `undefinedProperties` in the `sync` response are property-side snapshots that do not carry input/command names. For declared `inputs` / `commands` names, `N in proxy` is **implementation-defined**: an implementation MAY expose `proxy.<inputName>` / `proxy.<commandName>` facades (returning the current input value, or the callable command method) and report `true`, MAY hide them and report `false`, or MAY do anything in between, as long as the consequence does not leak into a `bind()`-observed behavior change. Callers wanting to know whether an `inputName` or `commandName` is declared should read `proxy.constructor.wcBindable` and inspect the declaration directly, not probe with `in`.

Without this rule, a JS-Proxy-based consumer that lets `has` fall through to the underlying object would let `bind()` fire a spurious *early* `onUpdate(name, value)` reading whatever the pre-sync state happens to be (typically `undefined`), and then fire *again* when the per-property `CustomEvent` arrives after `sync` — producing two initial deliveries for the same property and breaking the "exactly one initial sync per property at bind time" guarantee that the rest of the spec rests on.

The reference `RemoteCoreProxy` implementation satisfies this by tracking a per-property "has been synced" flag in its cache and returning `false` from its `has` trap until the flag is set; third-party implementations MAY choose any equivalent mechanism (separate `Set` of known names, sentinel values, etc.) as long as the observable `in` behavior matches the rule above.

#### Undeclared-name update handling

If the consumer-side proxy receives an `update` whose `name` is not in its local `properties` declaration (typically caused by a declaration-fingerprint mismatch where the producer exposes a property the consumer's local declaration does not know about), the consumer:

- MUST NOT throw or close the transport. The wire stays well-formed at the protocol level even if the application-level shape disagrees.
- MUST drop the `update` silently with respect to state — no event is dispatched to `bind()` consumers, no entry is written to the proxy's value cache.
- SHOULD log the drop at warn level naming the rejected `name`, so operators following up on a fingerprint-mismatch warning have a per-message trail.

This "liberal drop with warn" stance lets a partial-deploy or version-drift scenario continue working for the names both sides do agree on, while making the disagreement visible in logs. The reference `RemoteCoreProxy` implementation follows exactly this contract.

### Undefined enumeration

This rule mirrors core's `in`-operator initial-sync semantics across the wire. The producer-side shell computes the initial sync snapshot as follows for each declared property `name`:

- If `name in core` is `false` → omit from `values`, do NOT list in `undefinedProperties`. The consumer MUST treat this as "property not present" and MUST NOT dispatch an initial-sync event for it. (Subsequent `update` messages still apply normally.)
- If `name in core` is `true` AND `core[name] !== undefined` → emit `values[name] = core[name]`.
- If `name in core` is `true` AND `core[name] === undefined` → omit from `values` (JSON cannot represent `undefined`), AND list the `name` in `undefinedProperties`. The consumer MUST surface an initial-sync event with `value === undefined` for every `name` in `undefinedProperties` — see § CustomEvent `detail` and undefined preservation for why a plain `new CustomEvent(name, { detail: undefined })` dispatch does not satisfy this rule and what conformant mitigations look like.

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

#### Consumer-side sync-response handling — reference pseudocode

The prose above gives the normative rules for `values` / `undefinedProperties` / `getterFailures` and their capability bits; the pseudocode below shows how those rules compose into a single sync-response handler so implementations do not have to re-derive the branching from the running text. It is **non-normative** — the prose is authoritative — but mirrors what `@wc-bindable/remote`'s consumer-side proxy does on every `sync` arrival.

```javascript
// Consumer-side proxy: process one inbound `sync` response.
// `prev` is the per-property cache snapshot before this sync (used for the
// legacy revert-to-undefined heuristic).
function processSync(msg, prev, capabilities, logger) {
  const declaredNames = new Set(declaration.properties.map(p => p.name));
  const values             = msg.values             ?? {};
  const undefinedProps     = msg.undefinedProperties ?? [];
  const getterFailures     = msg.getterFailures      ?? [];

  // 1) Apply explicit values. Each entry produces an initial-sync event.
  for (const [name, value] of Object.entries(values)) {
    if (!declaredNames.has(name)) continue;       // not in local declaration — drop silently
    cache.set(name, value);
    dispatchInitialSync(name, value);             // observed via bind() onUpdate
  }

  // 2) Apply explicit-undefined enumeration. MUST preserve `undefined`
  //    (not `null`) at the bind() boundary — see § CustomEvent `detail`
  //    and undefined preservation.
  if (capabilities?.undefinedProperties === true) {
    for (const name of undefinedProps) {
      if (!declaredNames.has(name)) continue;
      cache.set(name, undefined);
      dispatchInitialSyncUndefined(name);         // sentinel-or-bypass path
    }
  } else {
    // Legacy producer — capability absent. Fall back to the revert-to-
    // undefined heuristic for previously-cached names that vanished from
    // `values`. Known to misclassify getter failures as undefined resets;
    // see "Known lossy interaction (legacy producers only)" blockquote.
    for (const name of declaredNames) {
      const wasCached  = prev.has(name);
      // Use Object.hasOwn (not `name in values`) so that inherited keys like
      // "toString" / "constructor" on the values object cannot spuriously
      // satisfy the gate. The wire "appeared in values" semantics are
      // own-key only — see § Wire envelope unknown-fields rule and JSON's
      // own-key serialization model.
      const stillThere = Object.hasOwn(values, name);
      if (wasCached && !stillThere) {
        cache.set(name, undefined);
        dispatchInitialSyncUndefined(name);
      }
    }
  }

  // 3) Apply getterFailures. Property-level, non-fatal, NO state assertion.
  //    Do NOT touch the cache or dispatch — log only.
  if (capabilities?.getterFailures === true) {
    for (const name of getterFailures) {
      if (!declaredNames.has(name)) continue;
      logger.warn(`producer getter failed during sync: ${name}`);
      // intentionally: no cache write, no dispatch
    }
  }
  // (Legacy producers cannot send getterFailures, so step 3 is a no-op
  // for them by construction — and the legacy fallback in step 2 then
  // misclassifies a failed read as an undefined reset.  That misclassi-
  // fication is the "Known lossy interaction" called out above.)

  // 4) Compare the producer's declarationFingerprint with the local
  //    fingerprint and log a warning on mismatch. Continue processing
  //    regardless — fingerprint is diagnostic, not gating.
  compareFingerprint(msg.declarationFingerprint, localFingerprint, logger);
}
```

Three things to notice in the branching:

1. **Capability bit, NOT field presence**, drives the modern-vs-legacy split (steps 2 and 3). A modern producer with no undefined values sends `capabilities.undefinedProperties: true` and an empty (or omitted) `undefinedProperties` list; a legacy producer sends nothing in either slot. The two are distinguishable only by the capability bit.
2. **`getterFailures` does NOT touch the cache.** It is a *property-level* failure assertion, not a state assertion; previously-cached non-`undefined` values stay cached, and a subsequent successful `update` for the same name will replace them normally.
3. **Step 2's legacy fallback always processes BEFORE step 3.** This is the structural reason the "Known lossy interaction" misclassification cannot be repaired on the consumer side: by the time step 3 would have evidence that the missing-from-`values` property was actually a getter failure (not an undefined reset), step 2 has already written `undefined` into the cache and dispatched the spurious event. The capability bit's role is to *skip* step 2's heuristic entirely so step 3's explicit-failure list becomes authoritative.

#### Declaration fingerprint

The optional `declarationFingerprint` field on a sync response carries a canonical structural summary of the producer's `wcBindable`:

- `version` — the integer version of the producer's declaration.
- `properties`, `inputs`, `commands` — the **sorted, deduplicated** lists of declared `name`s on each surface. Event names are NOT included: the consumer-side proxy rewrites them to synthetic per-property identifiers (see § Design invariants invariant 2), so cross-the-wire event-name comparison would always report differences and defeat the purpose. (Dedup is a no-op for valid declarations — name uniqueness within each list is already required by [SPEC.md § Property / Input / Command Descriptor](SPEC.md#property-descriptor); the dedup step here is defense-in-depth against a malformed or hostile producer that bypasses construction-time validation, not a feature of the canonical algorithm.)

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

**Normative minimum.** The namespace prefix `@wc-bindable/` is reserved by this specification. Every conformant Extension 2 implementation MUST reject any declared `properties` / `inputs` / `commands` `name` that begins with the literal string `@wc-bindable/` at proxy construction time (consumer-side) and at shell construction time (producer-side), and MUST NOT generate wire traffic for such a name. This is the cross-implementation portion of the reserved-name rule — pinning the prefix makes a single conformance vector test for it across every implementation, regardless of which other names that implementation also reserves.

**Implementation-defined extensions.** Implementations MAY reserve additional names beyond the normative minimum (e.g. `__proto__`, vendor-prefixed namespaces, debugging-tool names). Such additions MUST be documented in the implementation's public API surface so consumers know which extra names are forbidden in their declarations. The reference implementation reserves only the normative minimum (`@wc-bindable/` prefix).

The reservation is a safety net so a typo or hostile declaration cannot silently shadow protocol-level messages (the synthetic per-property event names the consumer-side proxy generates, the wire envelope `type` discriminator, and other internal identifiers all use the `@wc-bindable/` prefix). Reserved-name rejection happens at construction time, never at message-send time, so a passing-construction declaration is guaranteed to be reservation-clean for the lifetime of the proxy / shell.

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
   1. **Validate** the value as `JsonValue` via explicit deep traversal (see § Design invariants invariant 3 for the full algorithm: plain-object prototype check, accessor rejection, symbol-key rule, finite-number rule, sparse-hole rejection, array dense-and-surface-only rule, non-enumerable string-key rejection on plain objects, cycle detection). Raw `try { JSON.stringify(v) }` is **non-conformant** as the validation step because `JSON.stringify` silently coerces `NaN` / `Infinity` to `null`, silently drops object own-properties whose value is `undefined` / a function / a symbol, silently drops symbol-keyed properties, silently drops non-enumerable string-keyed properties, and silently drops own properties of arrays whose keys are not dense indices.
   2. **Then** serialize — `JSON.stringify` on send and `JSON.parse` on receive, or an equivalent that round-trips JsonValue faithfully. Even on transports whose native channel could carry structured-clone values (`MessagePort`, `Worker.postMessage`), serialization at the boundary is mandatory so every transport presents the same lossy view to the proxy/shell and a payload that survives one transport does not silently change shape on another.

   Doing only step 2 (skipping step 1) lets a `Date`, a `Map`, or an object containing `NaN` reach the wire and silently lose its semantics. Doing only step 1 (skipping step 2) lets a structured-clone-capable transport leak richer values to the consumer side that other transports cannot represent. Both steps are required.
3. **`onClose` is at-most-once.** Reconnect is modeled as constructing a fresh transport instance and passing it to `reconnect()` on the proxy (an instance method on the object returned by `createRemoteCoreProxy()` — see [§ Naming: factory vs class](#naming-factory-vs-class)), not as re-firing `onClose` on the same instance.
4. **`dispose()` is idempotent.** The proxy / shell call `dispose()` on terminal failure AND on its own teardown; double-invocation is normal traffic, not an error condition.
5. **Single-handler `onMessage`.** Exactly one handler is registered per transport lifetime; multiple registrations are out of contract.
6. **No silent message manipulation.** The transport MUST NOT rewrite message fields, coalesce frames, or insert synthetic messages. The proxy/shell rely on a 1:1 mapping between `send()` and `onMessage` invocations.

Transport-specific concerns *outside* the normative contract — back-pressure caps, logger injection, framework-integration examples, the concrete WebSocket / `BroadcastChannel` / `MessagePort` / `Worker` implementations bundled with `@wc-bindable/remote` — are documented in [packages/remote/README.md](packages/remote/README.md). That document is operational guidance, not normative; this section is the spec a third-party transport must satisfy to interoperate with any conformant proxy/shell.

### Conformance summary

A wire-format implementation conforms to this extension when:

> Half of these rules have runnable starter vectors in [CONFORMANCE.md](CONFORMANCE.md). At minimum, an Extension 2 implementation should pass vectors **5, 6, 7, 9, and 10** (the `has`-trap pre-sync rule, the `update`-with-no-`value` undefined preservation, `JsonValue` validation, `setWithAck` ordering, and the legacy-`setAck` rejection path), plus any core vectors that apply to the local bind surface it exposes — see CONFORMANCE.md's "Applies to" column for the per-vector scoping. Pass the applicable subset before claiming Extension 2 conformance; the file is necessary, not sufficient.

1. Every client message and server message matches one of the shapes above.
2. The five design invariants (property-centric, getter-on-producer, JSON shape, FIFO, single-shell) hold.
3. **Producers MUST advertise `capabilities.setAck: true` and MUST honor `setWithAck`** (the promise resolves only after the JS-level assignment has executed; see Extension 1 § Methods). A producer that omits the capability or advertises `false` is a legacy / non-current producer, NOT a current-version conformant one; consumers MUST interoperate with legacy producers for backward compatibility, but new producer implementations cannot claim conformance without the acknowledged path.
4. The undefined-enumeration rule mirrors core's `in`-operator semantics.
5. Reserved names are rejected at proxy construction.

#### Implementation-defined behavior (interop variability flag)

The wire format is *almost* fully prescriptive, but a small number of validation behaviors are left to the implementation by design. Each is documented here so cross-implementation testing can target the spot where two conformant implementations might still differ:

- **Symbol-keyed property handling on `JsonValue` validation.** Default normative rule is "reject any object with own symbol keys" (see § Design invariants invariant 3). Implementations MAY opt out for ecosystem compatibility (React's `Symbol(react.element)`, tagged-immutable libraries) by ignoring symbol keys and documenting that they are never transmitted. Two conformant implementations MAY therefore disagree on whether a particular input is `JsonValue`-valid when symbol keys are present; cross-impl consumers SHOULD avoid relying on symbol-keyed values surviving across the wire under any implementation.

All other validation rules — finite-number gate, plain-object prototype check, accessor rejection, sparse-hole rejection, array dense-and-surface-only rule, non-enumerable string-key rejection on plain objects, cycle detection — are fully prescriptive and admit no implementation-defined variation. A `JsonValue` predicate that rejects on one of them in implementation A but accepts in implementation B is non-conformant.

`@wc-bindable/remote` 0.7.x is the **current implementation** and the basis for this specification, but it is **not yet a complete conformance oracle**: at least one normative rule in this document (the undefined-preservation rule in § CustomEvent `detail` and undefined preservation) is not yet satisfied by 0.7.x — see the "Reference implementation status (informative)" blockquote in that section for the specific gap. Where this spec and 0.7.x diverge, **the spec is authoritative**; the package will track toward full conformance in subsequent releases. [packages/remote/README.md](packages/remote/README.md) documents its operational specifics (back-pressure caps, logger injection, transport adapter contract for `BroadcastChannel` / `MessagePort` / `Worker`).

---

### Minimal implementation checklist

A minimal conformant Extension 2 implementation should implement the following in roughly this order; each step depends on the ones above it. This list mirrors the normative content above as a build order, not as a substitute for it — every step links back to the spec section that defines it.

1. **Discover and validate the source declaration.** Read `target.constructor.wcBindable` through the core's `getWcBindableDeclaration()` (see [SPEC.md § Discovery API](SPEC.md#discovery-api)). Reject anything that fails the core's schema validation; do not try to repair invalid declarations.
2. **Reject reserved names** at proxy construction (§ Reserved names). A consumer-side proxy MUST NOT be constructible against a declaration whose properties / inputs / commands names collide with the wire's reserved namespace.
3. **Build an observation-equivalent consumer-side declaration** (see [SPEC.md § Discovery Contract](SPEC.md#discovery-contract) → wrapper bullet). Same property / input / command names; synthetic per-property event names; `getter` omitted (the wire delivers already-extracted values).
4. **Synthesize a per-instance subclass** carrying the consumer-side declaration as its `static wcBindable`, so each proxy instance has an isolated `constructor.wcBindable` discoverable by `bind()`.
5. **Implement the `has`-trap contract** for declared `properties` names (§ Consumer-side proxy `has` trap contract). Before the `sync` response has been processed, `name in proxy` MUST be `false` for every declared property name; after `sync`, it MUST be `true` for property names the producer sent in `values` or `undefinedProperties` and `false` for property names the producer omitted from both. `inputs` / `commands` names are **implementation-defined** for `in` — they are not part of this checklist step (see the linked spec section's "Scope: inputs and commands" note). Skipping this step lets core's initial-sync gate fire twice — once early against the empty pre-sync state and once on `sync` arrival — for every property on every bind.
6. **Send `{ type: "sync" }`** on the transport at construction (§ Wire format — client → server).
7. **Process the `sync` response.** Apply the values, dispatch initial-value events (preserving `undefined` per § CustomEvent `detail` and undefined preservation — a plain `new CustomEvent(name, { detail: undefined })` is non-conformant because WebIDL coerces the `detail` to `null`), honor `undefinedProperties` and `getterFailures` per their capability bits (§ Undefined enumeration, § `getterFailures` semantics, § sync response capabilities). Compare the producer's `declarationFingerprint` to your local fingerprint and log a warning on mismatch (§ Declaration fingerprint).
8. **Validate every outbound `set` / `cmd` payload as `JsonValue`** before handing it to the transport (§ Design invariants invariant 3, consumer-side validation). Reject locally — synchronous throw for fire-and-forget `set`, rejected `Promise` for `setWithAck` / `invoke`.
9. **Serialize at the transport boundary.** `JSON.stringify` on send, `JSON.parse` on receive, even when the underlying channel could carry richer values (§ Transport adapter contract invariant 2). Validation comes first; serialization is step 2.
10. **Preserve FIFO** on the single logical channel between proxy and shell (§ Transport adapter contract invariant 1).
11. **Maintain an `id → pending` table** for `setWithAck` and `invoke`. Match incoming `return` / `throw` envelopes by `id`; drop late envelopes after timeout or abort settles the caller's promise (§ AckOptions).
12. **Honor `capabilities.setAck: true`** as a producer; reject `setWithAck` calls cleanly against legacy producers that omit or set `false` (§ sync response capabilities). For current Extension 2 producer conformance, advertise `setAck: true` and implement `setWithAck` end-to-end.
13. **Make `dispose()` idempotent**, and treat `onClose` as at-most-once (§ Transport adapter contract invariants 3 + 4). If the implementation supports reconnect (it is OPTIONAL per § Lifecycle methods), reconnect by attaching a fresh transport via `reconnect()` on the proxy instance (see § Naming: factory vs class); otherwise consumers `dispose()` the proxy and construct a new one as the equivalent operation.

A producer-side implementation has a symmetric checklist: validate inbound payloads, dispatch declared property events to the connected shell, advertise the capabilities it supports, apply incoming `set` synchronously before acking, route command return values / throws through the wire envelope, and emit the declaration fingerprint on every sync response.

---

## Extension 3 — Initial-Sync Timing for HTMLElements (informational)

The core protocol's `bind(target, onUpdate, { syncOn: "connect" })` option (see [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection)) handles the common case where the consumer calls `bind()` before the element is attached to the document. The right default depends on **how** the binder gets hold of the target, not just on whether the target is a DOM element:

This section is **non-normative guidance**, not a conformance requirement. Capitalized RFC 2119 keywords are intentionally avoided in the bullets below so a reader scanning for normative claims is not misled — the only normative obligations on `syncOn` choice live in [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection) and the consumer-side fallback in the core reference implementation. The bullets below describe the recommended *default* an adapter author picks for their published wrapper API.

- **Framework / lifecycle adapters** that call `bind()` from a mounted-element lifecycle hook (React `useEffect`, Vue `onMounted`, Solid `onMount`, Preact `useEffect`, Stencil `componentDidLoad`, Angular `AfterViewInit`, Lit `ReactiveController.hostConnected`, Marko `<lifecycle onMount>`, Mithril `oncreate`, Qwik `useVisibleTask$`, Riot `onMounted`, the element's own `connectedCallback`, …) are best served by the default `syncOn: "call"`. The host already guarantees the element is attached before the hook runs, so deferring is unnecessary and the shadow-DOM limitation on `MutationObserver` does not apply to this path.
- **Imperative binders** that hand the consumer an `el` reference and let the consumer decide when to append it — typical of the VanJS, MobX, RxJS, and Signals adapters in this repository — can default to `syncOn: "connect"` so that callers do not have to sequence `appendChild()` and `binder.bind(el)` manually. The shadow-DOM limitation still applies; consumers who plan to mount into a shadow tree are better served by `syncOn: "call"` from inside the shadow-root host's `connectedCallback`.
- **Headless / non-DOM adapters** (Node, Deno, Workers; or DOM environments where `target` may be a plain `EventTarget` subclass) effectively get `"call"` behavior whatever `syncOn` value they pass — the core implementation falls back to immediate sync when `HTMLElement` / `document` / `MutationObserver` are unavailable. See the "Synthetic / proxy targets fall back to `\"call\"` automatically" blockquote under [SPEC.md § Deferring the Initial Sync Until Connection](SPEC.md#deferring-the-initial-sync-until-connection). Binders therefore do not need to special-case headless targets.

These are recommendations; adapter authors who pick a different default for a good reason are not out of conformance — they are just deviating from the convention the in-tree adapters follow.

---

## License

MIT
