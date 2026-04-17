# @wc-bindable/hawc-ai

`@wc-bindable/hawc-ai` is a headless AI inference component built on wc-bindable-protocol.

It is not a visual UI widget.
It is an **I/O node** that connects LLM inference to reactive state — with first-class streaming support.

- **input / command surface**: `prompt`, `trigger`, `model`, `provider`
- **output state surface**: `content`, `messages`, `usage`, `loading`, `streaming`, `error`

This means chat UIs and AI-powered features can be expressed declaratively, without writing fetch calls, SSE parsing, token management, or streaming glue code in your UI layer.

`@wc-bindable/hawc-ai` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/docs/articles/HAWC.md) architecture:

- **Core** (`AiCore`) handles provider abstraction, streaming, and conversation state
- **Shell** (`<hawc-ai>`) connects that state to the DOM
- frameworks and binding systems consume it through [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol)

**No provider SDK required.** All providers are implemented with `fetch` + `ReadableStream` + SSE parsing. The only runtime dependencies are `@wc-bindable/core` and `@wc-bindable/remote`.

## Why this exists

Building a chat UI requires significant plumbing:
HTTP requests to provider APIs, SSE stream parsing, content accumulation, token tracking, conversation history management, and abort handling.

`@wc-bindable/hawc-ai` moves all of that into a reusable component and exposes the result as bindable state.

## Install

```bash
npm install @wc-bindable/hawc-ai
```

No peer dependencies required.

## Supported Providers

