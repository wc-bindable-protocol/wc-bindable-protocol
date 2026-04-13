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

## Connection lifecycle

1. The server creates a `RemoteShellProxy`, which subscribes to the Core's declared events and starts forwarding updates.
2. The client creates a `RemoteCoreProxy`, which immediately sends a `sync` request.
3. The server responds with the Core's current property values.
  Properties whose current value is `undefined` are omitted, matching local `bind()` initial synchronization.
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

The `ClientTransport` and `ServerTransport` interfaces are intentionally minimal. Implement them to use any transport — MessagePort, BroadcastChannel, WebTransport, etc.

```typescript
import type { ClientTransport, ClientMessage, ServerMessage } from "@wc-bindable/remote";

class MyCustomTransport implements ClientTransport {
  send(message: ClientMessage): void { /* ... */ }
  onMessage(handler: (message: ServerMessage) => void): void { /* ... */ }
}
```

Custom transport implementations **must guarantee message ordering** (FIFO). The protocol relies on this to ensure consistency between `sync` responses and subsequent `event` messages without sequence numbers.

This package does **not** implement built-in back-pressure or queue limits. In particular, `WebSocketClientTransport` buffers pre-open outbound messages without a cap, `RemoteCoreProxy` still keeps pending acknowledged requests in memory until they settle or hit their timeout, and `RemoteShellProxy` buffers synchronous `update` messages while a `sync` snapshot is being built. In production, bound these at a higher layer with admission control, connection quotas, reverse-proxy limits, or per-client rate limiting if untrusted or slow peers are possible.

## API

| Export | Description |
|---|---|
| `createRemoteCoreProxy(declaration, transport)` | Create a client-side proxy. Returns an EventTarget compatible with `bind()`. |
| `RemoteCoreProxy` | The underlying proxy class (use `createRemoteCoreProxy` for property access support). |
| `RemoteShellProxy` | Server-side proxy that connects a real Core to the transport. |
| `WebSocketClientTransport` | `ClientTransport` implementation using the standard `WebSocket` API. |
| `WebSocketServerTransport` | `ServerTransport` implementation using any `WebSocketLike` object. |

### RemoteCoreProxy

| Method | Description |
|---|---|
| `set(name, value)` | Set an input property on the remote Core. Fire-and-forget — see "Error handling" below. |
| `setWithAck(name, value)` | Set an input property and wait for the server to acknowledge or reject it. |
| `setWithAckOptions(name, value, options)` | Set an input property with lifecycle options such as `AbortSignal` and `timeoutMs`, without changing the wire payload sent to the server. |
| `invoke(name, ...args)` | Invoke a command on the remote Core. Returns a Promise that settles when the server replies, the send fails, the transport closes, or the default 30s timeout expires. |
| `invokeWithOptions(name, options, ...args)` | Invoke a command with lifecycle options such as `AbortSignal` and `timeoutMs`, without changing the wire arguments sent to the server. |
| `reconnect(transport)` | Attach a fresh client transport after the previous one closed. Existing `bind()` subscribers stay attached and a new `sync` request is sent immediately. |
| `dispose()` | Reject pending invocations and stop processing future transport messages for this proxy instance. |

#### Error handling

