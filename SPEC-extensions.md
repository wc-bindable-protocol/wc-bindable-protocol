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

> **Producer-side cancellation requires an explicit command.** `AckOptions.signal` and `AckOptions.timeoutMs` are **local cancellations** — they settle the consumer-side `Promise` and drop the pending entry locally, but they do NOT send any wire-level cancellation to the producer (see § Pending-call lifecycle "Aborted and TimedOut are observationally equivalent from the producer's perspective"). If the message has already left the proxy, the producer continues processing the corresponding `set` / `cmd` to completion, eventually emitting a `return` / `throw` envelope that the consumer's late-envelope rule then silently drops. For short-running calls this is harmless (the producer's wasted work is bounded by the call's own runtime). For **long-running commands** — a network fetch, a CPU-bound computation, a streaming aggregation — the producer-side work continues to consume resources after the consumer has lost interest, with no protocol-level way to signal "stop". Component authors of long-running commands SHOULD therefore expose an explicit `abort` / `cancel` command in the `wcBindable.commands[]` declaration and document the convention that callers invoke it instead of (or in addition to) relying on `AckOptions.signal`. The `<my-fetch>` example in [SPEC.md § Web Component (HTMLElement)](SPEC.md#web-component-htmlelement) and [SPEC.md § Headless (EventTarget only)](SPEC.md#headless-eventtarget-only) — which declares both `fetch` and `abort` commands — is the canonical shape. This guidance is INFORMATIVE (no MUST), because cancellation policy is component-specific; the normative claim is only that `AckOptions.signal` MUST NOT be assumed by component authors to deliver producer-side cancellation.

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

**Machine-readable `code` field.** The error envelope MAY carry an optional `code: string` whose value identifies the failure class in a form that survives `name` differences across runtimes (JS engines, ports to other languages) and message-text localization. The producer side requirement is **conditional on origin** — see the "Producer-side code-emission rule" subsection immediately below the registry table — while the consumer side rule is uniform: consumers MUST cope with `code` being absent (legacy producers, non-conformant peers, application errors that opt out) and treat the `{ name, message }` pair as the canonical fallback. When emitted, `code` SHOULD be drawn from the following normatively-registered set so cross-implementation pattern-matching works uniformly:

| `code` value | Meaning |
|---|---|
| `WC_BINDABLE_UNDECLARED_INPUT` | The `set` / `setWithAck` `name` is not declared in `inputs` on the producer side |
| `WC_BINDABLE_UNDECLARED_COMMAND` | The `invoke` `name` is not declared in `commands` on the producer side |
| `WC_BINDABLE_RESERVED_NAME` | The `name` matches a reserved-namespace rule (see § Reserved names) — defense-in-depth signal when a non-conforming consumer bypasses construction-time validation |
| `WC_BINDABLE_DUPLICATE_ID` | Carried on a TerminalFailure-channel-close diagnostic (synthetic error built locally on either side; NOT emitted as a wire `throw` against the duplicate `id` — see the id-constraints bullet in § Message types — client → server for why the wire `throw` path is forbidden in this case) |
| `WC_BINDABLE_INVALID_JSON_VALUE` | Server-side validation of `set.value` / `cmd.args[i]` against `JsonValue` failed |
| `WC_BINDABLE_INVALID_RETURN_VALUE` | The command's return value failed server-side `JsonValue` validation (so `return` could not be emitted; the `throw` carries this code instead) |
| `WC_BINDABLE_TIMEOUT` | The call exceeded its `AckOptions.timeoutMs` |
| `WC_BINDABLE_ABORTED` | The call was aborted via `AckOptions.signal` |
| `WC_BINDABLE_REMOTE_THROW` | The producer-side assignment / command implementation threw a non-protocol error (the original throw's `name` / `message` / `cause` carry the details) |
| `WC_BINDABLE_TERMINAL_FAILURE` | The transport has reached the terminal state per [§ Transport lifecycle vocabulary](#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) (e.g. `onClose` fired, `send` synchronously threw and the proxy disconnected); pending entries drained by this transition reject with this code. Distinct from `WC_BINDABLE_DISPOSED` (consumer-initiated) and from `WC_BINDABLE_PROTOCOL_ERROR` (wire bug) — this is a normal transport-level outage signal, not a protocol violation |
| `WC_BINDABLE_DISPOSED` | `dispose()` was called on the proxy; pending entries drained by this transition reject with this code, and subsequent `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` calls reject with the same code. `set()` after dispose throws synchronously and SHOULD carry the same code on the thrown Error. Distinct from `WC_BINDABLE_TERMINAL_FAILURE` because it signals an *intentional* consumer-side teardown rather than a transport-level outage — adapters that recover from `TERMINAL_FAILURE` via reconnect MUST NOT auto-recover from `DISPOSED` (a disposed proxy is, by contract, never reusable) |
| `WC_BINDABLE_PROTOCOL_ERROR` | Any other normatively-defined wire-protocol failure not covered above (malformed envelope shape, unexpected wire state, etc.). Reserved for genuine wire-protocol bugs and version mismatches — not for normal transport outages (use `WC_BINDABLE_TERMINAL_FAILURE`) or consumer-initiated teardown (use `WC_BINDABLE_DISPOSED`) |

Implementations MAY define additional `code` values for failures outside this list, but SHOULD prefix them with an implementation-identifying namespace (e.g. `MYIMPL_…`) so cross-impl pattern matches on the standard codes above remain unambiguous. The wire envelope unknown-fields rule (§ Wire envelope unknown-fields rule) covers any additional, non-`code` fields inside `error` for forward compatibility — consumers MUST ignore unknown sibling fields of `error` (e.g. a future `error.severity`) rather than rejecting.

**Code-emission rule for locally-synthesized errors (origin-conditional MUST / MAY).** The `code` field is no longer uniformly OPTIONAL — its required-ness depends on whether the error is **locally synthesized by the protocol** (the implementation already knows the failure class by construction) or **originated by application code on the producer** (the implementation cannot know the failure class without a guess). The rule **applies symmetrically to both emission sites** — producers building a `throw` wire envelope, and consumer-side proxies constructing a synthetic `Error` for a local failure (timeout, abort, validation, malformed inbound, dispose). The two tables below pin each origin separately so the consumer-side coverage cannot be mistakenly read as producer-only:

*Emission site A — producer-side `throw` wire envelope.*

| Error origin | Examples | `code` requirement on the emitted `throw.error.code` |
|---|---|---|
| **Locally synthesized protocol error** — the producer-side shell built the `throw` from a known protocol condition before reaching application code | `WC_BINDABLE_UNDECLARED_INPUT` / `WC_BINDABLE_UNDECLARED_COMMAND` (name not in declaration), `WC_BINDABLE_RESERVED_NAME`, `WC_BINDABLE_INVALID_JSON_VALUE` (inbound `set.value` / `cmd.args[i]` failed `JsonValue`), `WC_BINDABLE_INVALID_RETURN_VALUE` (command's return value failed `JsonValue` on the producer side, so the `return` was converted into a `throw`), `WC_BINDABLE_PROTOCOL_ERROR` (malformed inbound envelope, unexpected wire state) | **MUST** carry `code`, drawn from the registry table above. The producer has the failure class on hand at envelope-construction time; omitting `code` here forces every consumer into `message`-string-pattern-matching, defeating the registry's whole point. |
| **Application error from the producer's command / setter** — `target[name] = value` or `target.command(...)` threw a non-protocol error that the shell forwards as a `throw` envelope | A user-defined validation error, a domain `RangeError`, a `fetch` failure inside a `fetch` command, anything thrown by application logic | `code` MAY be set to `WC_BINDABLE_REMOTE_THROW` (the safe default) or MAY be omitted; producers MAY also use an application-namespaced code (e.g. `MYAPP_VALIDATION_FAILED`) if they want a richer classification. **MUST NOT** repurpose any other `WC_BINDABLE_*` code from the registry, because that would collide with the consumer's `code`-pattern-matching for protocol failures. The `name` / `message` (and optional `cause`) pair remains the canonical fallback for the no-code case. |

*Emission site B — consumer-side local `Error` (no wire envelope, the proxy builds the Error itself before rejecting the caller's Promise or throwing from `set()`).*

| Error origin | Examples | `code` requirement on the constructed `Error.code` |
|---|---|---|
| **Locally synthesized protocol error** — the proxy built the `Error` itself from a known protocol condition without involving the producer | `WC_BINDABLE_TIMEOUT` (AckOptions timer fired before the producer's reply arrived), `WC_BINDABLE_ABORTED` (AckOptions signal fired), `WC_BINDABLE_INVALID_JSON_VALUE` (consumer-side outbound `set.value` / `cmd.args[i]` failed `JsonValue` before send), `WC_BINDABLE_UNDECLARED_INPUT` / `WC_BINDABLE_UNDECLARED_COMMAND` (consumer-side membership check before send), `WC_BINDABLE_PROTOCOL_ERROR` (malformed inbound `sync` / `return` / `throw` per [§ Consumer-side malformed message handling](#consumer-side-malformed-message-handling)), `WC_BINDABLE_TERMINAL_FAILURE` (transport reached terminal state per [§ Transport lifecycle vocabulary](#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2); pending entries drained by this transition), `WC_BINDABLE_DISPOSED` (`dispose()` was called) | **MUST** carry `code`, drawn from the registry table above. Same rationale as emission site A: the proxy has the failure class on hand at Error-construction time. This explicitly covers `WC_BINDABLE_PROTOCOL_ERROR` synthetic errors built locally on a malformed inbound envelope — see [§ Consumer-side malformed message handling](#consumer-side-malformed-message-handling) (the malformed-`sync` / `return` / `throw` rows that already say "MUST reject ... with a `WC_BINDABLE_PROTOCOL_ERROR`-coded synthetic error"). |
| **Producer-originated application error decoded from an inbound `throw` envelope** | The wire arrived with `throw.error.code === "WC_BINDABLE_REMOTE_THROW"` (or omitted, or an application-namespaced code) per emission site A's application-error row | Pass-through. The consumer-side proxy MUST surface the producer's `code` faithfully on the constructed `Error.code` (whatever it was, including absent) — the proxy MUST NOT inject a synthetic code for an application-origin throw, because doing so would shadow the producer's intent. |

This split keeps consumer-side recovery logic robust: a `try { await invoke(...) } catch (e) { switch (e.code) { case "WC_BINDABLE_TIMEOUT": ...; case "WC_BINDABLE_TERMINAL_FAILURE": ...; case "WC_BINDABLE_DISPOSED": ... } }` block can rely on every `WC_BINDABLE_*` code being present whenever the failure class genuinely is one of those, without having to pattern-match `e.message` substrings or fall back to `e.name` heuristics that legitimate runtime variation can break.

> **Backwards compatibility.** Older `@wc-bindable/remote` versions (pre-current spec) emitted `code` only on a subset of locally-synthesized errors, and conflated dispose / terminal / generic protocol failures into a single `WC_BINDABLE_PROTOCOL_ERROR` (or omitted code entirely). The strengthened MUST and the new `WC_BINDABLE_TERMINAL_FAILURE` / `WC_BINDABLE_DISPOSED` codes apply to **new producer / consumer implementations** and to the current reference implementation as it tracks toward full spec conformance; consumers MUST cope with `code` absence and with the legacy fallback of receiving `WC_BINDABLE_PROTOCOL_ERROR` for a dispose / terminal case, per the uniform consumer rule at the top of this section. A producer or proxy that omits `code` on a locally-synthesized error, or that uses `WC_BINDABLE_PROTOCOL_ERROR` for a dispose-induced rejection, is non-conformant under the current spec but does not break interop — the consumer falls back to `{ name, message }` matching or to treating the coarse code as best-effort. The rule exists so the fallback becomes the exception path, not the steady-state path.

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
- `cmd.id` is a client-allocated identifier (e.g. UUID v4). The producer MUST echo it back in the `return` / `throw` envelope. The following constraints are normative:
  - `id` **MUST** be a non-empty string. An empty string, a non-string, or any other falsy value is malformed and the producer MUST treat it as it would any other malformed inbound message (see § Design invariants invariant 3 → "Producer-side handling of malformed inbound messages"): if any well-formed `id`-bearing message is reachable from the malformed input the producer MUST `throw` against it, otherwise log + drop. **An empty-string `id` does not count as "well-formed `id`-bearing" — the producer cannot rely on echoing it back to disambiguate** (a `return`/`throw` with `id: ""` from a conformant producer is unreachable for any conformant consumer, since the consumer never allocates `""`), so the conformant action against `id: ""` is log + drop.
  - The consumer-side proxy **MUST** allocate `id`s that do not collide with any pending entry in its `id → pending` table at allocation time. UUID v4 satisfies this trivially; hand-rolled allocators (counters, hash-of-args) MUST check the table before assigning. On a local collision the proxy MUST regenerate (or reject the call as a programmer error) — sending two `cmd` / `set` messages with the same `id` is non-conformant.
  - On the producer side, if an inbound `cmd` or id-bearing `set` carries an `id` that matches an entry the producer has not yet settled (return/throw not yet emitted), the producer **MUST NOT execute the later message** (no setter invocation, no command call). Because the response `id` would be ambiguous — a `return` / `throw` carrying that `id` is, on the wire, indistinguishable from the reply to the first pending entry, and a conformant consumer would settle the *original* call against it — the producer **MUST NOT emit a `return` or `throw` envelope carrying the duplicate `id` as the response to the later message**. Two conformant responses are defined, and the constraint on the original pending entry differs by route:

    - **Log + drop path (default; SHOULD prefer this for accidental-duplicate resilience).** The producer logs a warning naming the duplicate `id` and drops the later message. The original pending entry **MUST NOT** be canceled, rejected, or otherwise settled by this code path — it continues to its natural settlement (the producer-side handler still runs the original `cmd` / `set` to completion and emits its `return` / `throw` when done). The consumer's late-arrived duplicate-`id` call has no producer-side reply and will eventually settle via its consumer-side AckOptions timeout / abort.
    - **TerminalFailure path (MAY, for strict deployments treating duplicate-`id` as a protocol violation).** The producer transitions the channel to TerminalFailure with a synthetic `WC_BINDABLE_DUPLICATE_ID`-coded reason and tears down the transport. As part of standard channel teardown the producer MAY reject every outstanding pending entry — including the original entry whose `id` was duplicated — typically by surfacing a local synthetic error to producer-side observers; this is part of teardown, not a per-duplicate response. The producer **SHOULD NOT** emit a final wire `throw` envelope carrying the duplicate `id` (or the original `id`) merely to surface the duplicate-detection reason — local synthetic rejection plus the transport `onClose` is the cleaner channel-failure signal, and a final wire `throw` settles the consumer-side pending against an `id` whose semantic owner is now ambiguous. A producer that genuinely wants to surface the diagnostic over the wire MAY emit a final `throw` against the *original* pending `id` *only if* it explicitly accepts that this intentionally settles the original pending call as part of TerminalFailure; in every other case the local-synthetic + `onClose` path is preferred.

    A duplicate `id` after the first one has been settled (i.e. `return`/`throw` already emitted for that `id`) is governed by the consumer-side late-envelope rules in § AckOptions, not by this producer-side check — by the time the duplicate arrives, the producer's `id → pending` table no longer carries the original entry, so the duplicate just looks like a normal new call.
  - Lifetime scope: the constraints above protect the *pending window*. Once a `return`/`throw` has been emitted and the consumer's pending entry is settled, an implementation MAY reuse the `id` for a fresh call (UUID v4 makes this moot in practice; hand-rolled counter-style allocators rely on it for bounded-memory operation). Reuse before the producer's reply has been observed is the case the rules above forbid.
- `{ type: "sync" }` carries no `id`. **At most one `sync` request MAY be outstanding per channel at a time.** The consumer-side proxy MUST NOT issue a new `sync` until the previous one has either received its `sync` response or the channel has been torn down. The producer MAY conflate back-to-back `sync` requests it has not yet answered into a single response. If a future revision needs concurrent `sync` requests (e.g. cross-shell snapshots on a multiplexed transport), introduce a new message type with an explicit `id` rather than overloading this one.

#### Wire envelope unknown-fields rule

Wire envelopes (client → server **and** server → client) MAY contain unknown top-level fields. Receivers MUST ignore unknown fields after validating `type` and all required fields for the matched message shape. Unknown fields MUST NOT change the semantics of the known fields. This rule:

- is **wire-format-scoped** — it does not depend on, and is not the same as, core's "ignore unknown fields" rule on the `wcBindable` declaration schema (SPEC.md § Schema). The two rules govern different layers (network envelope vs. JavaScript declaration object) and may evolve independently in future spec revisions;
- applies uniformly to every envelope shape defined in § Message types — client → server / server → client (`sync`, `set`, `cmd`, `update`, `return`, `throw`), as well as to **schema-owned nested metadata objects** inside them (`error`, `capabilities`, `declarationFingerprint`). This rule does **NOT** apply to application payload objects carried in `values`, `update.value`, `return.value`, `set.value`, or `cmd.args[i]` — those are `JsonValue` payloads owned by application code, and their keys are user data, not envelope fields. A validator that strips "unknown" keys from a payload object would corrupt the application's data; payload-shape constraints live under § Design invariants invariant 3 (`JsonValue` validation), not under this rule;
- is the forward-compatibility hinge that lets a future spec revision add an optional field (e.g. a new capability bit, a new diagnostic key) without breaking older peers — they keep parsing the known fields and silently drop the new one.

A receiver that rejects on unknown fields (or, equivalently, fails validation when an unknown key is present) is non-conformant. A receiver that *processes* an unknown field — assigning it semantic meaning, mutating state based on it, echoing it back into a different envelope — is also non-conformant: ignore means ignore.

#### Wire format versioning

The wire format does NOT carry its own `wireProtocol` / `wireVersion` discriminator. Three existing mechanisms together provide the same forward- and backward-compatibility guarantees a dedicated wire-version field would, without adding a new field every conformant envelope has to carry:

1. **Additive wire changes** (a new optional capability bit, a new optional metadata field on `sync` / `update` / `return` / `throw`, a new optional sibling on `error`) — covered by § Wire envelope unknown-fields rule above. A current consumer ignores the new field; a future producer sends it. No version negotiation is required.
2. **Capability bits** in `sync.capabilities` (`setAck`, `undefinedProperties`, `getterFailures`, and any successor) — the canonical way for a producer to advertise that it understands a specific extension. New optional behaviors that need consumer-side branching get a new capability bit rather than a version bump; the disambiguation rules in § Message types — server → client already cover the "capability absent vs. capability present + empty payload" distinction.
3. **Breaking wire changes** — handled by allocating a new top-level core `protocol` identifier per [SPEC.md § Versioning](SPEC.md#versioning). A wire-format break (e.g. changing the `type` discriminator's meaning, changing the semantics of `id`-bearing messages, dropping a previously-required field) is necessarily a breaking change to the core protocol the wire serializes — a consumer parsing a v1 declaration but receiving v2-shaped envelopes has no path back to consistency. The producer therefore advertises the new format by declaring a different `protocol` identifier (e.g. `"wc-bindable-2"`); a v1 consumer's discovery / fingerprint comparison rejects the producer at handshake time before the wire-format mismatch can cause silent corruption. The declaration's `protocol` field is propagated onto the wire indirectly via `declarationFingerprint` (the consumer compares its locally-computed fingerprint against the producer's), so the breaking-change signal reaches both sides on the first `sync` response.

Implementations MUST NOT introduce a wire-version field of their own (`wireProtocol`, `wireVersion`, `schemaVersion`, etc.) inside conformant envelopes — doing so would silently shadow this rule and let two implementations disagree on which discriminator is authoritative. Future spec revisions MAY add such a field if a breaking wire change ever needs it to coexist with the protocol-identifier mechanism above; until then, the absence of the field is the spec contract.

> **Why no `wireVersion` today?** A common review observation is that the wire envelope "lacks a wire version" and that adding one would harden against breaking wire changes. The reasoning above is why this spec deliberately does not. The `protocol` identifier already pins the meaning of every envelope shape — a future wire break gets a new identifier, not a version bump on the same one. Layering a second versioning axis on top of the existing one would create the ambiguity it is trying to prevent: which axis wins when they disagree?

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
{ "type": "throw",  "id": string, "error": { "name": string, "message": string, "code"?: string, "stack"?: string, "cause"?: JsonValue } }
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

- **"Rejected" in this table is a `Promise`-rejection state, NOT a synchronous throw.** Per [§ Methods](#methods), `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` MUST surface every protocol-level failure (validation, terminal failure, `setAck`-absent, timeout, abort, inbound JsonValue failure) as a rejected `Promise` — synchronously detected failures return an *already-rejected* `Promise` per [§ AckOptions](#ackoptions), they do NOT throw. Reading this table as "Rejected → caller sees a synchronous throw" is incorrect for the four ack-bearing call methods. Fire-and-forget `set` does not appear in this lifecycle precisely because it has no `Promise` and uses synchronous throws for the analogous failures (see § Methods, the `set` row).
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
- **Implementations MUST distinguish "the `value` key is absent" from "the `value` key is present and holds `undefined`" by checking key presence**, not by `msg.value === undefined`. The conformant primitive is `Object.hasOwn(msg, "value")` (or `Object.prototype.hasOwnProperty.call(msg, "value")` on older runtimes), applied to the parsed envelope object. The two checks are equivalent in practice on a wire that has just round-tripped through `JSON.parse` (JSON cannot emit `{"value": undefined}`, so `=== undefined` only fires on absence), but the equivalence is a property of the transport boundary's serialization step (§ Transport adapter contract invariant 2 — `JSON.stringify` on send, `JSON.parse` on receive), not of the wire shape itself. A future transport profile, an in-process test harness that hand-rolls envelopes, or a debugger that injects messages can all violate the equivalence; a `hasOwn`-based check stays correct regardless. The same rule applies symmetrically to the `return` envelope's `value` field (§ Return envelope value field).
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

#### Cache validity across transport lifecycle

The `has`-trap contract above governs the **steady-state** answer to "is `N` synced?" but does not on its own pin what happens to the proxy's per-property value cache (the storage behind both `proxy.<name>` reads and the `has`-trap "true" answer) as the proxy moves between the Active / TransientFailure / TerminalFailure / Reconnecting / Disposed states defined in § Remote proxy lifecycle. Without this rule, two conformant implementations could legitimately disagree on whether `proxy.value` reads `"old-known-value"` or `undefined` during a network blip — and adapter authors building UI on top would diverge on "show last-known value across reconnect" vs "show stale-state indicator", which is an ecosystem-level interop hazard the spec should not leave open.

**Normative rule.** A consumer-side proxy MUST treat the per-property cache as **last-known-value across the transport lifecycle**, with the per-state behavior pinned below. The rule applies to **declared `properties` names only** (consistent with § Consumer-side proxy `has` trap contract's "Scope: inputs and commands" exclusion):

| Proxy state | Cache contents | `N in proxy` for cached `N` | `proxy.<N>` read for cached `N` | `bind()` re-notification on entering state |
|---|---|---|---|---|
| **Active** (after first `sync`) | Per § Consumer-side sync-response handling: filled from `values` / `undefinedProperties`; updated by subsequent `update` envelopes | `true` for `N` in `values` or `undefinedProperties`; `false` for omitted `N` | The most recent value the producer has sent (or `undefined` for explicit-undefined names) | n/a (entry state) |
| **TransientFailure** (transport masking an outage via its own reconnect/backoff layer) | **Preserved as-is** — MUST NOT be cleared, reset, or marked stale at the protocol level | **Preserved as-is** — MUST NOT flip to `false` | **Preserved as-is** — returns the last-known value | None — entering TransientFailure does NOT re-fire `onUpdate` for any property |
| **TerminalFailure** (transport in terminal state per § Transport lifecycle vocabulary) | **Preserved as-is** until the proxy exits via Reconnecting or Disposed. The proxy MUST NOT clear or zero the cache on TerminalFailure entry — the cache is the consumer's only record of last-known producer state, and clearing it would force every adapter to re-render to an empty initial state on every connection blip | **Preserved as-is** | **Preserved as-is** — returns the last-known value | None |
| **Reconnecting** (`reconnect(transport)` called with a fresh transport) | **Still preserved** until the new `sync` response arrives. The proxy MUST NOT clear the cache *just because* a reconnect was initiated — clearing only happens as part of processing the new `sync` response per the rules below | **Preserved as-is** | **Preserved as-is** — returns the last-known value | None until `sync` arrives |
| **SyncProcessing** (new `sync` response received after Reconnecting) | **Diffed against the new snapshot**, per the rules in the next paragraph | Per the resulting cache | Per the resulting cache | Per the resulting cache (see "Re-sync re-notification" below) |
| **Disposed** | The proxy MUST release the cache as part of `dispose()` teardown; reading `proxy.<N>` after dispose is implementation-defined (typical: `undefined`), and `set` / `setWithAck` / `invoke` MUST throw / reject per § Lifecycle methods | Implementation-defined (typical: `false`) | Implementation-defined (typical: `undefined`) | n/a (terminal) |

**Diff rule on new `sync` arrival after reconnect.** The reference behavior is to treat the new `sync` snapshot as the new authoritative state, exactly as if this were the first sync — the new `values` / `undefinedProperties` / `getterFailures` replace the cache entry-by-entry per § Consumer-side sync-response handling. Specifically, for each declared property name `N`:

- `N` present in the new snapshot's `values[N]` → cache MUST be updated to that value; dispatch an initial-sync event regardless of whether the cached value was equal (no deduplication — see § Repeated Events for the Same Property in SPEC.md).
- `N` present in the new snapshot's `undefinedProperties` (capability bit `undefinedProperties: true`) → cache MUST be updated to `undefined`; dispatch an initial-sync event surfacing `value === undefined` per § CustomEvent `detail` and undefined preservation.
- `N` absent from the new snapshot's `values` AND `undefinedProperties` AND `getterFailures` → the producer no longer surfaces this property at all. The cache entry for `N` MUST be removed; the `has`-trap MUST flip back to `false`. The proxy SHOULD NOT dispatch any synthetic event for the removal (no `undefined` ghost-event, no removal notification). The protocol does not surface property *removal* as a `bind()` event because there is no producer-side change event to bridge from — synthesizing an `onUpdate(name, undefined)` would be observationally indistinguishable from a real `undefined` transition that the producer DID surface via `undefinedProperties`, breaking the consumer-side `undefined` cache state that legitimate transitions rely on. See the adapter-side guidance immediately below for the conformant detection pattern.
- `N` present in the new snapshot's `getterFailures` (capability bit `getterFailures: true`) → cache MUST be preserved per § `getterFailures` semantics (a getter failure is *property-level*, not a state assertion); the warning is logged but no event is dispatched and the cache is NOT touched.
- Legacy producer (capability `undefinedProperties` absent) → the revert-to-`undefined` heuristic of § Consumer-side sync-response handling step 2 applies: previously-cached names that vanished from `values` get `cache.set(name, undefined)` plus a dispatched undefined event. This is the same legacy behavior the first-sync path uses; the lossy interaction with getter failures called out in § Undefined enumeration's "Known lossy interaction" applies here too.

**Re-sync re-notification.** A successful re-sync delivers the *current* state, not a delta. Every name in the new `values` / `undefinedProperties` MUST fire an `onUpdate` event regardless of whether the value equals what the cache already held — `bind()` consumers receive a fresh "snapshot lap" of every observable property, which is the symmetry that lets them re-derive any framework-side observers (subscriptions, computed values, render outputs) without special-casing "first vs. subsequent" sync events. Consumers that need to suppress no-op re-renders SHOULD do so on their side per the existing § Repeated Events for the Same Property rule; the proxy MUST NOT do this on their behalf.

> **Adapter guidance — detecting removals across a re-sync (informative).** Because the proxy deliberately does NOT dispatch a synthetic event when a previously-cached property is dropped from the producer's new sync snapshot, an adapter that needs to surface the removal (e.g. a devtools panel, an inspector, or a UI that lists "currently observable properties") MUST detect it on its own. The conformant pattern is to snapshot the **`has`-set** (the set of declared property names for which `N in proxy === true`) immediately before processing each re-sync trigger and diff against the post-re-sync `has`-set:
>
> ```javascript
> // Before reconnect() (or before any expected re-sync arrival):
> const previousHas = new Set(
>   proxy.constructor.wcBindable.properties
>     .map((p) => p.name)
>     .filter((name) => name in proxy),
> );
>
> // ... reconnect or wait for the re-sync to land ...
>
> // After the new sync response has been processed (use the proxy's
> // implementation-specific "sync arrived" signal, or simply re-snapshot
> // after `setWithAck("__sync-marker__", ...)` resolves — any marker that
> // the adapter knows lands after sync-processing completes):
> const currentHas = new Set(
>   proxy.constructor.wcBindable.properties
>     .map((p) => p.name)
>     .filter((name) => name in proxy),
> );
> const removed = [...previousHas].filter((n) => !currentHas.has(n));
> const added   = [...currentHas].filter((n) => !previousHas.has(n));
> ```
>
> Equivalent forms (a `WeakMap` of has-sets keyed by sync generation, snapshotting the proxy's internal `_synced` set if the implementation exposes one, etc.) all satisfy the pattern — the load-bearing rule is **diff the has-sets across the re-sync boundary**. Adapters MUST NOT rely on `onUpdate(name, undefined)` to indicate a removal, because the protocol uses that signal exclusively for legitimate `undefined` transitions the producer DID surface (per [§ Undefined enumeration](#undefined-enumeration) and [§ Update envelope value field](#update-envelope-value-field)) — pattern-matching on it would conflate two distinct producer-side states (the value transitioned to `undefined` vs the property was dropped entirely) and lose information either way.
>
> **UI-pattern guidance (informative).** Adapter authors get two distinct signals from the rules above:
>
> - **"Show last-known value across reconnect" pattern.** This is the *default* — `proxy.<N>` keeps returning the last known value through TransientFailure / TerminalFailure / Reconnecting, so `useWcBindable` / `WcBindableController` / etc. naturally surface a frozen-but-non-empty view to the UI during outages. The proxy's lifecycle state itself is the orthogonal signal the adapter can read (or be notified of) to layer a "stale" indicator on top — e.g. tinting the value, showing a small "(reconnecting)" badge, or disabling controls that would invoke producer-side commands. The protocol does NOT prescribe how the adapter surfaces lifecycle to the framework; it just promises that the cached value will not silently change underneath.
> - **"Treat connection drop as stale-state" pattern.** Adapters that prefer to surface the outage as a value reset (e.g. dropping placeholders into the UI, clearing optimistic state, etc.) MUST do so by reading the proxy's lifecycle state and applying their own override on top of `proxy.<N>` — the proxy itself MUST NOT clear the cache. Otherwise the default-behavior adapters above would lose their last-known value too, and there is no upstream signal to recover it.
>
> Both patterns are conformant; they differ only in what the adapter does *with* the lifecycle state, not in what the proxy stores. The reference framework adapters in this repository follow the first pattern (last-known across reconnect) because that is what most React / Vue / Lit components want by default; consumers that need the second pattern build it explicitly.

#### Undeclared-name update handling

If the consumer-side proxy receives an `update` whose `name` is not in its local `properties` declaration (typically caused by a declaration-fingerprint mismatch where the producer exposes a property the consumer's local declaration does not know about), the consumer:

- MUST NOT throw or close the transport. The wire stays well-formed at the protocol level even if the application-level shape disagrees.
- MUST drop the `update` silently with respect to state — no event is dispatched to `bind()` consumers, no entry is written to the proxy's value cache.
- SHOULD log the drop at warn level naming the rejected `name`, so operators following up on a fingerprint-mismatch warning have a per-message trail.

This "liberal drop with warn" stance lets a partial-deploy or version-drift scenario continue working for the names both sides do agree on, while making the disagreement visible in logs. The reference `RemoteCoreProxy` implementation follows exactly this contract.

#### Consumer-side malformed message handling

The producer-side rules for malformed inbound messages live in § Design invariants invariant 3 → "Producer-side handling of malformed inbound messages". This subsection is the symmetric normative table for the consumer side — *what the consumer-side proxy MUST do when an inbound server-to-client envelope is well-typed-JSON but fails the required-key or required-shape rules for its `type` discriminator.* "Malformed" here means the envelope already parsed as JSON (otherwise the transport adapter's `JSON.parse` step in § Transport adapter contract invariant 2 would have raised and the proxy never sees the message) but is missing a required field, has a type-mismatched required field, or carries a payload that fails consumer-side `JsonValue` validation. Unknown sibling fields on a well-formed envelope are NOT malformed — they are governed by § Wire envelope unknown-fields rule and MUST be ignored.

The split between **"drop the message + warn"** and **"close the transport"** is deliberately narrow: only situations where the consumer can no longer reason about its own state machine reach the close path. Everything else degrades to per-message drop so a single garbled envelope does not knock out an otherwise-healthy connection.

| Inbound envelope shape | Trigger | Required consumer action |
|---|---|---|
| Malformed `sync` response (missing `values`, `values` is not a plain object, `undefinedProperties` is present but not a string array, `getterFailures` ditto, `capabilities` ditto, `declarationFingerprint` ditto) | Producer bug, transport corruption, or non-conforming peer | **Reject queued pending entries + close transport.** Without a valid `sync` response the proxy cannot leave PreSync (per § Remote proxy lifecycle), so the queue cannot drain. The proxy MUST settle every queued `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions` entry as Rejected (in caller order, per § Pre-sync call state machine) with a `WC_BINDABLE_PROTOCOL_ERROR`-coded synthetic error, MUST transition to TerminalFailure, and MUST signal the transport to dispose. SHOULD log the malformed shape at error level. This is the **one** consumer-side path where a single malformed message escalates to connection teardown — the alternative ("warn + wait for the next sync") never converges, because the producer is the only side that can send another sync. |
| Late or duplicate `sync` response after the proxy has already left PreSync (already in Active / TransientFailure / Reconnecting via a different transport / Disposed) | Producer bug — the spec mandates "at most one sync response outstanding per channel" (§ Message types — client → server) | **Drop silently, log at warn level.** Do NOT reprocess the snapshot, do NOT re-fire initial-sync events, do NOT touch the cache. Reprocessing would re-fire spurious "initial-sync" events for every declared property and corrupt downstream `bind()` consumer state. The reference contract is that the cache reflects the most recent committed sync — a late sync is simply not committed. |
| Malformed `update` (missing `name`, non-string `name`, present `value` that fails `JsonValue` validation) | Producer bug or transport corruption | **Drop the message + warn-log naming the field that failed.** Do NOT throw, do NOT close the transport, do NOT touch the cache. The consumer continues observing the last successfully-transmitted value (same posture as § Undeclared-name update handling). Connection liveness is independent of any single property's value-arrival. **Scope of the `JsonValue`-fail trigger.** "Fails `JsonValue` validation" here means **transport-shape validation** per [§ Design invariants invariant 3](#extension-2--wire-format-remote-proxying) — `Date`, `Map`, non-finite numbers, accessor properties, sparse holes, cycles, etc. — NOT application-level schema validation. Whether the payload's *meaning* matches an application-defined schema (e.g. "url MUST be an https URL", "count MUST be a non-negative integer") is **explicitly out of scope** for this rule and for the wire format generally (see the README "Non-goals" section, "Application-level schema enforcement"); an application-validated value that fails the consumer's domain rules is NOT a malformed envelope and MUST NOT be dropped here. Application-level validation happens at a layer above the proxy, on the value the consumer reads from `proxy.<name>` or receives via `bind()`. |
| `update` with a `name` not in the consumer's local `properties` declaration | Fingerprint mismatch (producer ships a property the consumer doesn't know about) | Already specified — see § Undeclared-name update handling. Drop + warn-log. |
| Malformed `return` (missing `id`, non-string `id`, present `value` that fails `JsonValue` validation) | Producer bug | If `id` is well-formed AND matches a pending entry: **reject the pending entry** with a `WC_BINDABLE_PROTOCOL_ERROR`-coded synthetic error, remove from `id → pending`, warn-log. If `id` is missing / malformed OR matches no pending entry: **drop + warn-log** (late-envelope drop per § AckOptions). Do NOT close the transport — `return` is per-call; the rest of the connection is unaffected. |
| Malformed `throw` (missing `id`, non-string `id`, missing `error`, `error` is not an object, `error.name` or `error.message` is not a string) | Producer bug — non-conforming canonicalization | Same routing as malformed `return`: if `id` matches a pending entry, **reject it** with a `WC_BINDABLE_PROTOCOL_ERROR`-coded synthetic error built locally (the consumer cannot trust the partial `error` object to be safely surfaced); otherwise drop + warn-log. The synthesized local error SHOULD carry whatever portions of `error.name` / `error.message` / `error.code` were well-formed in the inbound payload (best-effort diagnostics), but the proxy MUST NOT pass through a partially-valid `error` object as-is — the `Error`-instance contract from § Error envelope rests on `name` / `message` being strings. |
| `throw` whose `error` is structurally well-formed but whose `error.cause` fails `JsonValue` validation | Producer-side `cause` canonicalization bug | **Reject the pending entry** with the rest of the `error` (`name` / `message` / `code` / `stack` if valid) plus a warn-log noting that `cause` was dropped. Do NOT close the transport. `error.cause` is OPTIONAL on the wire (see § Error envelope), so dropping it preserves a valid Error-instance for the caller. |
| Envelope whose `type` discriminator is unrecognized | Forward-compatible additive change in a future spec revision (NOT in this one), OR producer bug | **Drop + warn-log.** This is *not* covered by the unknown-fields rule (which governs sibling fields, not new envelope shapes), but the same forward-compatibility posture applies — a future spec revision may add a new `type`, and a current consumer that closes the transport on it would refuse to interoperate with conforming future producers. |
| Inbound envelope with unknown sibling fields on the envelope or on a schema-owned nested metadata object (`error`, `capabilities`, `declarationFingerprint`) | Forward-compatible additive change | Already specified — see § Wire envelope unknown-fields rule. MUST ignore the unknown fields after validating the known ones; this is NOT malformed. |
| Inbound envelope where the underlying transport adapter delivered a non-JSON-parseable payload (string that fails `JSON.parse`, binary frame, etc.) | Transport adapter bug — the boundary `JSON.parse` step (§ Transport adapter contract invariant 2) MUST run *before* the proxy sees the message | The transport's `JSON.parse` failure raises before reaching the proxy. If a transport implementation hands the proxy a non-object (e.g. a raw string, `null`, an array): proxy MUST treat it as malformed-envelope, drop + warn-log naming the transport-side bug; if such breakage is observed repeatedly the proxy MAY transition to TerminalFailure with a `WC_BINDABLE_PROTOCOL_ERROR` reason, but is not required to. The "MAY" exists because some transport adapters deliberately interleave non-protocol frames (debug/heartbeat) that they should have filtered themselves; rejecting on the first occurrence is too aggressive. |

**The "close transport" path is reserved.** Outside the malformed-`sync` row above, no single malformed inbound envelope causes the consumer-side proxy to tear down the connection. The model: the wire is well-formed at the JSON level (the transport's `JSON.parse` is the protocol-level circuit breaker for that), and any further malformed envelope is application-level garbage that the proxy degrades gracefully against. This minimizes blast radius — a single buggy `update` does not orphan every pending `setWithAck`.

**Warn-log content.** The recommended log shape for every drop-and-warn row above is `proxy received malformed <type> envelope: <reason>` plus the offending `id` / `name` if available. Implementations MAY use any equivalent format. Suppressing or rate-limiting the logs is permitted only when the implementation documents its policy in its public API surface (typical pattern: log the first N occurrences per envelope-shape-per-transport-lifetime, then summarize).

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

**Strict-mode opt-in.** Implementations MAY offer a strict fingerprint mode (typical surface: a `strictFingerprint: true` option on `createRemoteCoreProxy`) that escalates a mismatch from warn-log into a **terminal protocol error** — the proxy transitions to TerminalFailure (per § Remote proxy lifecycle), every pending entry rejects with a `WC_BINDABLE_PROTOCOL_ERROR`-coded throw envelope shape (locally constructed; no wire message is emitted), and subsequent `set` / `setWithAck` / `invoke` calls fail per the TerminalFailure rules. This is appropriate for deployments where consumer and producer ship from the same versioned package and any drift is a deployment bug rather than expected partial-deploy state. The default behavior remains warn-then-continue; strict mode is opt-in, MUST be documented in the implementation's public API surface, and MUST NOT be the default — a default-strict implementation would refuse to interoperate with legacy producers that omit the field, violating the existing "treat absence as no fingerprint comparison available" legacy fallback.

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

**Normative minimum.** The following names are reserved by this specification. Every conformant Extension 2 implementation MUST reject any declared `properties` / `inputs` / `commands` `name` that matches any rule below, at proxy construction time (consumer-side) and at shell construction time (producer-side), and MUST NOT generate wire traffic for such a name. This is the cross-implementation portion of the reserved-name rule — pinning the list makes a single conformance vector test for it across every implementation, regardless of which other names that implementation also reserves.

1. **Wire-namespace prefix.** Any `name` that begins with the literal string `@wc-bindable/`. This prefix is used by the synthetic per-property event names the consumer-side proxy generates, the wire envelope `type` discriminator, and other internal identifiers; allowing a declared name to shadow them would silently corrupt wire-level dispatch.
2. **Prototype-pollution-prone names.** The exact strings `"__proto__"`, `"constructor"`, and `"prototype"`. These are reserved at the same construction-time gate because the consumer-side proxy materializes per-property caches and rewrites declared property names onto its `proxy.<name>` surface — any implementation that uses `Object.assign`, spread, or naive `cache[name] = value` writes against an ordinary `{}` will pollute the host object's prototype chain if a producer-declared property's name matches one of these. Rejecting the three names at construction time gives every conformant implementation the same defense without forcing every cache-write site to remember to use `Object.create(null)` or a `Map`. Implementations MAY *additionally* use null-prototype containers internally; the reservation is the simpler, single-checkpoint mitigation that interop tests can verify uniformly.

**Scope of the prototype-pollution reservation.** Rule 2 above governs **declaration names** (entries of `properties` / `inputs` / `commands`) and, by extension, the keys of name-keyed *protocol* maps whose keys correspond to declared names — most importantly `sync.values` (whose own enumerable keys are exactly the declared `properties` names that survived rule 2 at construction time). It does **NOT** govern arbitrary application payload objects carried inside `update.value`, `return.value`, `set.value`, or `cmd.args[i]`. Those payloads are `JsonValue`-shape user data per § Design invariants invariant 3, and the existing object-shape requirements there (plain-object prototype check, data-descriptor check, dense-array rule, etc.) are the complete validator; they do NOT add a per-key reserved-name filter, by design. A user-supplied JSON value of the form `{ "constructor": "ChevroletImpala" }` inside an `update.value` payload is a perfectly conformant `JsonValue` and MUST be transmitted faithfully. Implementations that materialize such payloads into host objects MUST do so via null-prototype objects (`Object.create(null)`), `Map`, or another container that does not interpret the key as a prototype chain access — pushing the safety responsibility into the implementation's cache-write site rather than the wire-format namespace.

The Wire envelope unknown-fields rule already draws this same envelope-vs-payload boundary (see [§ Wire envelope unknown-fields rule](#wire-envelope-unknown-fields-rule) — "This rule does **NOT** apply to application payload objects carried in `values`, `update.value`, …"). The prototype-pollution reservation lines up on the same boundary for the same reason: protocol-owned name spaces (declaration, fingerprint, envelope discriminator, name-keyed protocol maps) are spec-pinned; application payload key spaces are not.

**Implementation-defined extensions.** Implementations MAY reserve additional declaration names beyond the normative minimum (vendor-prefixed namespaces, debugging-tool names, etc.). Such additions MUST be documented in the implementation's public API surface so consumers know which extra names are forbidden in their declarations. The reference implementation `@wc-bindable/remote` reserves exactly the normative minimum: the `@wc-bindable/` prefix and the exact strings `"__proto__"`, `"constructor"`, and `"prototype"`.

The reservation is a safety net so a typo or hostile declaration cannot silently shadow protocol-level messages or pollute the consumer-side proxy's host object. Reserved-name rejection happens at construction time, never at message-send time, so a passing-construction declaration is guaranteed to be reservation-clean for the lifetime of the proxy / shell.

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
7. **At-most-once delivery (no duplicate frames).** Each accepted `send(message)` MUST be delivered to the peer's `onMessage` **at most once**. WebSocket and `MessagePort` satisfy this natively (each `WebSocket.send` / `port.postMessage` produces exactly one frame on the wire, and the receiver fires `message` exactly once per frame). Transports whose underlying medium MAY duplicate frames (some pub/sub buses, hypothetical UDP-style transports, transports that retry idempotently at a lower layer) are **not conformant by themselves**; an adapter built on such a medium MUST either (a) de-duplicate frames at the adapter boundary before invoking `onMessage`, or (b) treat any observed duplication as a terminal transport failure (fire `onClose` and stop accepting traffic). Silent duplicate delivery is the most dangerous mode the spec defends against: fire-and-forget `set` (no `id`, at-most-once by design — see § Methods) has no application-layer deduplication mechanism, so a duplicated `set("count", n+1)` against a non-idempotent setter applies twice with no detectable signal at either end. The id-bearing call methods (`setWithAck` / `invoke`) tolerate adapter-level duplication only when the proxy's `id → pending` table happens to settle the duplicate as a late-envelope drop (§ AckOptions) — that is incidental, not a design guarantee, and the adapter MUST NOT rely on it.

   **De-duplication metadata is transport-private.** Any sequence number, nonce, or other token the adapter uses for de-duplication path (a) **MUST live outside the wc-bindable protocol envelope** — typically as a sibling field on the adapter's own framing layer, or as an opaque header the underlying medium carries separately from the JSON payload. The adapter **MUST strip such metadata before invoking `onMessage`**, so the proxy / shell receives exactly the protocol envelope produced by the peer's `send()` (per invariant 6's "1:1 mapping between `send()` and `onMessage`" rule and the "transport MUST NOT rewrite message fields" rule). Embedding a sequence number as an extra top-level key on the wc-bindable envelope itself is non-conformant: it would survive into `onMessage`, the unknown-fields rule (§ Wire envelope unknown-fields rule) would oblige the peer to ignore it for envelope-semantics purposes, but the field would still occupy the same namespace future spec revisions reserve for additive envelope changes — a future spec field could accidentally collide with an in-use adapter-private key. Keeping the de-dup metadata in a layer the adapter owns end-to-end avoids the collision and keeps invariant 6's surface clean.

Transport-specific concerns *outside* the normative contract — back-pressure caps, logger injection, framework-integration examples, the concrete WebSocket / `BroadcastChannel` / `MessagePort` / `Worker` implementations bundled with `@wc-bindable/remote` — are documented in [packages/remote/README.md](packages/remote/README.md). That document is operational guidance, not normative; this section is the spec a third-party transport must satisfy to interoperate with any conformant proxy/shell.

### Failure & recovery quick reference

The failure-handling rules in this spec are individually authoritative in the sections they live in, but they span both core (SPEC.md) and extensions (this document), and a frequent review observation is that "what is the right recovery for failure X" requires reading four or five separate sections. The two tables below are a **non-normative cross-cutting summary** — the linked sections are authoritative — so implementers and consumers can locate the right answer in one place. Use the first table to find the failure surface; use the second table to decide whether and how to retry.

> **This table intentionally repeats normative keywords (MUST / SHOULD / MUST NOT) from the referenced sections for searchability; it does NOT create independent requirements.** Each row is an *index entry* pointing into the authoritative section in the rightmost column — if a future spec revision changes a rule, the change happens in that section and this table is updated to match, never the other way around. When a row's wording and the linked section diverge (a documentation bug), the linked section wins, and the row should be filed as a discrepancy against this document rather than read as a parallel normative source. This applies to both the failure-and-recovery table immediately below and the retry-guidance table further down.

The `set` row of both tables is the most-confused surface in the spec, because `set()` mixes synchronous-throw paths (programmer errors, validation failures, terminal transport) with silent-drop paths (transient outages) under one method name. Both tables call this out explicitly so the misuse pattern (`set(); invoke();` over a flaky link, expecting the caller to learn about the dropped `set`) is visible at-a-glance.

#### Failure-and-recovery table

For every protocol-level failure mode this spec defines, the table lists where it surfaces, what shape it takes (sync throw, Promise rejection, silent drop, uncaught error on the event loop), and what the consumer's recovery path is. Authoritative sections are linked in the rightmost column.

| Surface | Failure mode | How it manifests | Recovery path | Authoritative section |
|---|---|---|---|---|
| `getWcBindableDeclaration(target)` | Target not bindable (null, schema-invalid, hostile accessor) | Returns `undefined`. Never throws. | Caller treats `undefined` as no-op (no bind possible). | [SPEC.md § Discovery API](SPEC.md#discovery-api) |
| `bind()` install-time throw | `addEventListener` throws on Nth iteration, getter throws during initial sync, `onUpdate` throws during initial sync, MutationObserver setup throws | Synchronous throw. **All installed cleanups are run before the rethrow** (caller never receives the unbind, but listener set does not leak). | Caller catches in the same frame as the `bind()` call. | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) |
| `bind()` deferred initial sync (`syncOn: "connect"`) throw | A getter throws or `onUpdate` throws inside the MutationObserver microtask | Uncaught error on the dispatching microtask (browsers: `window.onerror` / `reportError`; Node: `process.on('uncaughtException')`). Installed cleanups run; the unbind the caller already received is a no-op thereafter. | **Cannot be caught synchronously.** Consumers needing structured error handling MUST use `syncOn: "call"` from inside a lifecycle hook. | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract), [§ Deferring](SPEC.md#deferring-the-initial-sync-until-connection) |
| `bind()` `onUpdate` throw on a post-initial-sync event | Consumer-side bug surfaces during a normal change event | Error propagates via the standard DOM event-dispatch path (uncaught on the event-loop turn). **Listener stays attached; subsequent events keep firing.** | Consumer that wants fail-fast teardown calls `unbind()` from a `try/catch` inside its own `onUpdate`. | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) |
| `bind()` cleanup callback throw (consumer-invoked unbind) | A hostile `Proxy` target's `removeEventListener` or `observer.disconnect()` throws | Adapter swallows the secondary error and continues with remaining cleanups. The first secondary error is NOT surfaced (teardown is best-effort, not error-reporting). | None at the consumer side — secondary errors are deliberately discarded. | [SPEC.md § Teardown Contract](SPEC.md#teardown-contract) |
| `set(name, value)` — undeclared input | `name` not in `inputs` on the consumer-side declaration | **Synchronous throw** at the `set()` call site. | Caller fixes the declaration mismatch (no retry path). | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (set row) |
| `set(name, value)` — invalid `JsonValue` | `value` fails consumer-side `JsonValue` deep validation | **Synchronous throw** at the `set()` call site. **Both this and the undeclared-input check MUST happen at the call site even when the queueing profile is in use** — `set()` returns `void`, so a deferred validation would silently swallow the bug. | Caller encodes the value as `JsonValue` (no retry path). | [SPEC-extensions.md § Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) (final set bullet) |
| `set(name, value)` — proxy disposed or transport terminal | `dispose()` already called OR transport in TerminalFailure at call time | **Synchronous throw** at the `set()` call site. | Caller stops calling on this proxy; constructs a new one (or `reconnect()` if implemented and the proxy is not yet disposed). | [SPEC-extensions.md § Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) |
| `set(name, value)` — transient transport outage | Transport's own reconnect/backoff layer is masking a blip; transport is NOT in TerminalFailure | **Silent drop possible** — the message either lands eventually (at-most-once) or is silently lost; `set()` does NOT throw. **This is the gap `setWithAck` exists to make detectable.** | Caller MUST use `setWithAck` instead if the `set` is a precondition for a later call. `set` is appropriate only for telemetry / UI hints / best-effort updates whose loss is tolerable. | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) (set row), [§ Transport lifecycle vocabulary](SPEC-extensions.md#transport-lifecycle-vocabulary-shared-by-extensions-1-and-2) |
| `setWithAck` / `invoke` — programmer error | `name` is not a string, proxy receiver is not bound | Synchronous throw permitted (rare; outside the protocol surface). | Fix call site. | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) |
| `setWithAck` / `invoke` — undeclared name | `name` not in `inputs` / `commands` on the consumer-side declaration | **Returned `Promise` rejects** with `WC_BINDABLE_UNDECLARED_INPUT` / `WC_BINDABLE_UNDECLARED_COMMAND`. | Caller fixes declaration mismatch (no retry path). | [SPEC-extensions.md § Methods](SPEC-extensions.md#methods) |
| `setWithAck` / `invoke` — invalid `JsonValue` | `value` / any of `args` fails consumer-side validation | **Returned `Promise` rejects locally** (no wire message sent) with `WC_BINDABLE_INVALID_JSON_VALUE`. | Caller encodes the value as `JsonValue` (no retry path). | [SPEC-extensions.md § Design invariants invariant 3](SPEC-extensions.md#extension-2--wire-format-remote-proxying) (consumer-side validation) |
| `setWithAck` / `invoke` — pre-aborted signal | `AckOptions.signal.aborted === true` at call time | Returned `Promise` rejects immediately with `WC_BINDABLE_ABORTED`. **No wire message is sent.** | Caller decides whether to re-issue with a fresh signal. | [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) |
| `setWithAck` / `invoke` — timeout | `AckOptions.timeoutMs` elapses before the producer's `return` / `throw` arrives | Returned `Promise` rejects with `WC_BINDABLE_TIMEOUT`. **No wire-level cancellation is sent**; producer keeps running and a late `return` / `throw` for the same `id` is dropped. | See retry table below — execution status is unknown. | [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) |
| `setWithAck` / `invoke` — local abort | `AckOptions.signal` fires after send | Returned `Promise` rejects with `WC_BINDABLE_ABORTED` (or the signal's `reason`). Same wire posture as timeout — producer continues, late envelope dropped. | See retry table below. | [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions) |
| `setWithAck` / `invoke` — terminal transport failure | Transport in TerminalFailure (or transitions there while pending) | Returned `Promise` rejects with a terminal-failure error coded `WC_BINDABLE_TERMINAL_FAILURE`. Every pending entry drains in caller order. | Application reconnects (if `reconnect()` is implemented and proxy not disposed) or constructs a new proxy; re-issues are application-level decisions, NOT automatic. | [SPEC-extensions.md § Remote proxy lifecycle](SPEC-extensions.md#remote-proxy-lifecycle), [§ Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) |
| `setWithAck` / `invoke` / `set` — proxy disposed | `dispose()` called (or pending entry alive when `dispose()` runs) | `setWithAck` / `invoke` reject with `WC_BINDABLE_DISPOSED`; `set()` throws synchronously with the same code. Pending entries drain in caller order. | Construct a new proxy. A disposed proxy is, by contract, never reusable — `reconnect()` MUST throw if the proxy is disposed. | [SPEC-extensions.md § Lifecycle methods](SPEC-extensions.md#lifecycle-methods), [§ Pending-call lifecycle](SPEC-extensions.md#pending-call-lifecycle-setwithack--setwithackoptions--invoke--invokewithoptions) |
| `setWithAck` against legacy producer | `capabilities.setAck` absent or `false` on the sync response | Returned `Promise` rejects (synchronously already-rejected for calls issued after sync; the pre-sync queue replay rejects queued entries in caller order). | Caller falls back to fire-and-forget `set` (accepting the at-most-once gap) or refuses to talk to legacy peers. | [SPEC-extensions.md § sync response capabilities](SPEC-extensions.md#message-types--server--client), [§ Pre-sync call state machine](SPEC-extensions.md#pre-sync-call-state-machine) |
| `setWithAck` — duplicate pending `id` allocated by the proxy | Hand-rolled allocator collision in the consumer-side proxy's `id → pending` table | Proxy MUST regenerate (or treat as programmer error). UUID v4 trivially satisfies the constraint. | Fix allocator; switch to UUID v4. | [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id constraints) |
| `setWithAck` — duplicate pending `id` observed by producer | A consumer mis-sends two messages with the same `id` before the first settles | Producer logs + drops the later message OR transitions to TerminalFailure with `WC_BINDABLE_DUPLICATE_ID`; the later consumer-side call eventually settles via its AckOptions timeout. | Fix consumer-side `id` allocator. | [SPEC-extensions.md § Message types — client → server](SPEC-extensions.md#message-types--client--server) (id duplicate constraint) |
| `invoke` — producer throws an application error | `target[command](...)` throws inside the producer's command implementation | Consumer's `Promise` rejects with a JS `Error` instance carrying the producer's `name` / `message` / (optional) `code` / `stack` / `cause`. Code is typically `WC_BINDABLE_REMOTE_THROW` or an application-namespaced code. | Application decides per its own error policy. | [SPEC-extensions.md § Error envelope](SPEC-extensions.md#error-envelope) |
| Consumer receives malformed `sync` | Producer bug, transport corruption, non-conforming peer | Proxy rejects every queued pending entry with `WC_BINDABLE_PROTOCOL_ERROR` (in caller order), transitions to TerminalFailure, signals the transport to dispose. **This is the only consumer-side single-message-causes-teardown path.** | Reconnect or reconstruct. | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| Consumer receives malformed `update` | Missing `name`, present `value` fails `JsonValue`, etc. | **Drop the message + warn-log.** Connection liveness unaffected. The consumer continues observing the last successfully-transmitted value. | None required; wait for the next valid `update`. | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| Consumer receives late / duplicate `sync` after Active | Producer bug (spec mandates at-most-one outstanding sync per channel) | **Drop silently + warn-log.** Do NOT reprocess; cache reflects the most recent committed sync only. | None required. | [SPEC-extensions.md § Consumer-side malformed message handling](SPEC-extensions.md#consumer-side-malformed-message-handling) |
| Consumer receives `return` / `throw` for unknown `id` | Late envelope arriving after the consumer-side pending entry already terminated (timeout / abort / transport terminal); producer bug; consumer bug | **Drop silently + warn-log.** Consumer `Promise` was already settled; re-settling would corrupt user-level error-handling logic. | None required. | [SPEC-extensions.md § AckOptions](SPEC-extensions.md#ackoptions), [§ Pending-call lifecycle](SPEC-extensions.md#pending-call-lifecycle-setwithack--setwithackoptions--invoke--invokewithoptions) |
| Consumer receives `update` for undeclared `name` | Declaration-fingerprint mismatch — producer exposes a property the consumer's local declaration doesn't know about | **Drop the message + warn-log.** Do NOT throw, do NOT close transport, do NOT write the cache. | Fix declaration drift if it persists; the bind for properties both sides agree on continues working. | [SPEC-extensions.md § Undeclared-name update handling](SPEC-extensions.md#undeclared-name-update-handling) |

The `set` row's bifurcation between **sync throw** (declared-but-validation-fails / terminal) and **silent drop** (transient) is the surface the spec defends against most carefully — it is why every other place in the spec recommends `setWithAck` whenever a later `invoke` depends on the prior assignment.

#### Retry guidance

Retry is **caller responsibility** in this protocol — the proxy never retries on its own, because re-sending could re-apply a non-idempotent input or command without the consumer's knowledge. This table classifies whether each failure mode is *retry-safe* and why; like the table above, it is non-normative and exists to keep the recovery decision in one place.

| Failure | Retry safe? | Why / how |
|---|---|---|
| Undeclared `name` (`WC_BINDABLE_UNDECLARED_INPUT` / `WC_BINDABLE_UNDECLARED_COMMAND`) | **No.** | The declaration mismatch will not heal on its own. Fix the consumer-side declaration (typically by reconstructing the proxy against a fresh `wcBindable` snapshot) or the producer-side declaration. |
| Reserved name (`WC_BINDABLE_RESERVED_NAME`) | **No.** | Construction-time validation should have caught this; if it didn't, the consumer or producer is non-conforming. Fix the offending side. |
| Invalid `JsonValue` (`WC_BINDABLE_INVALID_JSON_VALUE` / `WC_BINDABLE_INVALID_RETURN_VALUE`) | **No.** | Re-sending the same payload reproduces the failure. Encode `Date` / `Map` / `Set` / `BigInt` / class instances / cycles into a JSON-shape representation at the application boundary before retrying. |
| Timeout (`WC_BINDABLE_TIMEOUT`) | **Conditional — execution status is unknown.** | The producer MAY have completed (and the reply was lost), MAY still be running, or MAY have failed before observing the message. A blind retry can therefore double-apply a non-idempotent input or command. Safe to retry only when (a) the call is naturally idempotent, OR (b) the application provides an idempotency key the producer respects and de-duplicates against. Without one of those, prefer to surface the timeout to the user / upstream caller rather than retry. |
| Local abort (`WC_BINDABLE_ABORTED`) | **Conditional — same reason as timeout.** | The local cancellation does NOT cancel the producer; the producer continues processing the corresponding call. Re-issuing is the same idempotency-key question as timeout. |
| Terminal transport failure (`WC_BINDABLE_TERMINAL_FAILURE` from TerminalFailure drain) | **At the call layer: no automatic retry.** | Once the transport is terminal, the consumer-side proxy rejects every pending entry. Recovery is **application-level**: reconnect (via `reconnect()` if implemented, otherwise construct a new proxy) and decide per-call whether re-issuing is safe (same idempotency question as timeout above). The spec deliberately does NOT auto-replay the pending queue against a new transport, because the consumer cannot tell which entries already reached the producer over the dying transport. |
| Proxy disposed (`WC_BINDABLE_DISPOSED`) | **No — the proxy is not reusable.** | `dispose()` is the consumer's intentional teardown signal. Pending entries reject in caller order with `WC_BINDABLE_DISPOSED`; subsequent calls reject (or throw, for `set()`) with the same code. The only conformant recovery is to construct a new proxy — `reconnect()` MUST throw on a disposed proxy. Differs from terminal-failure recovery, which keeps the proxy alive for `reconnect()` if the implementation supports it. |
| Malformed `sync` ⇒ TerminalFailure (drain code: `WC_BINDABLE_PROTOCOL_ERROR` on the per-pending rejection; transport then goes terminal) | **Same as terminal transport failure.** | Application reconstructs / reconnects. The per-pending code stays `WC_BINDABLE_PROTOCOL_ERROR` (because the trigger was a wire-shape violation, not a normal outage), but the lifecycle exit is the same TerminalFailure → Reconnecting / Disposed path. |
| Producer application throw (`WC_BINDABLE_REMOTE_THROW` or no `code`) | **Treat as application error.** | The producer's command / setter failed for application reasons (validation, business logic, downstream failure). Whether to retry is an application policy decision — the protocol layer expresses no opinion. Inspect `error.code` / `error.message` / `error.cause` to decide. |
| Other `WC_BINDABLE_PROTOCOL_ERROR` (not from TerminalFailure drain) | **No.** | Protocol-level wire bugs (malformed envelopes, unexpected wire state) indicate a producer / consumer / transport version mismatch or implementation bug. Retrying reproduces the failure. Investigate the implementation, declaration fingerprint, or transport adapter. |
| `setWithAck` against legacy producer | **No.** | The producer cannot satisfy the acknowledged-assignment contract regardless of how often the call is reissued. The consumer's options are (a) fall back to fire-and-forget `set` and accept the at-most-once gap, or (b) refuse to interoperate with legacy peers. |
| Fire-and-forget `set` silent drop on transient outage | **No, not at this layer.** | `set` has no signal that the message was dropped — the consumer has nothing to retry against. The contract is at-most-once. Consumers that need the message to survive a transient outage MUST use `setWithAck`, which DOES surface the failure and lets the caller make an informed retry decision (subject to the same idempotency rules above). |

> **Idempotency key pattern.** The protocol does not define an idempotency-key convention because it is application-specific. The canonical shape is: the caller generates a unique per-logical-request token (UUID, monotonic counter scoped to the input), passes it as part of the input payload or command argument, and the producer-side handler de-duplicates by checking the token against a persistent or in-memory recent-token set before applying the side effect. This composes with `setWithAck` / `invoke` retries without protocol changes; the spec's role is to be transparent about *when* a retry could double-apply (the table above), not to prescribe the de-duplication mechanism.

### Conformance summary

A wire-format implementation conforms to this extension when:

> Half of these rules have runnable starter vectors in [CONFORMANCE.md](CONFORMANCE.md). At minimum, an Extension 2 implementation should pass vectors **5, 6, 7, 9, 10, 15, 20, 21, 22, 23, 24, 25, and 26** (the `has`-trap pre-sync rule, the `update`-with-no-`value` undefined preservation, `JsonValue` validation, `setWithAck` ordering, the legacy-`setAck` rejection path, the `@wc-bindable/` reserved-prefix rule, the prototype-pollution reserved-names rule, duplicate-pending-`id` rejection, empty-string-`id` rejection, the malformed-`sync` ⇒ terminal rule, malformed-`return` / `throw` per-entry handling, `update.value` absence via key-presence, and transport at-most-once delivery), plus any core vectors that apply to the local bind surface it exposes — see CONFORMANCE.md's "Applies to" column for the per-vector scoping. Pass the applicable subset before claiming Extension 2 conformance; the file is necessary, not sufficient.

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