| Provider | `provider` value | Default base URL | Model catalog |
|----------|-----------------|------------------|---------------|
| OpenAI | `"openai"` | `https://api.openai.com` | [platform.openai.com/docs/models](https://platform.openai.com/docs/models) |
| Anthropic | `"anthropic"` | `https://api.anthropic.com` | [docs.anthropic.com/en/docs/about-claude/models](https://docs.anthropic.com/en/docs/about-claude/models) |
| Azure OpenAI | `"azure-openai"` | (required via `base-url`) | [learn.microsoft.com/.../openai/concepts/models](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models) |
| Google (Gemini) | `"google"` | `https://generativelanguage.googleapis.com` | [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) |

`<hawc-ai>` intentionally does **not** ship a default model per provider. Model identifiers drift faster than library releases, pricing tiers vary per account, and "latest" is not well-defined (e.g. `gpt-4o` vs `gpt-4.1` vs `o3` are different trade-offs, not versions of one thing). Pick the current model name from the catalog above for your target provider and set it via the `model` attribute or property.

OpenAI-compatible APIs (Ollama, vLLM, LiteLLM, etc.) work with `provider="openai"` and a custom `base-url`; consult each service's own model list (e.g. `ollama list`, your LiteLLM config) for valid `model` values.

## Quick Start

### Setup

Choose one of the following to register the custom elements:

```js
// Option A: Auto-register (side-effect import)
import "@wc-bindable/hawc-ai/auto";

// Option B: Manual bootstrap
import { bootstrapAi } from "@wc-bindable/hawc-ai";
bootstrapAi();
```

### 1. Backend proxy (recommended production pattern)

Point `base-url` at your own endpoint. `<hawc-ai>` issues requests via the browser's standard `fetch`, so cookie/session credentials flow automatically — the proxy validates the user, injects the server-side API key, and forwards to the provider. **No API key in the browser, no custom auth header wiring.**

```html
<hawc-ai
  provider="openai"
  model="gpt-4o"
  base-url="/api/ai">
</hawc-ai>
```

This is the baseline shape used by the rest of the examples in this section and fits cleanly on top of existing HTTP proxy / API-gateway infrastructure. **If you are building the backend from scratch**, compare against [Remote Mode](#remote-mode) — the server-side implementation is often smaller there because `AiCore` provides provider abstraction, SSE parsing, and abort propagation out of the box.

### 2. Non-streaming request

Add `no-stream` to disable streaming and receive the complete response at once:

```html
<hawc-ai
  provider="openai"
  model="gpt-4o"
  base-url="/api/ai"
  no-stream>
</hawc-ai>
```

### 3. Anthropic provider

```html
<hawc-ai
  provider="anthropic"
  model="claude-sonnet-4-20250514"
  base-url="/api/anthropic"
  max-tokens="4096">
  <hawc-ai-message role="system">You are a concise coding assistant.</hawc-ai-message>
</hawc-ai>
```

Anthropic's system message format is handled automatically — the provider extracts system messages and places them in the top-level `system` field.

### 4. Local model via Ollama

```html
<hawc-ai
  provider="openai"
  model="llama3"
  base-url="http://localhost:11434">
</hawc-ai>
```

Any OpenAI-compatible API works by setting `base-url`.

### 5. Azure OpenAI

```html
<hawc-ai
  provider="azure-openai"
  model="gpt-4o"
  base-url="/api/azure"
  api-version="2024-02-01">
</hawc-ai>
```

The URL is constructed as `{base-url}/openai/deployments/{model}/chat/completions?api-version={api-version}`. In production, `base-url` points to your proxy, which forwards to `https://<resource>.openai.azure.com` with the server-held `api-key`. For local development only, you can point directly at the Azure resource and set `api-key="..."` — the same DOM-exposure caveat as any other provider applies.

### 6. Google (Gemini)

```html
<hawc-ai
  provider="google"
  model="gemini-2.5-flash"
  base-url="/api/gemini">
  <hawc-ai-message role="system">You are a concise coding assistant.</hawc-ai-message>
</hawc-ai>
```

System messages are extracted and placed in the top-level `systemInstruction` field. The assistant turn uses the role `model` on the wire — `<hawc-ai>` translates to/from `assistant` automatically so `messages` state stays consistent with the other providers. Gemini support is currently **text-only**; multi-modal `parts` (images, audio, video) are not exposed through `AiMessage`.

### 7. Development-only: API key on the element

For local prototyping you can put the key directly on the element. It is visible in the DOM, the network panel, and any framework state bound to the element. **Never ship this shape to production** — switch to section 1 (backend proxy) or [Remote Mode](#remote-mode) before deploying:

```html
<hawc-ai
  provider="openai"
  model="gpt-4o"
  api-key="sk-...">
</hawc-ai>
```

## State Surface vs Command Surface

`<hawc-ai>` exposes two different kinds of properties.

### Output state (bindable async state)

These properties represent the current inference state and are the main HAWC surface:

| Property | Type | Description |
|----------|------|-------------|
| `content` | `string` | Current response text. **Updates on every streaming chunk** (~60fps via rAF batching) |
| `messages` | `AiMessage[]` | Full conversation history (user + assistant). Updated on send and completion |
| `usage` | `AiUsage \| null` | Token usage `{ promptTokens, completionTokens, totalTokens }` |
| `loading` | `boolean` | `true` from send to completion or error |
| `streaming` | `boolean` | `true` from stream start (after HTTP response headers) to stream completion |
| `error` | `AiHttpError \| Error \| null` | Error info |

### Input / command surface

These properties control inference execution:

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `"openai" \| "anthropic" \| "azure-openai" \| "google"` | Provider selection |
| `model` | `string` | Model name (or Azure deployment name) |
| `base-url` | `string` | API endpoint (for proxies, local models, Azure) |
| `api-key` | `string` | API key (development only — use a backend proxy in production) |
| `system` | `string` | System message (shortcut, attribute) |
| `prompt` | `string` | User input text (JS property) |
| `trigger` | `boolean` | One-way send trigger |
| `no-stream` | `boolean` | Disable streaming |
| `temperature` | `number` | Generation temperature |
| `max-tokens` | `number` | Maximum output tokens |
| `api-version` | `string` | Azure OpenAI API version (default `2024-02-01`) |

## Architecture

`@wc-bindable/hawc-ai` follows the HAWC architecture.

### Core: `AiCore`

`AiCore` is a pure `EventTarget` class.
It contains:

- provider-agnostic HTTP execution
- SSE stream parsing and content accumulation
- rAF-batched content event emission (~60fps)
- conversation history management
- abort control
- `wc-bindable-protocol` declaration

### Shell: `<hawc-ai>`

`<hawc-ai>` is a thin `HTMLElement` wrapper around `AiCore`.
It adds:

- attribute / property mapping
- DOM lifecycle integration
- child element collection (`<hawc-ai-message>`)
- declarative execution helpers such as `trigger`

### Providers

Providers implement the `IAiProvider` interface, translating between the unified internal format and each API's specific request/response shapes:

```typescript
interface IAiProvider {
  buildRequest(messages, options): { url, headers, body };
  parseResponse(data): { content, usage? };
  parseStreamChunk(event, data): { delta?, usage?, done } | null;
}
```

`AzureOpenAiProvider` extends `OpenAiProvider`, overriding only `buildRequest` for Azure-specific URL and header construction.

### Target injection

The Core dispatches events directly on the Shell via **target injection**, so no event re-dispatch is needed.

### Streaming pipeline

```
fetch → ReadableStream → TextDecoder → SseParser → Provider.parseStreamChunk
                                                          ↓
                                               content accumulation
                                                          ↓
                                              rAF batching (~60fps)
                                                          ↓
                                         hawc-ai:content-changed event
                                                          ↓
                                         wc-bindable-protocol binding
```

## Headless Usage (Core only)

`AiCore` can be used without the Shell element:

```typescript
import { AiCore } from "@wc-bindable/hawc-ai";
import { bind } from "@wc-bindable/core";

const core = new AiCore();
core.provider = "openai";

const unbind = bind(core, (name, value) => {
  if (name === "content") process.stdout.write(value);
});

await core.send("Explain quantum computing in one paragraph.", {
  model: "gpt-4o",
  baseUrl: "/api/ai",
});

console.log("\n---");
console.log("Tokens:", core.usage);
console.log("History:", core.messages);

unbind();
```

### Custom provider

```typescript
import { AiCore } from "@wc-bindable/hawc-ai";

const core = new AiCore();
core.provider = {
  buildRequest(messages, options) {
    return {
      url: `${options.baseUrl}/v1/generate`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: messages.at(-1)?.content, model: options.model }),
    };
  },
  parseResponse(data) {
    return { content: data.text };
  },
  parseStreamChunk(_event, data) {
    if (data === "[DONE]") return { done: true };
    try {
      const parsed = JSON.parse(data);
      return { delta: parsed.token, done: false };
    } catch { return null; }
  },
};
```

## Conversation History

`AiCore` owns the conversation history. Each `send()` call:

1. appends `{ role: "user", content: prompt }` to messages
2. on success, appends `{ role: "assistant", content }` to messages
3. on error, removes the user message (keeps history clean for retry)

Read and write the history via the `messages` property:

```javascript
const aiEl = document.querySelector("hawc-ai");

// Read history
console.log(aiEl.messages);

// Clear history
aiEl.messages = [];

// Restore from saved state
aiEl.messages = savedMessages;
```

## Abort

In-flight requests can be aborted:

```javascript
const aiEl = document.querySelector("hawc-ai");
aiEl.abort(); // Cancels streaming or pending request
```

A new `send()` call automatically aborts any previous request.

## Programmatic Usage

```javascript
const aiEl = document.querySelector("hawc-ai");

// Set prompt and send
aiEl.prompt = "What is the meaning of life?";
const result = await aiEl.send();

console.log(result);          // Complete response text
console.log(aiEl.content);    // Same as result
console.log(aiEl.messages);   // Conversation history
console.log(aiEl.usage);      // { promptTokens, completionTokens, totalTokens }
console.log(aiEl.loading);    // false
console.log(aiEl.streaming);  // false
```

## Input Validation

`<hawc-ai>` and `AiCore` validate request parameters up front so that bad values surface as immediate errors instead of provider `400` responses or silent NaN payloads.

| Option | Accepted | Rejected |
|--------|----------|----------|
| `temperature` | any finite `number` | `NaN`, `±Infinity` |
| `max-tokens` / `maxTokens` | positive integer (`>= 1`) | `0`, negative, `NaN`, non-integer (e.g. `1.5`) |
| `provider` (attribute) | `"openai" \| "anthropic" \| "azure-openai" \| "google"` | anything else |

Behavior on invalid input:

- `core.send()` throws `Error("... temperature must be a finite number, got ...")` / `Error("... maxTokens must be a positive integer, got ...")` synchronously.
- `<hawc-ai>` `send()` rejects with the same error; no HTTP request is dispatched.
- `<hawc-ai>` `provider` attribute: `setAttribute("provider", "bogus")` does **not** throw through `attributeChangedCallback`. The previous request is halted, `el.error` is populated, and any subsequent `send()` rejects until the attribute is corrected. The DOM attribute stays as the user wrote it for inspectability.
- Providers invoked directly (`new OpenAiProvider().buildRequest(...)`) apply the same validation, so every path is consistent.

## Optional DOM Triggering

If `autoTrigger` is enabled (default), clicking an element with `data-aitarget` triggers the corresponding `<hawc-ai>` element's `send()`:

```html
<button data-aitarget="chat">Send</button>
<hawc-ai id="chat" provider="openai" model="gpt-4o" base-url="/api/ai"></hawc-ai>
```

Event delegation is used — works with dynamically added elements.

## Elements

### `<hawc-ai>`

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `provider` | `string` | — | `"openai"`, `"anthropic"`, `"azure-openai"`, or `"google"` |
| `model` | `string` | — | Model name or Azure deployment name |
| `base-url` | `string` | — | API endpoint URL |
| `api-key` | `string` | — | API key (development only) |
| `system` | `string` | — | System message (shortcut) |
| `no-stream` | `boolean` | `false` | Disable streaming |
| `temperature` | `number` | — | Generation temperature |
| `max-tokens` | `number` | — | Maximum output tokens |
| `api-version` | `string` | `2024-02-01` | Azure OpenAI API version |

| Property | Type | Description |
|----------|------|-------------|
| `content` | `string` | Current response (streams in real-time) |
| `messages` | `AiMessage[]` | Conversation history (read/write) |
| `usage` | `AiUsage \| null` | Token usage |
| `loading` | `boolean` | `true` while request is active |
| `streaming` | `boolean` | `true` while receiving chunks |
| `error` | `AiHttpError \| Error \| null` | Error info |
| `prompt` | `string` | User input text |
| `trigger` | `boolean` | Set to `true` to send |

| Method | Description |
|--------|-------------|
| `send()` | Send the current `prompt` |
| `abort()` | Cancel the in-flight request |

### `<hawc-ai-message>`

Defines the system prompt declaratively. Place it as the first child of `<hawc-ai>`.
If the `system` attribute is set on `<hawc-ai>`, the attribute takes priority and this element is ignored.

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `role` | `string` | `system` | Must be `system` |

The message content is taken from the element's text content. Shadow DOM suppresses rendering.
Only the first `<hawc-ai-message>` with `role="system"` is used.

```html
<hawc-ai provider="openai" model="gpt-4o" base-url="/api/ai">
  <hawc-ai-message role="system">
    You are a helpful coding assistant.
    Always provide TypeScript examples.
  </hawc-ai-message>
</hawc-ai>
```

## wc-bindable-protocol

Both `AiCore` and `<hawc-ai>` declare `wc-bindable-protocol` compliance.

### Core (`AiCore`)

```typescript
static wcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "content",   event: "hawc-ai:content-changed" },
    { name: "messages",  event: "hawc-ai:messages-changed" },
    { name: "usage",     event: "hawc-ai:usage-changed" },
    { name: "loading",   event: "hawc-ai:loading-changed" },
    { name: "streaming", event: "hawc-ai:streaming-changed" },
    { name: "error",     event: "hawc-ai:error" },
  ],
};
```

### Shell (`<hawc-ai>`)

```typescript
static wcBindable = {
  ...AiCore.wcBindable,
  properties: [
    ...AiCore.wcBindable.properties,
    { name: "trigger", event: "hawc-ai:trigger-changed" },
  ],
};
```

## Framework Integration

Since `<hawc-ai>` is HAWC + `wc-bindable-protocol`, it works with any framework through thin adapters from `@wc-bindable/*`.

### React

```tsx
import { useWcBindable } from "@wc-bindable/react";
import type { WcsAiValues } from "@wc-bindable/hawc-ai";

function Chat() {
  const [ref, { content, messages, loading, streaming }] =
    useWcBindable<HTMLElement, WcsAiValues>();

  return (
    <>
      <hawc-ai ref={ref} provider="openai" model="gpt-4o" base-url="/api/ai" />
      <ul>
        {messages?.map((m, i) => (
          <li key={i} className={m.role}>{m.content}</li>
        ))}
        {streaming && <li className="assistant">{content}</li>}
      </ul>
    </>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { useWcBindable } from "@wc-bindable/vue";
import type { WcsAiValues } from "@wc-bindable/hawc-ai";

const { ref, values } = useWcBindable<HTMLElement, WcsAiValues>();
</script>

<template>
  <hawc-ai :ref="ref" provider="openai" model="gpt-4o" base-url="/api/ai" />
  <ul>
    <li v-for="(m, i) in values.messages" :key="i" :class="m.role">{{ m.content }}</li>
    <li v-if="values.streaming" class="assistant">{{ values.content }}</li>
  </ul>
</template>
```

### Svelte

```svelte
<script>
import { wcBindable } from "@wc-bindable/svelte";

let content = $state("");
let messages = $state([]);
let streaming = $state(false);
</script>

<hawc-ai provider="openai" model="gpt-4o" base-url="/api/ai"
  use:wcBindable={{ onUpdate: (name, v) => {
    if (name === "content") content = v;
    if (name === "messages") messages = v;
    if (name === "streaming") streaming = v;
  }}} />

<ul>
  {#each messages as m, i (i)}
    <li class={m.role}>{m.content}</li>
  {/each}
  {#if streaming}
    <li class="assistant">{content}</li>
  {/if}
</ul>
```

### Vanilla — `bind()` directly

```javascript
import { bind } from "@wc-bindable/core";

const aiEl = document.querySelector("hawc-ai");

bind(aiEl, (name, value) => {
  if (name === "content") {
    document.getElementById("response").textContent = value;
  }
});
```

## Remote Mode

`<hawc-ai>` can run its Core on a different host and drive the Shell in the browser over WebSocket.

Two independent reasons to choose this mode:

1. **You need server-owned state.** Authoritative conversation history, protocol-level rate limiting and quotas, per-user audit logging, or cross-device session continuity. These are difficult to bolt onto a stateless backend proxy.
2. **You are building the backend from scratch.** `AiCore` already implements provider abstraction, SSE parsing, streaming, abort propagation, and the `wc-bindable-protocol` wire format. A remote deployment reuses that on the server and needs ~15 lines of glue (see [Server setup](#server-setup)). Writing a backend proxy from scratch means reimplementing per-provider URL/header/streaming forwarding and abort handling yourself.

### When to stay with a backend proxy instead

- You already have HTTP proxy or API-gateway infrastructure and want `<hawc-ai>` to slot into it. WebSocket deployments have their own operational shape (sticky sessions, idle timeouts, separate scaling), which is only worth it if you gain something from (1) above.
- Your deployment target cannot host long-lived WebSocket connections (some serverless platforms, CDN-fronted edge functions).
- You only need to keep the API key out of the browser. Either mode does that — pick by infrastructure fit, not by the API-key requirement alone.

```
browser                                         server
┌────────────────────┐    WebSocket    ┌───────────────────────┐
│ <hawc-ai>  (Shell) │  ─────────────▶ │ RemoteShellProxy      │
│ RemoteCoreProxy    │  ◀───────────── │  ↕                    │
└────────────────────┘                 │ AiCore → fetch(LLM)   │
                                       └───────────────────────┘
```

The Shell exposes the same surface — `prompt`, `model`, `content`, `messages`, `error`, `send()`, `abort()` — whether the Core is local or remote. `provider` / `model` / streaming state / conversation history are all synced through `wc-bindable-protocol`.

### Enable remote mode

Set the `remote` config before calling `bootstrapAi()` (or before the first `<hawc-ai>` connects):

```js
import { bootstrapAi } from "@wc-bindable/hawc-ai";

bootstrapAi({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: "wss://example.com/hawc-ai",
  },
});
```

Or load the environment-resolving auto entrypoint (see below) and skip `bootstrapAi()`:

```js
import "@wc-bindable/hawc-ai/auto/remoteEnv";
```

### `remoteSettingType`

| Value | Resolution order for `remoteCoreUrl` |
|-------|--------------------------------------|
| `"config"` (default) | Uses the literal `remoteCoreUrl` string you pass in. |
| `"env"` | `globalThis.process?.env?.AI_REMOTE_CORE_URL` → `globalThis.AI_REMOTE_CORE_URL` → `""`. Good for Node bundler replacement (Vite `define`, webpack `DefinePlugin`) or `<script>window.AI_REMOTE_CORE_URL = "..."</script>` before the first `<hawc-ai>` connects. |

### Error surface

Remote-mode failures are exposed through the same `hawc-ai:error` event and `el.error` getter as local mode. Two classes of failures are surfaced locally even though they originate outside the server's `AiCore`:

- **Connection failures.** Initial failure fires `hawc-ai:error` with `Error("... WebSocket connection failed: <url>")`; a drop after `open` uses `"connection lost"`. If the server had synced `loading`/`streaming`=`true`, they are reset to `false` so the UI does not stay busy.
- **Transport-layer errors during `send()`.** Timeouts, disposed proxies, and raw `DOMException` from `WebSocket.send` are treated as transport failures: `el.send()` resolves to `null`, `el.error` is populated, `loading`/`streaming` are reset. Server-side business errors (validation, provider 4xx/5xx) are re-thrown to match local-mode contract.

### `remoteCoreUrl` is required when enabled

Setting `enableRemote: true` with an empty URL does not throw out of `appendChild`. Instead, `connectedCallback` catches the initialization error, fires `hawc-ai:error`, and exposes the same `Error` through `el.error`.

### Auto entrypoints

| Entrypoint | Behavior |
|------------|----------|
| `@wc-bindable/hawc-ai/auto` | Registers the custom elements with default (local) config. |
| `@wc-bindable/hawc-ai/auto/remoteEnv` | Registers the custom elements and enables remote mode with `remoteSettingType: "env"`. `AI_REMOTE_CORE_URL` is resolved when a `<hawc-ai>` element initializes its remote connection. |

### Server setup

`@wc-bindable/hawc-ai` does **not** ship a server helper — `AiCore` itself runs unchanged on the server. Wire it to the browser by pairing it with `RemoteShellProxy` + `WebSocketServerTransport` from `@wc-bindable/remote`.

#### Minimal example (Node + `ws`)

```ts
import { WebSocketServer } from "ws";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import { AiCore } from "@wc-bindable/hawc-ai";

const wss = new WebSocketServer({ port: 8080, path: "/hawc-ai" });

wss.on("connection", (ws) => {
  const core = new AiCore();
  const transport = new WebSocketServerTransport(ws);
  const shell = new RemoteShellProxy(core, transport);

  ws.on("close", () => {
    core.abort();      // cancel any in-flight inference
    shell.dispose();   // unbind and release the Core
  });
});
```

Point the browser at `wss://<host>:8080/hawc-ai` via `remoteCoreUrl`. Instantiate `AiCore` **per connection** — `AiCore` owns conversation history, in-flight `AbortController`, and streaming state, and must not be shared across sessions.

#### Injecting the provider API key server-side

This is the whole reason to run remote. `<hawc-ai>.send()` in remote mode forwards `{ model, apiKey, baseUrl, apiVersion, ... }` from the DOM element to the server as `send` command arguments ([components/Ai.ts:383-392](src/components/Ai.ts#L383-L392)). In a hardened deployment the browser has no `api-key` attribute, so the incoming `apiKey` is `""` — the server must override it before calling the provider:

```ts
class ServerAiCore extends AiCore {
  override async send(prompt: string, options: AiRequestOptions): Promise<string | null> {
    return super.send(prompt, {
      ...options,
      apiKey: process.env.OPENAI_API_KEY!,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
    });
  }
}

// wss.on("connection", ws => { const core = new ServerAiCore(); ... })
```

Also consider pinning `model` / `provider` / `maxTokens` server-side when the browser value is not trusted — the client can set any value it wants, and the server is the last line of defense for cost and quota controls.

#### Authenticated deployments (pair with `<hawc-auth0>`)

A public WebSocket endpoint that dispenses LLM tokens is a direct cost vector. Production deployments should gate the Core on an authenticated handshake. The recommended pattern is to combine `<hawc-auth0>` in remote mode with `createAuthenticatedWSS` from `@wc-bindable/hawc-auth0/server`, and use its `createCores` hook to construct `ServerAiCore` only after token verification:

```ts
import { createAuthenticatedWSS } from "@wc-bindable/hawc-auth0/server";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";

createAuthenticatedWSS({
  auth0Domain: "example.auth0.com",
  auth0Audience: "https://api.example.com",
  allowedOrigins: ["https://app.example.com"],
  createCores: (user, ws) => {
    const core = new ServerAiCore();  // user identity / quotas can be captured in closure
    const transport = new WebSocketServerTransport(ws);
    const shell = new RemoteShellProxy(core, transport);
    ws.on("close", () => { core.abort(); shell.dispose(); });
    return { core };
  },
});
```

See [@wc-bindable/hawc-auth0 README-REMOTE.md](../hawc-auth0/README-REMOTE.md#server-side) and [SPEC-REMOTE.md](../hawc-auth0/SPEC-REMOTE.md) for the `createAuthenticatedWSS` handler options, handshake error codes, and the `auth:refresh` contract used when Auth0 access tokens expire mid-session.

#### Cleanup checklist

- `ws.on("close", ...)` → `core.abort()` then `shell.dispose()`. Without `abort()`, an in-flight `fetch` keeps running until the provider responds and racks up token cost for a client who is already gone.
- Do not reuse a `RemoteShellProxy` or `AiCore` across reconnects — the client's fresh WebSocket triggers a new `connection` event, and a new Core/proxy pair is cheap.
- If you front the WebSocket with a reverse proxy (nginx, CloudFront, ALB), raise the idle timeout above your longest expected streaming response — provider completions can run for minutes under high `max_tokens`.

## Configuration

```javascript
import { bootstrapAi } from "@wc-bindable/hawc-ai";

bootstrapAi({
  autoTrigger: true,
  triggerAttribute: "data-aitarget",
  tagNames: {
    ai: "hawc-ai",
    aiMessage: "hawc-ai-message",
  },
  remote: {
    enableRemote: false,         // true で WebSocket 経由の remote Core に切り替え
    remoteSettingType: "config", // "config" | "env"
    remoteCoreUrl: "",           // "config" の時に使われる URL
  },
});
```

## TypeScript Types

```typescript
import type {
  IAiProvider, AiMessage, AiUsage, AiRequestOptions,
  AiProviderRequest, AiStreamChunkResult,
  AiHttpError, WcsAiCoreValues, WcsAiValues
} from "@wc-bindable/hawc-ai";
```

```typescript
interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface AiHttpError {
  status: number;
  statusText: string;
  body: string;
}

interface WcsAiCoreValues {
  content: string;
  messages: AiMessage[];
  usage: AiUsage | null;
  loading: boolean;
  streaming: boolean;
  error: AiHttpError | Error | null;
}

interface WcsAiValues extends WcsAiCoreValues {
  trigger: boolean;
}
```

## Provider Details

### OpenAI

- Endpoint: `{base-url}/v1/chat/completions`
- Auth: `Authorization: Bearer {api-key}`
- Streaming: SSE with `data: {"choices":[{"delta":{"content":"..."}}]}` and `data: [DONE]`
- Usage: `stream_options: { include_usage: true }` requests usage in the final chunk

### Anthropic

- Endpoint: `{base-url}/v1/messages`
- Auth: `x-api-key: {api-key}`, `anthropic-version: 2023-06-01`
- System: extracted from messages and placed in top-level `system` field
- Streaming: SSE with event types (`content_block_delta`, `message_start`, `message_delta`, `message_stop`)
- Usage: `input_tokens` from `message_start`, `output_tokens` from `message_delta` — merged by Core
- Default `max_tokens`: 4096

### Azure OpenAI

- Endpoint: `{base-url}/openai/deployments/{model}/chat/completions?api-version={api-version}`
- Auth: `api-key: {api-key}`
- Request/response format: same as OpenAI (inherits `parseResponse` and `parseStreamChunk`)

### Google (Gemini)

- Endpoint: `{base-url}/v1beta/models/{model}:generateContent` (non-stream) or `:streamGenerateContent?alt=sse` (stream)
- Auth: `x-goog-api-key: {api-key}`
- Role translation: `assistant` → `model` on request; Gemini's `model` role is parsed back to `assistant` on response
- System: extracted from messages and placed in top-level `systemInstruction.parts[].text`
- Streaming: SSE with `data: {...}` JSON chunks; terminal chunk carries `candidates[0].finishReason` (e.g. `STOP`, `MAX_TOKENS`, `SAFETY`) and is signalled as `done`
- Usage: `usageMetadata.promptTokenCount` / `candidatesTokenCount` / `totalTokenCount`
- Scope: text-only. Multi-modal `parts` (images, audio, video) are not currently supported — `AiMessage.content` is `string`. Vertex AI (OAuth, region-specific endpoints) is out of scope; point `base-url` at a proxy if you need it.

## Security

> The `api-key` attribute is exposed in the DOM and is intended for **development and prototyping only**.
> In production, use `base-url` to point to a backend proxy that handles authentication server-side.

```html
<!-- Development -->
<hawc-ai provider="openai" model="gpt-4o" api-key="sk-..." />

<!-- Production (recommended) -->
<hawc-ai provider="openai" model="gpt-4o" base-url="/api/ai" />
```

## Design Notes

- `content`, `messages`, `usage`, `loading`, `streaming`, and `error` are **output state**
- `prompt`, `trigger`, `provider`, `model` are **input / command surface**
- `trigger` is intentionally one-way: writing `true` executes send, reset emits completion
- `content` updates are batched via `requestAnimationFrame` — each rAF cycle emits at most one `hawc-ai:content-changed` event, limiting DOM updates to ~60fps even under high-throughput streaming
- on error, the user message is removed from history to keep it clean for retry
- a new `send()` automatically aborts any in-flight request
- `messages` is both readable (output state) and writable (for history reset/restore)
- `system` attribute takes priority over `<hawc-ai-message role="system">`
- Anthropic's `max_tokens` defaults to 4096 if not specified
- Google (Gemini) uses distinct endpoints for streaming (`:streamGenerateContent?alt=sse`) vs non-streaming (`:generateContent`); the `assistant` role is translated to `model` on the wire; stream end is signalled by `candidates[0].finishReason` rather than a `[DONE]` sentinel; currently text-only (no multi-modal `parts`)
- no provider SDK required — all providers use `fetch` + `ReadableStream` + SSE parsing directly

## License

MIT
