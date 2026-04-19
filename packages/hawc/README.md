# Avoiding Frontend Framework Lock-in with HAWC and wc-bindable-protocol

## Overview

HAWC (Headless Async Web Components) is an architectural concept that leverages Web Components as headless, asynchronous components, separating async processing from the framework layer. Built on wc-bindable-protocol as its foundation, it enables reuse across any framework by keeping **decisions** in a headless Core and leaving the browser-side Shell responsible only for framework integration and execution that cannot be delegated away.

This document summarizes the technical structure of HAWC, its contribution to solving the framework lock-in problem, and its practical operational benefits.

## Background: The Nature of Framework Lock-in

Framework lock-in in frontend development is often framed as a UI component compatibility problem. However, the true source of migration cost lies in business logic — specifically, asynchronous processing.

`fetch` calls, WebSocket connections, polling, loading state management — these are all written tightly coupled to framework-specific lifecycle APIs: React's `useEffect`, Vue's `onMounted`, Svelte's `onMount`, and so on. When migrating frameworks, rewriting templates can be done mechanically, but re-implementing async logic requires semantic understanding of the code. This is where the real bottleneck lies.

## HAWC's Architecture

HAWC structurally resolves this problem by moving the location of async processing from the framework side into the Web Component side.

### Three-Layer Structure

HAWC's architecture consists of three layers:

**Headless Web Component Layer** — Encapsulates async processing (HTTP communication, WebSockets, timers, etc.) internally and autonomously manages state (`value`, `loading`, `error`, `status`, etc.). It has no UI whatsoever and functions as a pure service layer.

**Protocol Layer (wc-bindable-protocol)** — Components declare their bindable properties via a `static wcBindable` field and notify state changes via `CustomEvent`. Adapters simply read this declaration and subscribe to the events.

**Framework Layer** — Connects to the protocol through a thin adapter and renders the received state. Contains absolutely no async processing code.

![architecure overview](./hawc_architecture_overview.svg)

The diagram above shows the **base HAWC shape**: the Core owns the authoritative state machine and decisions, while the Shell is the framework-facing surface that receives events and exposes the protocol boundary to adapters. In the thin-Shell cases, the Shell adds little beyond lifecycle, command forwarding, and local event bridging. In **Case C**, the same structure still holds, but the Shell additionally carries browser-anchored execution that cannot be delegated to the Core's runtime.

### Core/Shell Separation

The Headless Web Component Layer can be further decomposed into two distinct parts: a **Core** and a **Shell**. The most useful invariant is not "the Shell is always thin" but rather:

**Core owns decisions** — business logic, policy, state transitions, authorization-sensitive behavior, and event emission.

**Shell owns only undelegatable execution** — framework binding, DOM lifecycle, and any browser-anchored execution the Core cannot perform from its own runtime.

From that invariant, two common consequences follow.

**Core (EventTarget)** — The Core contains the authoritative logic and state machine. It extends `EventTarget`, not `HTMLElement`, so when the domain allows it, it has zero DOM dependency and can cross the **runtime boundary** into Node.js, Deno, Cloudflare Workers, and other runtimes. That portability is a major benefit, but it is not the primary invariant: some domains are browser-anchored and therefore keep the Core in the browser.

**Shell (HTMLElement)** — The Shell is the framework-facing surface. It extends `HTMLElement`, so frameworks can reference it via `ref` and adapters can bind to it. In the simplest case it is a thin wrapper that maps attributes and lifecycle to the Core. In other cases it may be a command proxy or a browser-side execution engine. The Shell crosses the **framework boundary**.

```
┌─────────────────────────────────────────────────┐
│  Core (EventTarget)                             │
│  - owns decisions, state, dispatchEvent         │
│  - often runtime-portable when domain allows    │
├─────────────────────────────────────────────────┤
│  Shell (HTMLElement)                            │
│  - framework surface, lifecycle, execution      │
│  - enables framework binding via ref            │
└─────────────────────────────────────────────────┘
```

The key design pattern enabling this separation is **target injection**: the Core's constructor accepts an optional `target` parameter (an `EventTarget`) to which it dispatches all events. When omitted, it defaults to `this` — the Core itself. When the Shell passes `this` (the `HTMLElement`) as the target, Core events fire directly on the DOM element, requiring no event re-dispatch.