- **`invoke()`** errors on the server are serialized and delivered as `throw` messages, which reject the returned Promise. When the server throws an `Error`, the payload preserves at least `name` and `message`, and includes `stack` when available. If the thrown value itself is not JSON-serializable, `RemoteShellProxy` falls back to a serializable `RemoteShellProxyError` payload instead of leaving the client request pending.
- **`setWithAckOptions()`** supports `AbortSignal` and `timeoutMs`. Aborting rejects the client-side Promise and forgets the pending response; it does not send a cancellation message to the server. Timeouts reject with `TimeoutError` and also clear the pending entry. `setWithAck()` uses the same behavior with a default 30s timeout.
- **`invokeWithOptions()`** supports `AbortSignal` and `timeoutMs`. Aborting rejects the client-side Promise and forgets the pending response; it does not send a cancellation message to the server. Timeouts reject with `TimeoutError` and also clear the pending entry. `invoke()` uses the same behavior with a default 30s timeout.
- **Timeout configuration**: pass `timeoutMs` to override the default 30s deadline, or `timeoutMs: 0` to disable the built-in timeout for an individual call. If the initial `sync` response does not advertise `capabilities.setAck`, `setWithAck()` and `setWithAckOptions()` reject instead of waiting forever against a legacy server.
- **Back-pressure** is not built in. Pending acknowledgements, pre-open WebSocket sends, and `sync`-time queued updates are all unbounded in-memory queues. If a peer can stall or flood the connection, enforce your own limits above this package.
- **Transport close** rejects all pending `invoke()` calls with `Transport closed` and leaves the proxy disconnected until you call `reconnect()` with a new transport.
- **`dispose()`** is terminal: it rejects all pending requests with `RemoteCoreProxy disposed` and causes subsequent `set()`, `invoke()`, and `reconnect()` calls to fail immediately.
- **`set()`** validates the input name on the client before sending, so undeclared names fail immediately. It also throws synchronously if the proxy is already disconnected or if the transport send fails while trying to enqueue the message. For declared inputs on a healthy transport, it remains fire-and-forget: there is no response id and no server-side success/error is delivered back to the client. If a buggy or stale client still sends an undeclared input, `RemoteShellProxy` drops it and logs `console.warn`.
- **`setWithAck()`** sends the same mutation with a request id and waits for a `return`/`throw` response. Use it when the caller needs server-side validation feedback such as type mismatches, read-only assignments, or conversion failures. It requires the server to advertise `capabilities.setAck` in the initial `sync` response; legacy servers that omit that capability are rejected once detected. Use `setWithAckOptions()` when you also need client-side cancellation.
- **Fire-and-forget setter failures** on plain `set()` are still caught and logged via `console.error` on the server so they do not escape the transport's message handler or terminate the connection.
- **Server send failures** while forwarding `sync`, `update`, `return`, or `throw` messages are caught and logged via `console.error`. The failing message is dropped; the connection is not closed automatically.
- **Server transport teardown**: if the `ServerTransport` implements `onClose()`, `RemoteShellProxy` disposes itself automatically. If the transport also implements `dispose()`, `RemoteShellProxy.dispose()` calls it so message/close listeners can be released. `WebSocketServerTransport` does both for standard WebSocket and Node `ws` close events.

### RemoteShellProxy

| Method | Description |
|---|---|
| `constructor(core, transport)` | Connect a Core to the transport. Subscribes to Core events and listens for client messages. |
| `dispose()` | Unsubscribe from Core events and release transport-owned listeners if supported. Call when the connection closes. |

### Message protocol

```
Client → Server:
  { type: "sync" }
  { type: "set", name: string, value: unknown, id?: string }
  { type: "cmd", name: string, id: string, args: unknown[] }

Server → Client:
  { type: "sync", values: Record<string, unknown>, capabilities?: { setAck?: boolean }, getterFailures?: string[] }
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

**Why is the wire protocol property-centric, not event-centric?**
A Core may declare multiple properties that share the same event and differ only by `getter` — for example, `value` and `status` both driven by `my-fetch:response` with `detail.value` and `detail.status`. Sending the raw event name and detail would collapse those properties on the client side. Instead, `RemoteShellProxy` registers one listener per declared property, applies that property's getter on the server, and sends a distinct `{ type: "update", name, value }` message for each property. The client updates its cache by `name` and dispatches a synthetic per-property event so local `bind()` can discriminate.

**Why are getters not applied on the client?**
Because the server already applies them. The wire value is the already-extracted per-property value, and the client proxy rewrites each property's `event` to a synthetic per-property name (`@wc-bindable/remote:<name>`) so the default getter (`e => e.detail`) is always sufficient. As a consequence, `getter` functions do not need to be serializable — but note that this also means `addEventListener` on the proxy with the original Core event name will not fire. Use `bind()` or property access.

**What values can cross the wire?**
Messages are encoded with `JSON.stringify`, so only JSON-serializable values round-trip faithfully. Values such as `Date`, `Map`, `Set`, `BigInt`, functions, class instances, or cyclic objects will be transformed, dropped, or throw during serialization. If serialization fails while the server is sending `sync`, `update`, or `return`, `RemoteShellProxy` logs the failure and drops that message. For `throw` responses, it instead falls back to a serializable `RemoteShellProxyError` payload so the client request can still reject.

## License

MIT
