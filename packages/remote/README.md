# @wc-bindable/remote

Remote proxy for the **wc-bindable** protocol — connect Core and Shell over a network.

Splits the HAWC Core/Shell boundary across a network using WebSocket. The server runs the real Core; the client gets a proxy EventTarget that works transparently with `bind()` and framework adapters.

## Install

```bash
npm install @wc-bindable/remote
```

## Architecture

```
Client (Browser)                        Server (Node / Deno / etc.)
┌──────────────────────┐  WebSocket   ┌──────────────────────┐
│  RemoteCoreProxy     │◄────────────►│  RemoteShellProxy    │
│  (EventTarget)       │              │                      │
│                      │              │  Core (EventTarget)  │
│  bind() just works   │              │  Business logic here │
└──────────────────────┘              └──────────────────────┘

  { type: "sync" }     ──────────►  Read current values
                       ◄──────────  { type: "sync", values: { ... } }
  set("url", "/api")  ──────────►  core.url = "/api"
  invoke("fetch")     ──────────►  core.fetch()
                      ◄──────────  update: loading = true
                      ◄──────────  update: value  = { ... }
```

## Security model / trust boundary

**This package does not provide transport security, authentication, or authorization.** `RemoteCoreProxy` and `RemoteShellProxy` are a protocol layer, not a security boundary. Treat the Core as sitting inside a trust boundary that the operator controls, and enforce anything stronger in the layer that owns the transport.

What this package **does not** provide:

- **Transport security** — TLS termination, origin checks, cookie/token verification, mTLS. Provide these at the WebSocket server (`wss://`, reverse proxy, Node `ws` `verifyClient` hook, etc.) before handing the socket to `WebSocketServerTransport`.
- **Authentication** — there is no concept of "which client is connected". `WebSocketServerTransport` forwards whatever messages arrive.
- **Authorization** — once a transport is wired to `RemoteShellProxy`, the connected peer can call `set()` on any declared `input` and `invoke()` any declared `command`, with any JSON-serializable payload. The server validates message **shape** and declared-name membership, but it does not gate by identity, role, or per-message policy.
- **Per-client rate limiting or connection quotas** — see back-pressure below for the memory-safety guardrails this package does offer; anything beyond that (admission control, connection caps, fair-share scheduling) belongs upstream.
- **Payload validation beyond declaration** — command arguments are forwarded to the Core as-is once they pass JSON deserialization and name validation. Per-command argument schemas are the Core's responsibility.

Attack surface that follows from exposing a `RemoteShellProxy` to an arbitrary peer:

- The peer can drive any declared `input` to any JSON value the Core's setter accepts (including values the local UI would never produce).
- The peer can invoke any declared `command` with arbitrary args and observe the `return`/`throw` envelope, including at least `name`, `message`, and `stack` of thrown `Error` values unless the Core sanitizes its errors.
- The peer can issue unbounded `setWithAck` / `invoke` calls — use `maxPendingInvocations` (see Back-pressure) to bound in-flight state on the client, and add admission control on the server.
- The peer can issue repeated `sync` requests to force full snapshot builds. If a getter is expensive, enforce rate limits at the transport layer.

Recommended practices when a peer is untrusted or semi-trusted:

1. Authenticate the WebSocket connection (session cookie, signed token, mTLS) at the server, and reject the handshake before instantiating `WebSocketServerTransport`.
2. Wrap `RemoteShellProxy` behind a `ServerTransport` adapter that inspects each incoming `ClientMessage` and filters by identity/role (e.g. allow-list of `input.name`s and `command.name`s per connection). The transport interface is intentionally small to make such wrapping straightforward.
3. Do not expose a Core whose commands have operator-level side effects (deleting records, mutating other users' state) without per-message authorization in that adapter.
4. Pair the back-pressure options (`maxPendingInvocations`, `maxPreOpenQueue`, `maxSyncUpdateBuffer`) with upstream rate limiting; soft caps make misbehavior detectable, not impossible.
5. Sanitize thrown errors on the server side if stack traces or internal messages should not cross the wire — serialization happens after the throw, not before.

If these guarantees are not acceptable, the Core should sit behind an additional service that owns the trust boundary.

## Connection lifecycle

1. The server creates a `RemoteShellProxy`, which subscribes to the Core's declared events and starts forwarding updates.
2. The client creates a `RemoteCoreProxy`, which immediately sends a `sync` request.
3. The server responds with the Core's current property values.
  Properties whose current value is `undefined` are omitted from `values` (matching local `bind()` initial synchronization) but are enumerated in the `undefinedProperties` field when at least one such property exists. Clients that read this field can disambiguate "currently `undefined`" from "not transmitted" and dispatch an explicit reset event even on the very first `sync`. Older servers that omit the field continue to work: clients fall back to the legacy convention that treats any omitted-but-previously-cached property as reverted to `undefined` on re-sync.
4. The client populates its cache and dispatches events for each value — `bind()` on the client side picks these up as if they were normal state changes.
5. From this point, all Core events are forwarded in real time.

```
Client                              Server
  │                                   │  RemoteShellProxy created
  │                                   │  subscribes to declared Core events
  │  RemoteCoreProxy created          │
  │── { type: "sync" } ─────────────► │
  │                                   │  Read core.value, core.loading, ...
  │  ◄── { type: "sync",          ── │
  │        values: {                  │
  │          value: null,             │
  │          loading: false,          │
  │          error: null,             │
  │          status: 0                │
  │        }                          │
  │      }                            │
  │  Cache updated + events fired     │
  │  bind() delivers initial state    │
  │                                   │
  │── { type: "set", "url", "/api" }► │  core.url = "/api"
  │── { type: "cmd", "fetch", … } ──► │  core.fetch()
  │                                   │
  │  ◄── { type: "update",        ── │  core dispatches loading-changed
  │        name: "loading",           │
  │        value: true }              │
  │                                   │
  │  ◄── { type: "update",        ── │  core dispatches response;
  │        name: "value",             │  getters on the server split the
  │        value: { … } }            │  event into per-property updates
  │  ◄── { type: "update",        ── │  (e.g. `value` and `status` both
  │        name: "status",            │  driven by a shared event are sent
  │        value: 200 }               │  as two distinct updates).
  │                                   │
  │  ◄── { type: "return",        ── │  fetch() resolved
  │        id: "1", value: { … } }   │
```

## Usage

### Server

```typescript
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import { MyFetchCore } from "./my-fetch-core.js";

// When a WebSocket connection is established:
const core = new MyFetchCore();
const transport = new WebSocketServerTransport(socket);
const shell = new RemoteShellProxy(core, transport);
```

`RemoteShellProxy` reads the declaration from `core.constructor.wcBindable` at runtime. That means the object you pass in must expose the declared `static wcBindable` on its effective constructor. If you wrap a Core in a `Proxy`, decorator, or mixin that changes the constructor chain, preserve or re-expose that static property on the final constructor before passing it to `RemoteShellProxy`.

`WebSocketServerTransport` expects incoming client messages to arrive either as text JSON frames or as UTF-8 binary bytes such as Node `Buffer`, `Uint8Array`, or `ArrayBuffer`. If your runtime surfaces `Blob` payloads for message events, prefer text frames or adapt the socket before passing it in, because the transport API is synchronous and does not await `Blob.text()`.

### Client

```typescript
import { createRemoteCoreProxy, WebSocketClientTransport } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { MyFetchCore } from "./my-fetch-core.js"; // for wcBindable declaration only

const ws = new WebSocket("ws://localhost:3000");
const transport = new WebSocketClientTransport(ws);
const proxy = createRemoteCoreProxy(MyFetchCore.wcBindable, transport);

// bind() works exactly as if Core were local
bind(proxy, (name, value) => {
  console.log(name, value);
});

// Set input properties
proxy.set("url", "/api/users");

// Invoke commands
const result = await proxy.invoke("fetch");
```

### With a framework adapter

```tsx
// React — the proxy is an EventTarget, so useWcBindable works via bind()
import { createRemoteCoreProxy, WebSocketClientTransport } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";

const ws = new WebSocket("ws://localhost:3000");
const transport = new WebSocketClientTransport(ws);
// proxy is created once here, so the empty dependency list is intentional.
const proxy = createRemoteCoreProxy(MyFetchCore.wcBindable, transport);

// Subscribe with bind() and feed into React state
const [values, setValues] = useState({});
useEffect(() => {
  return bind(proxy, (name, value) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  });
}, []);
```

## Custom transport

The `ClientTransport` and `ServerTransport` interfaces are intentionally minimal. Implement them to use any transport — WebSocket, WebTransport, MessagePort, BroadcastChannel, Worker postMessage, etc. — as long as it can satisfy the protocol contract below.

```typescript
import type { ClientTransport, ClientMessage, ServerMessage } from "@wc-bindable/remote";

class MyCustomTransport implements ClientTransport {
  send(message: ClientMessage): void { /* ... */ }
  onMessage(handler: (message: ServerMessage) => void): void { /* ... */ }
}
```

### Transport contract

The protocol relies on two invariants. Either failing to hold them silently breaks `sync` / `update` ordering or produces values that survive the wire but should not.

1. **FIFO delivery between a given (client, server) pair.** `sync` responses, `update` messages, `return` / `throw` replies, and post-sync updates must be observed by the peer in the order the sender called `send()`. The sequence-number-free design depends on this, and `RemoteShellProxy`'s sync-time update buffering only works if the transport preserves that order end-to-end. WebSocket (per-connection) and `MessagePort` (per-port) satisfy this. `BroadcastChannel` does **not** in the general case — different receivers can observe different orderings under tab suspension / throttling; use it only when all peers are in the same realm. Transports that fan-in from multiple senders or coalesce retries must collapse back to a single ordered stream before handing to the handler.
2. **JSON-compatible payloads only.** The existing proxy/shell implementations assume the wire format is what `JSON.stringify` / `JSON.parse` round-trip faithfully: plain objects, arrays, strings, finite numbers, booleans, `null`. Values such as `Date`, `Map`, `Set`, `BigInt`, typed arrays, class instances, functions, or cyclic objects are out of contract — even on transports like `MessagePort` whose native structured clone would preserve them, custom transports **must** serialize at the boundary (e.g. call `JSON.stringify` / `JSON.parse` themselves) so every transport presents the same lossy, JSON-shape view to `RemoteCoreProxy` and `RemoteShellProxy`. Otherwise a message that survives one transport will silently change shape on another, and error-serialization / value-cache invariants break.

In addition, the optional `onClose(handler)` hook should fire at most once per connection lifetime, and `dispose()` (if implemented) must be idempotent — `RemoteShellProxy` and `RemoteCoreProxy` both rely on these when they tear down or reconnect.

### Back-pressure

This package does **not** implement built-in back-pressure or queue limits by default. In particular, `WebSocketClientTransport` buffers pre-open outbound messages without a cap, `RemoteCoreProxy` still keeps pending acknowledged requests in memory until they settle or hit their timeout, and `RemoteShellProxy` buffers synchronous `update` messages while a `sync` snapshot is being built. Opt-in soft caps (`maxPreOpenQueue`, `maxPendingInvocations`, `maxSyncUpdateBuffer`) are available — see the Error handling section for details. In production, pair them with admission control, connection quotas, reverse-proxy limits, or per-client rate limiting if untrusted or slow peers are possible.

### Logging

All diagnostic output (dropped `set`/`cmd` frames, unknown response ids, invalid server frames, getter failures, send failures) is routed through an injectable `Logger`. By default it forwards to `console.warn` / `console.error`, but every class — `RemoteCoreProxy` / `createRemoteCoreProxy`, `RemoteShellProxy`, `WebSocketClientTransport`, `WebSocketServerTransport` — accepts `options.logger` so production deployments can adapt structured loggers (pino, winston, bunyan, ...) without monkey-patching `console`.

```typescript
import type { Logger } from "@wc-bindable/remote";
import pino from "pino";

const pinoInstance = pino();
const logger: Logger = {
  warn: (message, ...extras) => pinoInstance.warn({ extras }, message),
  error: (message, ...extras) => pinoInstance.error({ extras }, message),
};

const shell = new RemoteShellProxy(core, transport, { logger });
const proxy = createRemoteCoreProxy(declaration, clientTransport, { logger });
```

The `Logger` contract is intentionally minimal (`{ warn(message, ...extras): void; error(message, ...extras): void }`) so any logger can be adapted in a few lines. Pass the same `logger` to every component you construct on the same side of the wire to keep diagnostics correlated.

## API

| Export | Description |
|---|---|
| `createRemoteCoreProxy(declaration, transport, options?)` | Create a client-side proxy. Returns an EventTarget compatible with `bind()`. `options` accepts `maxPendingInvocations` (see Back-pressure) and `logger` (see Logging). |
| `RemoteCoreProxy` | The underlying proxy class (use `createRemoteCoreProxy` for property access support). |
| `RemoteShellProxy` | Server-side proxy that connects a real Core to the transport. Constructor accepts an options bag with `maxSyncUpdateBuffer` and `logger`. |
| `WebSocketClientTransport` | `ClientTransport` implementation using the standard `WebSocket` API. Constructor accepts an options bag with `maxPreOpenQueue` and `logger`. |
| `WebSocketServerTransport` | `ServerTransport` implementation using any `WebSocketLike` object. Constructor accepts an options bag with `logger`. |
| `Logger`, `consoleLogger` | Logger contract (`{ warn, error }`) and the default implementation that forwards to `console`. See Logging. |

### RemoteCoreProxy

| Method | Description |
|---|---|
| `set(name, value)` | Set an input property on the remote Core. Fire-and-forget — see "Error handling" below. |
| `setWithAck(name, value)` | Set an input property and wait for the server to acknowledge or reject it. |
| `setWithAckOptions(name, value, options)` | Set an input property with lifecycle options such as `AbortSignal` and `timeoutMs`, without changing the wire payload sent to the server. |
| `invoke(name, ...args)` | Invoke a command on the remote Core. Returns a Promise that settles when the server replies, the send fails, the transport closes, or the default 30s timeout expires. |
| `invokeWithOptions(name, args, options)` | Invoke a command with explicit wire arguments and lifecycle options such as `AbortSignal` and `timeoutMs`. The legacy `invokeWithOptions(name, options, ...args)` overload is **deprecated and scheduled for removal in v1.0** — see Error handling below. |
| `reconnect(transport)` | Attach a fresh client transport after the previous one closed. Existing `bind()` subscribers stay attached and a new `sync` request is sent immediately. |
| `dispose()` | Reject pending invocations and stop processing future transport messages for this proxy instance. |

#### Error handling

- **`invoke()`** errors on the server are serialized and delivered as `throw` messages, which reject the returned Promise. When the server throws an `Error`, the payload preserves at least `name` and `message`, and includes `stack` when available. If the thrown value itself is not JSON-serializable, `RemoteShellProxy` falls back to a serializable `RemoteShellProxyError` payload instead of leaving the client request pending.
- **`setWithAckOptions()`** supports `AbortSignal` and `timeoutMs`. Aborting rejects the client-side Promise and forgets the pending response; it does not send a cancellation message to the server. Timeouts reject with `TimeoutError` and also clear the pending entry. `setWithAck()` uses the same behavior with a default 30s timeout.
- **`invokeWithOptions()`** supports `AbortSignal` and `timeoutMs`. **Use the explicit form `invokeWithOptions(name, args, options)`.** Aborting rejects the client-side Promise and forgets the pending response; it does not send a cancellation message to the server. Timeouts reject with `TimeoutError` and also clear the pending entry. `invoke()` uses the same behavior with a default 30s timeout.
- **Deprecation — legacy `invokeWithOptions(name, options, ...args)` overload.** The historical `(name, options, ...args)` form is **deprecated and scheduled for removal in v1.0**. It is still accepted in the 0.x line so existing callers do not break, and the TypeScript signature carries a `@deprecated` tag so IDEs and linters surface it. The runtime branches on `Array.isArray(optionsOrArgs)`, which means a command whose first or only wire argument is itself an array (`invokeWithOptions("save", [1, 2, 3])`) is always interpreted as `args = [1, 2, 3]`, never as `options = [1, 2, 3]` — that ambiguity is why the legacy overload must go. Migrate those call sites now: wrap the wire arguments in a single array and move options to the last position, for example `invokeWithOptions("save", [[1, 2, 3]], { timeoutMs: 0 })`.
- **Timeout configuration**: pass `timeoutMs` to override the default 30s deadline, or `timeoutMs: 0` to disable the built-in timeout for an individual call. Invalid timeout values (negative or non-finite) are surfaced as `RangeError` rejections from the returned Promise rather than synchronous throws. If the initial `sync` response does not advertise `capabilities.setAck`, `setWithAck()` and `setWithAckOptions()` reject instead of waiting forever against a legacy server.
- **Back-pressure** is opt-in, not automatic. The three in-memory queues in this package — pending `setWithAck`/`invoke` requests on `RemoteCoreProxy`, pre-open send buffer on `WebSocketClientTransport`, and `sync`-time queued `update` messages on `RemoteShellProxy` — default to unbounded. Opt-in soft limits are available via constructor options: `createRemoteCoreProxy(decl, transport, { maxPendingInvocations: N })` rejects further `setWithAck`/`invoke` calls with `Error("RemoteCoreProxy: pending invocations exceeded maxPendingInvocations=N")` once the pending map is at capacity; `new WebSocketClientTransport(ws, { maxPreOpenQueue: N })` throws `Error("WebSocketClientTransport: pre-open queue exceeded maxPreOpenQueue=N")` when a send() would grow the pre-open buffer past N; `new RemoteShellProxy(core, transport, { maxSyncUpdateBuffer: N })` logs a single `console.warn` per sync cycle when a getter side-effect pushes the queued-updates buffer past N (buffering continues so wire-level ordering is preserved). Each accepts positive integers only; defaults are `Infinity` for backward compatibility. These are soft operational guardrails — set them alongside admission control, connection quotas, reverse-proxy limits, or per-client rate limiting if untrusted or slow peers are possible.
- **Transport close** rejects all pending `invoke()` calls with `Transport closed` and leaves the proxy disconnected until you call `reconnect()` with a new transport.
- **`dispose()`** is terminal: it rejects all pending requests with `RemoteCoreProxy disposed` and causes subsequent `set()`, `invoke()`, and `reconnect()` calls to fail immediately.
- **`set()`** validates the input name on the client before sending, so undeclared names fail immediately. It also throws synchronously if the proxy is already disconnected or if the transport send fails while trying to enqueue the message. For declared inputs on a healthy transport, it remains fire-and-forget: there is no response id and no server-side success/error is delivered back to the client. If a buggy or stale client still sends an undeclared input, `RemoteShellProxy` drops it and logs via the injected logger. **Delivery is at-most-once**: a `set()` whose frame is still in-flight when the transport drops is not retried on `reconnect()`, and the client cannot tell whether the server received it. Eventual state convergence is achieved by the `sync` fired during `reconnect()` (the server's authoritative value is restored on the client). Prefer `setWithAck()` when the input is not idempotent — see "`set()` is at-most-once" under Design decisions.
- **`setWithAck()`** sends the same mutation with a request id and waits for a `return`/`throw` response. Use it when the caller needs server-side validation feedback such as type mismatches, read-only assignments, or conversion failures. It requires the server to advertise `capabilities.setAck` in the initial `sync` response; legacy servers that omit that capability are rejected once detected. Use `setWithAckOptions()` when you also need client-side cancellation.
- **Fire-and-forget setter failures** on plain `set()` are still caught and logged via `console.error` on the server so they do not escape the transport's message handler or terminate the connection.
- **Server send failures** while forwarding `sync`, `update`, `return`, or `throw` messages are caught and logged via `console.error`. The failing message is dropped; the connection is not closed automatically.
- **Server transport teardown**: if the `ServerTransport` implements `onClose()`, `RemoteShellProxy` disposes itself automatically. If the transport also implements `dispose()`, `RemoteShellProxy.dispose()` calls it so message/close listeners can be released. `WebSocketServerTransport` does both for standard WebSocket and Node `ws` close events.

### RemoteShellProxy

| Method | Description |
|---|---|
| `constructor(core, transport, options?)` | Connect a Core to the transport. Subscribes to Core events and listens for client messages. `options.maxSyncUpdateBuffer` logs a one-shot warning when a runaway getter side-effect pushes the sync-time queue past the threshold (see Back-pressure). |
| `dispose()` | Unsubscribe from Core events and release transport-owned listeners if supported. Call when the connection closes. |

### Message protocol

```
Client → Server:
  { type: "sync" }
  { type: "set", name: string, value: unknown, id?: string }
  { type: "cmd", name: string, id: string, args: unknown[] }

Server → Client:
  { type: "sync", values: Record<string, unknown>, capabilities?: { setAck?: boolean }, getterFailures?: string[], undefinedProperties?: string[] }
  { type: "update", name: string, value: unknown }
  { type: "return", id: string, value: unknown }
  { type: "throw", id: string, error: unknown }
```

### Design decisions

**Why `sync` instead of automatic initial push?**
The server subscribes to future Core events, but it does not push initial values during construction. The `sync` request/response pattern ensures the client receives initial state only when it is ready to process it.

**Why no sequence numbers?**
WebSocket guarantees FIFO message ordering, and JavaScript's single-threaded execution ensures that `sync` responses and `event` messages are enqueued in a consistent order. A `sync` response always reflects the Core's state at the time the request was processed; any events dispatched after that point are sent after the `sync` response. To preserve that guarantee even when a getter emits a synchronous side-effect event while the server is building the `sync` snapshot, `RemoteShellProxy` buffers those `update` messages and flushes them only after the `sync` response is sent. This makes sequence numbers unnecessary under these constraints.

If a declared getter throws while building `sync`, the server logs the failure and includes that property name in `getterFailures`. The client preserves its previous cached value for those names on re-sync; only properties omitted without a getter failure are treated as having reverted to `undefined`.

A symmetric `undefinedProperties` array explicitly enumerates declared properties whose getter returned `undefined` (rather than throwing or being absent). This lets the client distinguish "currently `undefined`" from other reasons a property might be missing from `values`, and makes the initial `sync` able to deliver a reset event for those properties even when there is no prior cached value to compare against. The field is optional: older servers that omit it still interoperate with current clients via the legacy omitted-key convention. Note that JavaScript `CustomEvent` normalizes `detail: undefined` to `null`, so `bind()` subscribers observe `null` for these resets while the proxy's property getter continues to read back as `undefined`.

**`set()` is at-most-once; `setWithAck()` is acknowledged delivery.**
The fire-and-forget `set()` frame is sent at most once: if the transport drops after the client hands the frame to `transport.send()` but before it reaches the server, the client sees no error for that specific call, and `reconnect()` does **not** replay it. The follow-up `sync` triggered by `reconnect()` re-reads the server's authoritative state, so eventual convergence is guaranteed **provided the input is idempotent** — if the latest desired value is what you care about rather than the number of applications, the protocol self-heals.

`setWithAck()` provides a stronger guarantee: when the returned Promise **resolves**, the server applied the set. When it rejects, however, the outcome is indeterminate in the general case — for example, a `Transport closed` rejection may mean the frame left the client, reached the server, and was processed before the socket went down, but the `return` ack was lost; a `TimeoutError` likewise cannot distinguish "server never saw it" from "server applied but the ack was dropped". In other words, `setWithAck()` is acknowledged delivery (ack ⇒ applied) but not transactional (no-ack ⇏ not-applied).

Practical guidance when an input is **not** idempotent (increments, event emissions, log appends, billing counters, etc.):

- Use `setWithAck()` and ignore the rejection — the `reconnect()` + `sync` loop will reconcile the server's authoritative state back to the client. Safe if the input represents a desired target, not a delta.
- Or model the operation as a `command` and pass a client-generated idempotency token in `args`. The Core can then dedupe on that token server-side so replay attempts after reconnect collapse.
- Avoid using plain `set()` for non-idempotent inputs: `set("counter", counter + 1)` is a footgun because you cannot tell a transport-lost frame apart from a successful one, and re-issuing it after reconnect risks a double-apply.

**Cancellation is client-local.**
Aborting a `setWithAckOptions()` / `invokeWithOptions()` call — whether via the caller's `AbortSignal`, the built-in `timeoutMs`, the default 30s `invoke()` timeout, `dispose()`, or a transport close — rejects the client-side Promise and drops the entry from the client's pending map. **No cancellation message is sent to the server.** The server continues running the corresponding command or setter to completion and eventually returns or throws; those late `return` / `throw` responses are matched against a pending map that no longer has the request id and are silently ignored.

Operational implications to plan for when wiring long-running commands (HTTP fetches, database calls, streaming responses) behind `invoke()`:

- Server-side resource lifetime is **not** bounded by client cancellation. If the command opens sockets, files, or external requests, bound them with the Core's own `AbortController` / deadline — do not rely on a cancelled client promise to free them.
- A client that re-issues a command after an abort may race with the previous still-running one. Commands that are not idempotent should either dedupe on the Core, or be surfaced through a stateful input (`set` with an id) rather than raw `invoke`.
- `invoke()` and `setWithAck()` apply a default 30s client-side timeout so a dropped response never leaves the UI Promise pending forever. Raise or disable it (`timeoutMs: 0`) when the server-side work is known to exceed 30s; otherwise keep the default.

The wire protocol does not currently carry a cancellation frame. A future extension could add `{ type: "cancel", id }` with an opt-in capability bit (analogous to `capabilities.setAck`) so servers that can propagate cancellation — for example into an `AbortController` passed to the Core command — advertise it, and older servers keep the current "runs to completion" semantics. Such an extension can be added without breaking existing clients or servers.

**Why is the wire protocol property-centric, not event-centric?**
A Core may declare multiple properties that share the same event and differ only by `getter` — for example, `value` and `status` both driven by `my-fetch:response` with `detail.value` and `detail.status`. Sending the raw event name and detail would collapse those properties on the client side. Instead, `RemoteShellProxy` registers one listener per declared property, applies that property's getter on the server, and sends a distinct `{ type: "update", name, value }` message for each property. The client updates its cache by `name` and dispatches a synthetic per-property event so local `bind()` can discriminate.

**Why are getters not applied on the client?**
Because the server already applies them. The wire value is the already-extracted per-property value, and the client proxy rewrites each property's `event` to a synthetic per-property name (`@wc-bindable/remote:<name>`) so the default getter (`e => e.detail`) is always sufficient. As a consequence, `getter` functions do not need to be serializable — but note that this also means `addEventListener` on the proxy with the original Core event name will not fire. **When migrating existing code to Remote, treat `bind()` or property access as required; code that directly subscribed to Core event names must be rewritten.**

**What values can cross the wire?**
Messages are encoded with `JSON.stringify`, so only JSON-serializable values round-trip faithfully. Values such as `Date`, `Map`, `Set`, `BigInt`, functions, class instances, or cyclic objects will be transformed, dropped, or throw during serialization. If serialization fails while the server is sending `sync`, `update`, or `return`, `RemoteShellProxy` logs the failure and drops that message. For `throw` responses, it instead falls back to a serializable `RemoteShellProxyError` payload so the client request can still reject.

## License

MIT