```javascript
// Core — pure EventTarget, no DOM
class MyFetchCore extends EventTarget {
  static wcBindable = { /* ... */ };
  #target;

  constructor(target) {
    super();
    this.#target = target ?? this;
  }

  // Events dispatch on #target
  #setLoading(loading) {
    this.#target.dispatchEvent(
      new CustomEvent("my-fetch:loading-changed", { detail: loading, bubbles: true }),
    );
  }

  async fetch(url, options = {}) { /* ... */ }
}
```

```javascript
// Shell — thin HTMLElement wrapper
class MyFetch extends HTMLElement {
  static wcBindable = MyFetchCore.wcBindable;
  #core;

  constructor() {
    super();
    this.#core = new MyFetchCore(this); // events fire directly on this element
  }

  // Attribute mapping (DOM-specific)
  get url() { return this.getAttribute("url") || ""; }

  // Delegate to core
  async fetch() { return this.#core.fetch(this.url, { method: this.method }); }

  // Lifecycle (DOM-specific)
  connectedCallback() { if (!this.manual && this.url) this.fetch(); }
  disconnectedCallback() { this.#core.abort(); }
}
```

This separation yields three practical benefits:

1. **Framework decoupling** — The UI layer binds to state and commands instead of owning async orchestration.
2. **Execution confinement** — Security-sensitive or platform-anchored work stays on the side that must own it.
3. **Runtime portability when available** — When the domain is not browser-anchored, the Core can be unit-tested and reused outside the browser.

### Three Canonical Cases

The thin-Shell case is important, but it is not the only canonical shape. In practice HAWC appears in three parallel cases.

| Case | Shape | Typical example | What the Shell does |
|------|-------|-----------------|---------------------|
| A | Core in browser | `hawc-auth0` local | Thin framework-facing wrapper around a browser-anchored Core |
| B | Core on server + thin Shell | `hawc-ai` remote, `hawc-flags` | Proxy, command delegation, or observation adapter over the wire |
| C | Core on server + browser-anchored execution Shell | `hawc-s3`, `hawc-webauthn` | Executes the data plane the browser platform refuses to delegate |

Case C is not a deviation from HAWC. It is a first-class case for domains where the browser owns an execution surface the server cannot stand in for: direct object upload, WebRTC, WebUSB, WebBluetooth, `File System Access API`, clipboard / drag-and-drop / paste flows, camera / microphone capture, and other user-gesture- or device-anchored capabilities.

### Case C: Browser-Anchored Execution

The familiar thin-Shell rule holds whenever the Core can reach every external system the work requires — HTTP fetches, DB writes, cron, and so on — from its own runtime.

There is a different but equally canonical class of work where it cannot. When the **data plane** must run in the browser for reasons unrelated to business logic — direct upload to object storage, WebRTC, WebUSB, the `File System Access API`, anything gated on a user gesture or that would otherwise tunnel a payload through the WebSocket — the Shell stops being a thin marshaller and becomes the **data-plane executor**. The Core retains the **control plane** (signing, authorization, post-processing, persistence) and the wire still carries only small JSON-RPC messages, but the Shell now holds an XHR pump, a worker pool, retry / re-sign logic, and abort plumbing.

`@wc-bindable/hawc-s3` is the canonical example: the bytes go browser → S3 directly because tunneling them through the control WebSocket would (a) double the egress cost, (b) waste the server's bandwidth, and (c) defeat S3's parallel multipart upload. The Shell ends up at ~800 lines. That is not a violation of HAWC's intent. It is the correct HAWC shape when the data plane is anchored to the browser by the platform.

The principle that survives across all three cases is:
**the Core owns every decision; the Shell owns only execution it cannot delegate.** A "thick" Shell that signs its own URLs or runs its own authorization checks would be a HAWC violation, regardless of byte count. A thick Shell that PUTs bytes to a Core-signed URL is not.

When you build a HAWC component and the Shell starts to grow, ask which side of that line the new code is on. Pumping bytes that cannot leave the browser → Shell. Anything else → Core.

### A More Accurate Taxonomy

The A/B/C split is useful, but real packages show that Case B itself has two sub-shapes:

- **B1: command-mediating thin Shell** — The browser surface forwards inputs and commands to a remote Core while exposing the same bindable state locally. `hawc-ai` fits here.
- **B2: observation-only thin Shell** — The browser surface exists mainly to subscribe to a remote session proxy and re-dispatch a shape that works with `data-wcs`. `hawc-flags` fits here.

That makes a small matrix more accurate than a single numbered ladder:

