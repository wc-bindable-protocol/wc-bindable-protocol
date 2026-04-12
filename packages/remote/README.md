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
                      ◄──────────  event: loading-changed
                      ◄──────────  event: response
```

## Connection lifecycle

1. The server creates a `RemoteShellProxy`, which subscribes to the Core via `bind()` and starts forwarding events.
2. The client creates a `RemoteCoreProxy`, which immediately sends a `sync` request.
3. The server responds with the Core's current property values.
4. The client populates its cache and dispatches events for each value — `bind()` on the client side picks these up as if they were normal state changes.
5. From this point, all Core events are forwarded in real time.

```
Client                              Server
  │                                   │  RemoteShellProxy created
  │                                   │  bind() subscribes to Core
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
  │  ◄── { type: "event",         ── │  core dispatches loading-changed
  │        event: "…:loading-changed",│
  │        detail: true }             │
  │                                   │
  │  ◄── { type: "event",         ── │  core dispatches response
  │        event: "…:response",       │
  │        detail: { … } }           │
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

// Clean up when the connection closes:
socket.addEventListener("close", () => shell.dispose());
```

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
| `set(name, value)` | Set an input property on the remote Core. |
| `invoke(name, ...args)` | Invoke a command on the remote Core. Returns a Promise. |

### RemoteShellProxy

| Method | Description |
|---|---|
| `constructor(core, transport)` | Connect a Core to the transport. Subscribes to Core events and listens for client messages. |
| `dispose()` | Unsubscribe from Core events. Call when the connection closes. |

### Message protocol

```
Client → Server:
  { type: "sync" }
  { type: "set", name: string, value: unknown }
  { type: "cmd", name: string, id: string, args: unknown[] }

Server → Client:
  { type: "sync", values: Record<string, unknown> }
  { type: "event", event: string, detail: unknown }
  { type: "return", id: string, value: unknown }
  { type: "throw", id: string, error: unknown }
```

### Design decisions

**Why `sync` instead of automatic initial push?**
The server-side `bind()` fires initial values synchronously in the constructor. If the server sends them immediately, the client's message handler may not be registered yet. The `sync` request/response pattern ensures the client receives initial state only when it is ready to process it.

**Why no sequence numbers?**
WebSocket guarantees FIFO message ordering, and JavaScript's single-threaded execution ensures that `sync` responses and `event` messages are enqueued in a consistent order. A `sync` response always reflects the Core's state at the time the request was processed; any events dispatched after that point are sent after the `sync` response. This makes sequence numbers unnecessary under these constraints.

**Why are getters not applied on the client?**
The server-side `bind()` applies the original `getter` functions when extracting values from Core events. The serialized message carries the already-extracted value. The client-side proxy uses only the default getter (`e => e.detail`), so `getter` functions do not need to be serializable.

## License

MIT
