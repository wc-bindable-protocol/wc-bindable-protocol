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

| Provider | `provider` value | Default base URL |
|----------|-----------------|------------------|
| OpenAI | `"openai"` | `https://api.openai.com` |
| Anthropic | `"anthropic"` | `https://api.anthropic.com` |
| Azure OpenAI | `"azure-openai"` | (required via `base-url`) |

OpenAI-compatible APIs (Ollama, vLLM, LiteLLM, etc.) work with `provider="openai"` and a custom `base-url`.

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

### 1. Non-streaming request

Add `no-stream` to disable streaming and receive the complete response at once:

```html
<hawc-ai
  provider="openai"
  model="gpt-4o"
  base-url="/api/ai"
  no-stream>
</hawc-ai>
```

### 2. Anthropic provider

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

### 3. Azure OpenAI

```html
<hawc-ai
  provider="azure-openai"
  model="gpt-4o"
  base-url="https://myresource.openai.azure.com"
  api-key="your-azure-key"
  api-version="2024-02-01">
</hawc-ai>
```

The URL is constructed as `{base-url}/openai/deployments/{model}/chat/completions?api-version={api-version}`.

### 4. Local model via Ollama

```html
<hawc-ai
  provider="openai"
  model="llama3"
  base-url="http://localhost:11434">
</hawc-ai>
```

Any OpenAI-compatible API works by setting `base-url`.

### 5. Authenticated requests via backend proxy

`<hawc-ai>` sends requests to `base-url` using the browser's standard `fetch`. If your backend proxy uses cookie/session-based authentication, the browser includes credentials automatically:

```html
<hawc-ai
  provider="openai"
  model="gpt-4o"
  base-url="/api/ai">
</hawc-ai>
```

The backend proxy at `/api/ai` validates the user's session and forwards the request to the AI provider with the server-side API key. This is the recommended production pattern — no API key in the browser, no custom auth header injection needed.

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
| `provider` | `"openai" \| "anthropic" \| "azure-openai"` | Provider selection |
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
| `provider` (attribute) | `"openai" \| "anthropic" \| "azure-openai"` | anything else |

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
| `provider` | `string` | — | `"openai"`, `"anthropic"`, or `"azure-openai"` |
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

`<hawc-ai>` can run its Core on a different host and drive the Shell in the browser over WebSocket. This keeps the provider API key entirely server-side (no `api-key` attribute in the DOM, no backend proxy path) and lets you centralize conversation state / rate limiting / audit logging.

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
| `"env"` | `globalThis.process?.env?.AI_REMOTE_CORE_URL` → `globalThis.AI_REMOTE_CORE_URL` → `""`. Good for Node bundler replacement (Vite `define`, webpack `DefinePlugin`) or `<script>window.AI_REMOTE_CORE_URL = "..."</script>` prior to module load. |

### Error surface

Remote-mode failures are exposed through the same `hawc-ai:error` event and `el.error` getter as local mode. Two classes of failures are surfaced locally even though they originate outside the server's `AiCore`:

- **Connection failures.** Initial failure fires `hawc-ai:error` with `Error("... WebSocket connection failed: <url>")`; a drop after `open` uses `"connection lost"`. If the server had synced `loading`/`streaming`=`true`, they are reset to `false` so the UI does not stay busy.
- **Transport-layer errors during `send()`.** Timeouts, disposed proxies, and raw `DOMException` from `WebSocket.send` are treated as transport failures: `el.send()` resolves to `null`, `el.error` is populated, `loading`/`streaming` are reset. Server-side business errors (validation, provider 4xx/5xx) are re-thrown to match local-mode contract.

### `remoteCoreUrl` is required when enabled

Setting `enableRemote: true` with an empty URL raises a synchronous `Error` from `connectedCallback` and fires `hawc-ai:error` on the element (the element does not throw out of `appendChild`).

### Auto entrypoints

| Entrypoint | Behavior |
|------------|----------|
| `@wc-bindable/hawc-ai/auto` | Registers the custom elements with default (local) config. |
| `@wc-bindable/hawc-ai/auto/remoteEnv` | Registers the custom elements and enables remote mode with `remoteSettingType: "env"` — resolves `AI_REMOTE_CORE_URL` at import time. |

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
- no provider SDK required — all providers use `fetch` + `ReadableStream` + SSE parsing directly

## License

MIT