| Core location | Shell role | Example |
|---------------|------------|---------|
| Browser | Thin wrapper around browser-anchored Core | `hawc-auth0` local |
| Server | Command-mediating / proxy thin Shell | `hawc-ai` remote |
| Server | Observation adapter thin Shell | `hawc-flags` |
| Server | Browser-anchored execution Shell | `hawc-s3`, `hawc-webauthn` |

This framing keeps the true invariant in view. Runtime portability remains a major advantage, but it is a consequence available to some domains, not the sole definition of HAWC.

### Remote: Core/Shell Separation Over the Network

The Core/Shell separation naturally extends to a network boundary. With `@wc-bindable/remote`, the Core runs on a server while the client holds a proxy `EventTarget` — and `bind()` works identically on both sides.

```
Client (Browser)                        Server (Node / Deno / etc.)
┌──────────────────────┐  WebSocket   ┌──────────────────────┐
│  RemoteCoreProxy     │◄────────────►│  RemoteShellProxy    │
│  (EventTarget)       │              │                      │
│                      │              │  Core (EventTarget)  │
│  bind() just works   │              │  Business logic here │
└──────────────────────┘              └──────────────────────┘
```

`RemoteShellProxy` subscribes to the Core's declared events, applies per-property getters on the server side, and forwards property-centric `update` messages over the wire. `RemoteCoreProxy` maintains a local cache, dispatches synthetic events, and exposes `set()` / `invoke()` for inputs and commands. Because the proxy is a standard `EventTarget`, every framework adapter works without modification.

This means the three boundaries that HAWC crosses — runtime, framework, and now network — are all handled transparently by the same protocol:

| Boundary | Crossed by | Mechanism |
|----------|-----------|-----------|
| Runtime | Core (EventTarget) | No DOM dependency; works in Node, Deno, Workers |
| Framework | Shell (HTMLElement) | Attribute mapping + `ref` binding |
| Network | Remote (WebSocket / custom transport) | Proxy EventTarget + JSON wire protocol |

The transport layer is pluggable — WebSocket is the default, but any FIFO channel (MessagePort, BroadcastChannel, WebTransport, etc.) can be used by implementing the minimal `ClientTransport` / `ServerTransport` interfaces.

### Conversion to a State Machine Subscription

The core insight of this architecture is that async processing is converted into a subscription to a state machine. From the framework's perspective, properties like `values.loading` and `values.error` exposed by a component such as `<my-fetch>` are simply reactive values — there is no need to be aware that async processing is happening at all. Whether written in React or Vue, the code structure becomes nearly identical.

```tsx
// React — no fetch(), no async/await, no loading state management needed
const [ref, values] = useWcBindable<MyFetchElement, MyFetchValues>();
// values.loading, values.value, values.error — all reactive
```

```vue
<!-- Vue — same component, same structure -->
<script setup>
const { ref, values } = useWcBindable({ value: null, loading: false });
</script>
<template>
  <my-fetch :ref="ref" url="/api/data" />
  <p v-if="values.loading">Loading...</p>
  <p v-else>{{ values.value }}</p>
</template>
```

## Design of wc-bindable-protocol

### Minimal Convention

The protocol declaration is extremely small:

```javascript
class MyFetch extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
      { name: "error",   event: "my-fetch:error-changed" },
      { name: "status",  event: "my-fetch:status-changed" },
    ],
    inputs: [
      { name: "url", attribute: "url" },
      { name: "method", attribute: "method" },
    ],
    commands: [
      { name: "fetch", async: true },
      { name: "abort" },
    ],
  };
}
```

Each property descriptor requires only two fields: `name` (property name) and `event` (CustomEvent name). An optional `getter` function can customize how the event payload is extracted. Optionally, `inputs` and `commands` can declare the component's input interface — settable properties and callable methods. These declarations are purely descriptive and do not create automatic two-way synchronization; they exist to enable tooling, documentation generation, and remote proxying of components.

### Zero Dependencies — Web Standards Only

The protocol uses only standard APIs: `static` class fields, `EventTarget`, and `CustomEvent`. No build tools, no polyfills, no runtime libraries. All three are stable, long-standing Web standards available across browsers and server-side runtimes (Node.js, Deno, Cloudflare Workers). A future in which `EventTarget` or `CustomEvent` is deprecated is difficult to imagine. This characteristic provides a strong answer to the question: "Will this still work in 10 years?"

### Deliberate Scope Limitations

The protocol intentionally excludes the following from its scope:

- Automatic two-way synchronization (the protocol can declare both outputs and inputs, but synchronization is always explicit — never implicit)
- Form integration
- SSR / hydration
- Validation and schema enforcement

The moment the scope is expanded, complexity explodes. These limitations reflect sound design judgment.

## The Thinness of the Adapter

The core `bind()` function can be implemented in roughly 20 lines:

```javascript
const DEFAULT_GETTER = (e) => e.detail;

function bind(target, onUpdate) {
  const { protocol, version, properties } = target.constructor.wcBindable;
  if (protocol !== "wc-bindable" || version !== 1) return;

  for (const prop of properties) {
    const getter = prop.getter ?? DEFAULT_GETTER;
    target.addEventListener(prop.event, (event) => {
      onUpdate(prop.name, getter(event));
    });
    const current = target[prop.name];
    if (current !== undefined) {
      onUpdate(prop.name, current);
    }
  }
}
```

Note that `bind()` accepts any `EventTarget` — it works with both the Shell (`HTMLElement`) via framework adapters and the Core (`EventTarget`) directly.

Framework-specific adapters are also just a few dozen lines each. React's `useWcBindable`, Vue's `useWcBindable`, and Svelte's `use:wcBindable` are all thin wrappers around this core function.

## Effectiveness as a Framework Lock-in Escape

### Commoditization of Frameworks

Once async processing is externalized into Web Components, the framework layer becomes a pure rendering machine. As a result, the criteria for choosing a framework shift. Rather than evaluating how well a framework handles business logic or async processing, teams can choose based on superficial factors: template syntax preference, rendering performance, developer experience. This is the commoditization of frameworks.

### Freedom from "Irreversible Decisions"

Framework selection has traditionally been a weighty, long-term decision. With HAWC, migrating frameworks means rewriting only templates and bindings — the business logic layer remains intact. Framework selection becomes a choice that can be revisited at any time, dramatically reducing the organizational cost of decision-making.

### Retaining the Benefits of Frameworks

Most framework lock-in escape strategies ultimately reduce to either "don't use a framework" or "add another abstraction layer," each of which creates its own new form of lock-in. HAWC takes the opposite approach: it assumes continued framework use and simply externalizes only the non-portable parts. Declarative UI, reactive rendering, and framework-specific ecosystems can all be enjoyed as-is.

## Practical Operational Benefits

### Incremental Adoption

There is no need for a full upfront migration of existing applications. Teams can start by writing only new API calls as headless Web Components and gradually move async processing outside the framework. Thanks to the spec's initial value sync behavior, calling `bind()` partway through correctly picks up existing state, so coexistence with legacy code is not a problem.

### Virtually Eliminated OSS Dependency Risk

Because the total codebase across all packages is extremely small, the typical OSS dependency risk — "what if the community stops maintaining it?" — is nearly nonexistent. It can be forked, read, fixed, and maintained. At the extreme, running an internal company fork is entirely manageable given the codebase's size.

Teams do not need to wait for the ecosystem to reach critical mass (an abundance of protocol-compatible components) for the migration motivation to be compelling for their own service. The smallness of the protocol itself dramatically lowers the barrier to adoption.

### The Headless Insight

By treating Web Components not as "visible UI parts" but as an "async service layer," the styling problems associated with Shadow DOM — historically one of the biggest barriers to Web Component adoption — are sidestepped entirely. Headless components have no DOM and no styles, so the Shadow DOM boundary simply never becomes an issue.

## Conclusion

What HAWC and wc-bindable-protocol provide is not a replacement for frameworks, but a structure that is free from framework dependency.

Its central rule is simple: keep decisions in the Core, and keep only undelegatable execution in the Shell. Sometimes that yields a runtime-portable Core and a nearly invisible Shell. Sometimes it yields a remote proxy. Sometimes it yields a browser-side execution engine for a browser-anchored data plane. All three are legitimate HAWC shapes.

A zero-dependency protocol design relying solely on Web standards, adapters that fit in a few dozen lines, and async processing encapsulated in headless Web Components — with the Core (EventTarget) owning the authoritative state machine, the Shell (HTMLElement) crossing framework boundaries, and `@wc-bindable/remote` crossing network boundaries — together, these form a practical and durable escape from frontend framework lock-in.

## Reference

- wc-bindable-protocol: https://github.com/wc-bindable-protocol/wc-bindable-protocol