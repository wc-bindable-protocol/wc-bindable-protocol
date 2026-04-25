# @wc-bindable/ai

`@wc-bindable/ai` is a headless AI inference component built on wc-bindable-protocol.

It is not a visual UI widget.
It is an **I/O node** that connects LLM inference to reactive state — with first-class streaming support.

- **input / command surface**: `prompt`, `trigger`, `model`, `provider`
- **output state surface**: `content`, `messages`, `usage`, `loading`, `streaming`, `error`

This means chat UIs and AI-powered features can be expressed declaratively, without writing fetch calls, SSE parsing, token management, or streaming glue code in your UI layer.

`@wc-bindable/ai` follows the [HAWC](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/packages/hawc/README.md) architecture:

- **Core** (`AiCore`) handles provider abstraction, streaming, and conversation state
- **Shell** (`<ai-agent>`) is a thin, command-mediating browser surface: it exposes bindable state locally, forwards commands to the Core, and can proxy a remote Core over the wire
- frameworks and binding systems consume it through [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol)

In the taxonomy used by the HAWC architecture document, this is the **Case B1** shape: Core on the server in remote deployments, thin Shell in the browser, with the Shell acting as a command surface rather than a pure observation wrapper.

**No provider SDK required.** All providers are implemented with `fetch` + `ReadableStream` + SSE parsing. The only runtime dependencies are `@wc-bindable/core` and `@wc-bindable/remote`.

## Table of contents

- [Why this exists](#why-this-exists)
- [Install](#install)
- [Supported Providers](#supported-providers)
- [Quick Start](#quick-start)
- [State Surface vs Command Surface](#state-surface-vs-command-surface)
- [Architecture](#architecture)
- [Headless Usage (Core only)](#headless-usage-core-only)
- [Conversation History](#conversation-history)
- [Tool use](#tool-use)
- [Structured output](#structured-output)
- [Multimodal](#multimodal)
- [Abort](#abort)
- [Programmatic Usage](#programmatic-usage)
- [Input Validation](#input-validation)
- [Optional DOM Triggering](#optional-dom-triggering)
- [Elements](#elements)
- [wc-bindable-protocol](#wc-bindable-protocol)
- [Framework Integration](#framework-integration)
- [Remote Mode](#remote-mode)
- [Configuration](#configuration)
- [TypeScript Types](#typescript-types)
- [Provider Details](#provider-details)
- [Security](#security)
- [Error contract](#error-contract)
- [Design Notes](#design-notes)
- [License](#license)

## Why this exists

Building a chat UI requires significant plumbing:
HTTP requests to provider APIs, SSE stream parsing, content accumulation, token tracking, conversation history management, and abort handling.

`@wc-bindable/ai` moves all of that into a reusable component and exposes the result as bindable state.

## Install

```bash
npm install @wc-bindable/ai
```

No peer dependencies required.

## Supported Providers

| Provider | `provider` value | Default base URL | Model catalog |
|----------|-----------------|------------------|---------------|
| OpenAI | `"openai"` | `https://api.openai.com` | [platform.openai.com/docs/models](https://platform.openai.com/docs/models) |
| Anthropic | `"anthropic"` | `https://api.anthropic.com` | [docs.anthropic.com/en/docs/about-claude/models](https://docs.anthropic.com/en/docs/about-claude/models) |
| Azure OpenAI | `"azure-openai"` | (required via `base-url`) | [learn.microsoft.com/.../openai/concepts/models](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models) |
| Google (Gemini) | `"google"` | `https://generativelanguage.googleapis.com` | [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) |

`<ai-agent>` intentionally does **not** ship a default model per provider. Model identifiers drift faster than library releases, pricing tiers vary per account, and "latest" is not well-defined (e.g. `gpt-4o` vs `gpt-4.1` vs `o3` are different trade-offs, not versions of one thing). Pick the current model name from the catalog above for your target provider and set it via the `model` attribute or property.

OpenAI-compatible APIs (Ollama, vLLM, LiteLLM, etc.) work with `provider="openai"` and a custom `base-url`; consult each service's own model list (e.g. `ollama list`, your LiteLLM config) for valid `model` values.

## Quick Start

### Setup

Choose one of the following to register the custom elements:

```js
// Option A: Auto-register (side-effect import)
import "@wc-bindable/ai/auto";

// Option B: Manual bootstrap
import { bootstrapAi } from "@wc-bindable/ai";
bootstrapAi();
```

### 1. Backend proxy (recommended production pattern)

Point `base-url` at your own endpoint. `<ai-agent>` issues requests via the browser's standard `fetch`, so cookie/session credentials flow automatically — the proxy validates the user, injects the server-side API key, and forwards to the provider. **No API key in the browser, no custom auth header wiring.**

```html
<ai-agent
  provider="openai"
  model="gpt-4o"
  base-url="/api/ai">
</ai-agent>
```

This is the baseline shape used by the rest of the examples in this section and fits cleanly on top of existing HTTP proxy / API-gateway infrastructure. **If you are building the backend from scratch**, compare against [Remote Mode](#remote-mode) — the server-side implementation is often smaller there because `AiCore` provides provider abstraction, SSE parsing, and abort propagation out of the box.

### 2. Non-streaming request

Add `no-stream` to disable streaming and receive the complete response at once:

```html
<ai-agent
  provider="openai"
  model="gpt-4o"
  base-url="/api/ai"
  no-stream>
</ai-agent>
```

### 3. Anthropic provider

```html
<ai-agent
  provider="anthropic"
  model="claude-sonnet-4-20250514"
  base-url="/api/anthropic"
  max-tokens="4096">
  <ai-message role="system">You are a concise coding assistant.</ai-message>
</ai-agent>
```

Anthropic's system message format is handled automatically — the provider extracts system messages and places them in the top-level `system` field.

### 4. Local model via Ollama

```html
<ai-agent
  provider="openai"
  model="llama3"
  base-url="http://localhost:11434">
</ai-agent>
```

Any OpenAI-compatible API works by setting `base-url`.

### 5. Azure OpenAI

```html
<ai-agent
  provider="azure-openai"
  model="gpt-4o"
  base-url="/api/azure"
  api-version="2024-02-01">
</ai-agent>
```

The URL is constructed as `{base-url}/openai/deployments/{model}/chat/completions?api-version={api-version}`. In production, `base-url` points to your proxy, which forwards to `https://<resource>.openai.azure.com` with the server-held `api-key`. For local development only, you can point directly at the Azure resource and set `api-key="..."` — the same DOM-exposure caveat as any other provider applies.

### 6. Google (Gemini)

```html
<ai-agent
  provider="google"
  model="gemini-2.5-flash"
  base-url="/api/gemini">
  <ai-message role="system">You are a concise coding assistant.</ai-message>
</ai-agent>
```

System messages are extracted and placed in the top-level `systemInstruction` field. The assistant turn uses the role `model` on the wire — `<ai-agent>` translates to/from `assistant` automatically so `messages` state stays consistent with the other providers. Multimodal image input works on Gemini too, but **only for `data:` URLs** (base64 encoded); http(s) URLs are rejected at request-building time with a clear error because Gemini's `inlineData` requires inline bytes. See [Multimodal](#multimodal) for details. Audio and video parts are not yet exposed through `AiMessage`.

### 7. Tool use (function calling)

Declare tools as JS objects with a `handler` function; `<ai-agent>` / `AiCore` runs the tool-use loop automatically — each assistant turn that requests a tool gets its handler invoked, results are appended to history, and the loop continues until the model stops requesting tools or `maxToolRoundtrips` is reached.

```html
<ai-agent id="chat" provider="openai" model="gpt-4o" base-url="/api/ai"></ai-agent>
<script type="module">
  const el = document.getElementById("chat");
  el.tools = [{
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
    handler: async ({ location }) => fetchWeather(location),   // returns {temp, unit}
  }];
  el.prompt = "What's the weather in Tokyo?";
  const reply = await el.send();
</script>
```

- Supported providers: OpenAI / Azure OpenAI / Anthropic / Google (Gemini). All four translate between the unified `AiTool` shape and each provider's own tool-use wire format.
- Handlers may return any JSON-serializable value. Strings are passed through; everything else is `JSON.stringify`ed into the tool message content.
- Errors thrown from a handler are captured into the tool message so the model can recover (the loop does not reject on handler failure).
- Parallel tool calls in a single turn are executed via `Promise.all` and appended to history in the order the provider reported them.
- See [Tool use](#tool-use) below for `toolChoice`, `maxToolRoundtrips`, event surface, and remote-mode `registerTool` patterns.

### 8. Structured output (JSON Schema)

Constrain the final assistant response to a JSON object matching a given schema. Providers that support it natively (OpenAI / Azure / Google) translate to their own `response_format` / `responseSchema` field; Anthropic is supported via a synthetic tool-use turn (non-streaming) that yields the same shape.

```html
<ai-agent id="review" provider="openai" model="gpt-4o" base-url="/api/ai"></ai-agent>
<script type="module">
  const el = document.getElementById("review");
  el.responseSchema = {
    type: "object",
    properties: {
      rating: { type: "integer", minimum: 1, maximum: 5 },
      summary: { type: "string" },
    },
    required: ["rating", "summary"],
    additionalProperties: false,
  };
  el.prompt = "Review the pizza I just had. It was amazing.";
  const json = await el.send();          // JSON-stringified object
  const review = JSON.parse(json);
  console.log(review);                   // { rating: 5, summary: "..." }
</script>
```

`responseSchema` is mutually exclusive with `tools` in a single `send()` call (the library throws synchronously if both are set). For Anthropic, `responseSchema` implies non-streaming even if `stream` is true — streaming the synthetic tool-use is not reliable. See [Structured output](#structured-output) for full details.

### 9. Multimodal input (text + image)

Pass an `AiContentPart[]` array as the prompt to include images alongside text. Supported on OpenAI / Azure OpenAI / Anthropic / Google (Gemini).

```html
<ai-agent id="vision" provider="openai" model="gpt-4o" base-url="/api/ai"></ai-agent>
<script type="module">
  const el = document.getElementById("vision");
  el.prompt = [
    { type: "text", text: "What's in this image?" },
    { type: "image", url: "https://example.com/cat.jpg" },
    // Or a data: URL for inline-encoded images:
    // { type: "image", url: "data:image/png;base64,iVBORw0KG..." },
  ];
  const reply = await el.send();
</script>
```

- Each part is either `{ type: "text", text }` or `{ type: "image", url, mediaType? }`.
- **Google (Gemini) accepts data: URLs only** — http(s) URLs throw synchronously at request-building time with a clear error. Fetch + base64-encode client-side before passing.
- OpenAI / Anthropic accept both http(s) and data: URLs.
- Only user messages carry array content on the wire. Assistant / system / tool messages with array content are flattened to concatenated text parts.
- See [Multimodal](#multimodal) below for the full provider mapping.

### 10. Development-only: API key on the element

For local prototyping you can put the key directly on the element. It is visible in the DOM, the network panel, and any framework state bound to the element. **Never ship this shape to production** — switch to section 1 (backend proxy) or [Remote Mode](#remote-mode) before deploying:

```html
<ai-agent
  provider="openai"
  model="gpt-4o"
  api-key="sk-...">
</ai-agent>
```

## State Surface vs Command Surface

`<ai-agent>` exposes two different kinds of properties.

### Output state (bindable async state)

These properties represent the current inference state and are the main HAWC surface:

| Property | Type | Description |
|----------|------|-------------|
| `content` | `string` | Current response text. **Updates on every streaming chunk** (~60fps via rAF batching) |
| `messages` | `AiMessage[]` | Full conversation history (user + assistant). Updated on send and completion. Stored assistant entries carry a normalized `finishReason` (`"stop" \| "length" \| "tool_use" \| "safety" \| "other"`) — see [Error contract §Safety refusals](#safety-refusals-are-not-errors). |
| `usage` | `AiUsage \| null` | Token usage `{ promptTokens, completionTokens, totalTokens }` |
| `loading` | `boolean` | `true` from send to completion or error |
| `streaming` | `boolean` | `true` from stream start (after HTTP response headers) to stream completion. Stays `false` for the entire call when `no-stream` is set, or when `responseSchema` is used on Anthropic (structured output forces non-streaming there — see [Structured output](#structured-output)). |
| `error` | `AiHttpError \| Error \| null` | Error info. See [Error contract](#error-contract) for which failure classes surface here vs. via synchronous throw vs. via tool-message payload. |

### Input / command surface

These properties control inference execution:

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `"openai" \| "anthropic" \| "azure-openai" \| "google"` | Provider selection |
| `model` | `string` | Model name (or Azure deployment name) |
| `base-url` | `string` | API endpoint (for proxies, local models, Azure) |
| `api-key` | `string` | API key (development only — use a backend proxy in production) |
| `system` | `string` | System message (shortcut, attribute) |
| `prompt` | `string \| AiContentPart[]` | User input — string for text, array for multimodal (text + image). JS property. See [Multimodal](#multimodal). |
| `trigger` | `boolean` | One-way send trigger |
| `no-stream` | `boolean` | Disable streaming |
| `temperature` | `number` | Generation temperature |
| `max-tokens` | `number` | Maximum output tokens |
| `api-version` | `string` | Azure OpenAI API version (default `2024-02-01`) |
| `tools` | `AiTool[] \| null` | Tool declarations for the next `send()`. JS property only (handlers are functions). See [Tool use](#tool-use). |
| `toolChoice` | `"auto" \| "none" \| { name }` | Force the model's tool-use mode. JS property only. |
| `maxToolRoundtrips` | `number` | Upper bound on consecutive tool-use rounds (default 10). JS property only. |
| `responseSchema` | `Record<string, any> \| null` | JSON Schema for structured output. JS property only. Mutually exclusive with `tools`. See [Structured output](#structured-output). |
| `responseSchemaName` | `string` | Name tag forwarded to providers that accept it (default `"response"`). JS property only. |

## Architecture

`@wc-bindable/ai` follows the HAWC architecture.

### Core: `AiCore`

`AiCore` is a pure `EventTarget` class.
It contains:

- provider-agnostic HTTP execution
- SSE stream parsing and content accumulation
- rAF-batched content event emission (~60fps)
- conversation history management
- abort control
- `wc-bindable-protocol` declaration

### Shell: `<ai-agent>`

`<ai-agent>` is a thin `HTMLElement` wrapper around `AiCore`.
It adds:

- attribute / property mapping
- DOM lifecycle integration
- child element collection (`<ai-message>`)
- declarative execution helpers such as `trigger`

### Providers

Providers implement the `IAiProvider` interface, translating between the unified internal format and each API's specific request/response shapes:

```typescript
interface IAiProvider {
  buildRequest(messages: AiMessage[], options: AiRequestOptions): {
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  parseResponse(data: any): {
    content: string;
    toolCalls?: AiToolCall[];   // populated when the model requested tool use
    usage?: AiUsage;
  };
  parseStreamChunk(event: string | undefined, data: string): {
    delta?: string;
    usage?: Partial<AiUsage>;
    toolCallDeltas?: AiToolCallDelta[];   // accumulated by AiCore across chunks
    done: boolean;
  } | null;
}
```

Tool use, structured output, and multimodal input all flow through the same three methods — `buildRequest` reads the extra `AiRequestOptions` fields (`tools`, `toolChoice`, `responseSchema`, array `content` on user messages), `parseResponse` / `parseStreamChunk` emit `toolCalls` / `toolCallDeltas` when the provider returned them. Custom providers that only need plain text can leave the optional fields undefined.

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
                                         ai-agent:content-changed event
                                                          ↓
                                         wc-bindable-protocol binding
```

## Headless Usage (Core only)

`AiCore` can be used without the Shell element:

```typescript
import { AiCore } from "@wc-bindable/ai";
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
import { AiCore } from "@wc-bindable/ai";

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
const aiEl = document.querySelector("ai-agent");

// Read history
console.log(aiEl.messages);

// Clear history
aiEl.messages = [];

// Restore from saved state
aiEl.messages = savedMessages;
```

## Tool use

`AiCore.send()` runs a tool-use loop automatically: for each assistant turn that emits tool calls, matching handlers are invoked in parallel, their results are appended to history as `{ role: "tool", content, toolCallId }` messages, and another round-trip to the provider follows. The loop terminates when the model stops requesting tools or `maxToolRoundtrips` is hit.

### `AiTool` shape

```ts
interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, any>;   // JSON Schema
  handler?: (args: any) => unknown | Promise<unknown>;
}
```

`handler` is optional so remote deployments can pass tool declarations over the wire (handlers are not serializable). When absent, `AiCore` looks up the handler in the process-wide registry populated via `registerTool()` — see [Remote Mode](#remote-mode) below.

### Request options

| Option | Type | Default | Description |
|---|---|---|---|
| `tools` | `AiTool[]` | `undefined` | Tool declarations for this invocation. |
| `toolChoice` | `"auto" \| "none" \| { name: string }` | provider default | Force the model toward no-tool / any-tool / a specific tool. |
| `maxToolRoundtrips` | `number` | `10` | Upper bound on consecutive tool-use rounds before the loop errors out. `0` disables tool use entirely — `tools` and `toolChoice` are stripped from the provider request, so a compliant model never sees the tool catalog and `send()` returns a plain assistant response in one round. If a non-compliant provider emits `tool_calls` regardless, those are dropped from the stored assistant message and the turn is still treated as terminal (no handler is invoked, no `maxToolRoundtrips exceeded` error). |

`maxToolRoundtrips` exceeded throws an Error which is surfaced via `el.error` and rolls back the messages pushed by this `send()` call.

### Event surface

Tool-use events are dispatched on the element but are **not** part of the `wc-bindable-protocol` surface (they are notifications, not state). Listen with `addEventListener`:

| Event | `detail` | Fires |
|---|---|---|
| `ai-agent:tool-call-requested` | `{ toolCall: { id, name, arguments } }` | Before handler invocation. Useful for "Looking up weather..." UI indicators. |
| `ai-agent:tool-call-completed` | `{ toolCall, result }` on success, `{ toolCall, error }` on failure / unknown tool | After handler resolves or throws. |

### Error handling within the loop

- **Handler throws.** Captured into the tool message content as `{ error: "<message>" }` JSON. The model receives this and typically recovers on the next turn. No rejection bubbles out of `send()`.
- **Unknown tool name.** Same treatment — tool message carries an `error` payload, the loop continues.
- **`maxToolRoundtrips` exceeded.** `send()` resolves to `null`, `el.error` is set to an `Error`, and the messages pushed by this call are rolled back. Subsequent calls start fresh.
- **Abort.** `abort()` during a tool handler await or between turns rolls back this send's messages cleanly.

### `content` state across tool-use rounds

Each tool-use round resets `content` to `""` and streams the new assistant turn into it, so `content` only ever reflects the **current** round's text. Prior-round text lives in `messages` as `{ role: "assistant", content, toolCalls }` entries; consume `messages` if you need to render the full running transcript. At `send()` resolution `content` holds the final (terminal) assistant turn — tool-calling intermediary turns are only visible through `messages`.

### Handler reentrance

Tool handlers must **not** call `el.send()` / `core.send()` on the same instance. A new `send()` call aborts the in-flight request (same rule as everywhere else in the API), which on the same instance would tear down the very tool-use loop awaiting the handler's return. Use a **separate** `AiCore` / `<ai-agent>` for nested inference from within a handler; plain `fetch` / non-AI work inside a handler is fine.

### `AiToolCall.arguments` is the raw JSON string

The unified `AiToolCall` shape preserves the wire JSON string (same as OpenAI's `tool_calls[].function.arguments`) rather than a parsed object, so the value is stable across providers and re-serializable. **The tool handler always receives parsed `args`** — the library calls `JSON.parse` before invoking the handler — but if you read `el.messages[*].toolCalls` directly (logging, audit), call `JSON.parse(toolCall.arguments)` yourself.

### Why streaming differs between tool use and structured output

Tool-call arguments are accumulated across `input_json_delta` / incremental `tool_calls` deltas and **parsed once** at the end of the turn, so streaming is safe. Structured output's final response is rendered into `content` chunk-by-chunk and the intermediate buffer is **invalid JSON** (`{"rating": 5, "summa...`), which is why the Anthropic emulation forces non-streaming: unwrapping a synthetic `tool_use` from streamed content blocks would produce exactly that mid-flight partial string with no clean completion signal for consumers. OpenAI/Azure/Google preserve streaming for structured output because the provider guarantees the accumulated text is valid JSON by stream end.

### Provider wire formats

| Provider | Request | Response | Role for tool results |
|---|---|---|---|
| OpenAI / Azure | `tools: [{ type: "function", function: { name, description, parameters } }]` | `choices[0].message.tool_calls[]`; stream deltas under `choices[0].delta.tool_calls[].function.arguments` accumulated by index | `"tool"` with `tool_call_id` |
| Anthropic | `tools: [{ name, description, input_schema }]` | `content[].type === "tool_use"`; stream via `content_block_start` (id, name) + `input_json_delta` (partial args) | `"user"` wrapping a `tool_result` content block with `tool_use_id` |
| Google (Gemini) | `tools: [{ functionDeclarations: [{ name, description, parameters }] }]` | `parts[].functionCall: { name, args[, id] }` — server-supplied `id` (Vertex / newer v1beta) is preserved; when absent, synthesized as `gemini:<name>:<counter>` which is kept internal and never echoed on the wire | `"user"` with `functionResponse: { name, response[, id] }` (Gemini's `Content.role` is `"user" \| "model"`; the function-calling multi-turn spec places `functionResponse` on a user-role Content) |

## Structured output

Pass a JSON Schema via `AiRequestOptions.responseSchema` (or `el.responseSchema`) to constrain the final assistant response to a structured object. `send()` still resolves to a `string` — that string is the JSON-stringified object, so consumers call `JSON.parse()` themselves (no Zod or schema validator is bundled).

### Options

| Option | Type | Description |
|---|---|---|
| `responseSchema` | `Record<string, any>` | JSON Schema object. Must be a plain object, not array or primitive. |
| `responseSchemaName` | `string` | Name forwarded to providers that accept it (OpenAI's `json_schema.name`). Defaults to `"response"`. |

### Provider wire formats

| Provider | Wire representation |
|---|---|
| OpenAI / Azure | `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` |
| Google (Gemini) | `generationConfig.responseMimeType: "application/json"` + `generationConfig.responseSchema` |
| Anthropic | Synthetic `tool_use` with `name: "__wc_bindable_structured_response__"` + `tool_choice: { type: "tool", name: ... }`. Response's `tool_use.input` is unwrapped back into a JSON content string before it reaches the caller. **Forces non-streaming** — streaming input_json_delta reliably across stateless chunk parsing is deferred. |

### Constraints

- **Mutually exclusive with `tools`.** Both set → synchronous throw. Use either structured output *or* tool use in a single turn, not both. (Tool handlers returning schema-shaped objects cover the multi-step case.)
- **`responseSchema` must be a plain object.** Arrays, strings, or null throw synchronously.
- **Streaming semantics.** OpenAI/Azure/Google streaming works as usual — text deltas arrive as normal, the accumulated content is valid JSON at stream end. Anthropic forces non-streaming; the response arrives in one non-stream fetch.
- **Intermediate `content` during streaming is NOT valid JSON.** Bindings that observe `content` on every delta will see fragments like `{"rating": 5, "summa` and must **not** call `JSON.parse()` until `streaming` transitions back to `false` (or `loading`, whichever you prefer) — only then is the accumulated buffer a complete JSON document. For UI that shows raw JSON streaming in, render as text until done; for UI that shows typed fields, wait for completion before parsing.
- **No schema validation.** The library does not validate the returned content against `responseSchema`. Providers enforce it on their side; if they return invalid JSON, `JSON.parse()` will throw in your code. Pair with a validator (Zod, Ajv, etc.) if you need defensive parsing.
- **Cross-provider schema portability is not guaranteed.** Each provider enforces a different subset of JSON Schema:
  - **OpenAI / Azure** always send `strict: true`. In strict mode, every property must appear in `required`, `additionalProperties: false` is mandatory at every level, and features like `$ref`, `oneOf`, `anyOf`, `allOf`, `pattern`, and `format` are either forbidden or ignored. A schema that works without `strict` may return `400` here.
  - **Google (Gemini)** accepts an OpenAPI 3.0 schema subset — `$ref`, `oneOf`, and some numeric/string format validators are not supported.
  - **Anthropic** passes the schema through as a tool `input_schema`, which is looser (the model, not a validator, enforces shape).
  The same `responseSchema` is not guaranteed to work unchanged across all four providers; validate on the provider you target, and keep schemas conservative if you plan to swap providers at runtime.
- **`responseSchemaName` default.** When omitted or explicitly `undefined`, the library falls back to `"response"` for providers that require a name (OpenAI's `json_schema.name`). Passing an empty string is **not** special-cased — OpenAI will reject it.

## Multimodal

User-turn content can be an array of parts instead of a plain string. This is the v1 multimodal surface — text + image inputs on any of the four providers.

### Part types

```ts
type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; mediaType?: string };

type AiContent = string | AiContentPart[];
```

`url` accepts either an `http(s)://...` URL or a `data:<mediaType>;base64,<payload>` URL. `mediaType` is optional — providers that need an explicit media type fall back to parsing it from the data: URL header.

### Using multimodal content

```js
// Via AiCore.send() — prompt argument accepts the array directly:
await core.send([
  { type: "text", text: "Identify the breed." },
  { type: "image", url: "https://example.com/dog.jpg" },
], { model: "gpt-4o" });

// Via <ai-agent>.prompt — same shape:
el.prompt = [
  { type: "text", text: "Identify the breed." },
  { type: "image", url: dataUrlFromFileInput },
];
await el.send();
```

### Provider wire formats

| Provider | Text part | Image (http/https URL) | Image (data: URL) |
|---|---|---|---|
| OpenAI / Azure | `{ type: "text", text }` | `{ type: "image_url", image_url: { url } }` | same `image_url` — data: URL passed through |
| Anthropic | `{ type: "text", text }` | `{ type: "image", source: { type: "url", url } }` | `{ type: "image", source: { type: "base64", media_type, data } }` |
| Google (Gemini) | `{ text }` | **Throws** at `buildRequest` — fetch + encode first | `{ inlineData: { mimeType, data } }` |

### `mediaType` resolution

| Input URL shape | How `mediaType` is resolved |
|---|---|
| `data:image/png;base64,...` | Parsed from the data: URL header. The optional `mediaType` field overrides when set. |
| `https://...` on OpenAI / Azure | **Not used** — the URL is passed through to `image_url.url` as-is; the provider infers the media type from the URL / response headers. |
| `https://...` on Anthropic | **Not used on the client** — sent as `source: { type: "url", url }` and the provider fetches and inspects the bytes server-side. Requires `anthropic-version: 2023-06-01` (the version this library pins) or newer; on older versions only base64 image sources were accepted. |
| `https://...` on Google (Gemini) | **Rejected** at `buildRequest` — Gemini's `inlineData` takes bytes, not URLs. |

You only need to supply `mediaType` explicitly when the URL alone cannot reveal it (rare — most CDNs serve images with a correct content type).

### Provider size and count limits

The library does **not** enforce provider-side image limits — a too-large or too-many image payload fails at request time with a provider 4xx. Rough current caps to size prompts against:

| Provider | Per-image size | Count per request |
|---|---|---|
| OpenAI / Azure | ~20 MB (total request payload limit applies) | many, but request-size-bounded |
| Anthropic | 5 MB per image | up to ~100 images |
| Google (Gemini) | ~20 MB `inlineData` (base64 expansion factor included — the raw bytes must fit under the provider's total request payload cap) | many |

Confirm on the provider's own documentation before relying on exact numbers; the limits above drift faster than library releases.

### `detail` / image-cost tuning is not exposed in v1

OpenAI's `image_url.detail` (`"low"` / `"high"` / `"auto"`) and equivalent knobs on other providers are not reachable through `AiContentPart`. If you need to control per-image token cost, wrap the proxy response / extend the provider — this surface may gain a `detail?: "low" | "high" | "auto"` field additively in a later minor release.

### Scope and constraints

- **v1 = user-message images only.** Assistant/system/tool messages with array content are flattened to concatenated text; only `user` messages carry mixed parts on the wire.
- **No audio / video / file input.** Future additions will extend `AiContentPart` additively.
- **No automatic fetching.** The library does not transform http(s) URLs into data: URLs; providers that require base64 (Gemini) fail early with a clear error so clients know to pre-encode.
- **Assistant outputs stay text.** Models may describe images but current providers return text-only assistant messages, so `content` in assistant replies is always a string. **Forward-compat caveat:** as providers ship image-generation-as-assistant-turn (DALL·E 3, Imagen 3, Gemini 2.0 image output), this contract will likely widen so that assistant `content` can also be `AiContentPart[]`. The plan is additive — the `AiContentPart` union already covers the shape — but a v2 that flips assistant `content` from `string` to `AiContent` on the output side is the kind of change that propagates into every binding that does `msg.content.slice(...)` or pattern-matches on string. If you build long-term code against `el.messages`, treat assistant `content` as `string` today *and* write against a narrowed `AiContent` type, e.g. `typeof m.content === "string" ? m.content : m.content.map(...)`, so a future widening does not ripple into every consumer.

## Abort

In-flight requests can be aborted:

```javascript
const aiEl = document.querySelector("ai-agent");
aiEl.abort(); // Cancels streaming or pending request
```

A new `send()` call automatically aborts any previous request.

### What stays in state after abort

- **`messages`** — rolled back. The `{ role: "user", ... }` push from the aborted `send()` (and any tool-result / intermediate assistant turns from a tool-use loop) is removed so retry sees a clean history.
- **`content`** — **left as the partial assistant text accumulated up to the abort point.** It is not cleared. The next `send()` resets it on the first delta of the new turn. If you want abort to clear the visible response immediately, observe the `loading` → `false` transition and wipe the bound view yourself.
- **`loading` / `streaming`** — both reset to `false`.
- **`usage`** — kept at whatever the partial stream reported (it is reset to `null` at the start of the next `send()`).
- **`error`** — not set. Aborts are treated as a normal control-flow signal, not a failure. `send()` resolves to `null`.

### Retry and backoff

`<ai-agent>` does **not** retry failed requests, apply exponential backoff, or rate-limit on its own. Provider 4xx/5xx surface as `el.error` with the raw status — the consumer decides whether to retry, switch model, surface to the user, or queue for later. Retry policy belongs at the proxy layer (where you can apply per-tenant quotas) or in framework state (where you can debounce against UI intent), not inside the I/O primitive.

`AiHttpError` exposes `retryAfter?: number` (seconds) populated from the response's `Retry-After` header when the provider sends one (commonly on 429 / 503, and on Anthropic's 529 overload). Both delta-seconds and HTTP-date forms of the header are normalized; past-dated or missing values leave the field `undefined`. A consumer-side retry queue can read this directly instead of parsing `body`:

```ts
bind(aiEl, (name, value) => {
  if (name !== "error" || !value || typeof value !== "object") return;
  if (value.status === 429 && typeof value.retryAfter === "number") {
    scheduleRetry(value.retryAfter);
  }
});
```

## Programmatic Usage

```javascript
const aiEl = document.querySelector("ai-agent");

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

`<ai-agent>` and `AiCore` validate request parameters up front so that bad values surface as immediate errors instead of provider `400` responses or silent NaN payloads.

| Option | Accepted | Rejected |
|--------|----------|----------|
| `temperature` | any finite `number` | `NaN`, `±Infinity` |
| `max-tokens` / `maxTokens` | positive integer (`>= 1`) | `0`, negative, `NaN`, non-integer (e.g. `1.5`) |
| `provider` (attribute) | `"openai" \| "anthropic" \| "azure-openai" \| "google"` | anything else |

Behavior on invalid input:

- `core.send()` throws `Error("... temperature must be a finite number, got ...")` / `Error("... maxTokens must be a positive integer, got ...")` synchronously.
- `<ai-agent>` `send()` rejects with the same error; no HTTP request is dispatched.
- `<ai-agent>` `provider` attribute: `setAttribute("provider", "bogus")` does **not** throw through `attributeChangedCallback`. The previous request is halted, `el.error` is populated, and any subsequent `send()` rejects until the attribute is corrected. The DOM attribute stays as the user wrote it for inspectability.
- Providers invoked directly (`new OpenAiProvider().buildRequest(...)`) apply the same validation, so every path is consistent.

## Optional DOM Triggering

If `autoTrigger` is enabled (default), clicking an element with `data-aitarget` triggers the corresponding `<ai-agent>` element's `send()`:

```html
<button data-aitarget="chat">Send</button>
<ai-agent id="chat" provider="openai" model="gpt-4o" base-url="/api/ai"></ai-agent>
```

Event delegation is used — works with dynamically added elements.

## Elements

### `<ai-agent>`

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
| `prompt` | `string \| AiContentPart[]` | User input text, or multimodal content parts |
| `trigger` | `boolean` | Set to `true` to send |
| `tools` | `AiTool[] \| null` | Tool declarations (JS property only) |
| `toolChoice` | `"auto" \| "none" \| { name } \| undefined` | Tool-use mode (JS property only) |
| `maxToolRoundtrips` | `number \| undefined` | Roundtrip cap for tool-use loop (JS property only) |
| `responseSchema` | `Record<string, any> \| null` | JSON Schema for structured output (JS property only) |
| `responseSchemaName` | `string \| undefined` | Name tag for providers that accept one (default `"response"` when undefined; JS property only) |

| Method | Description |
|--------|-------------|
| `send()` | Send the current `prompt` (runs the tool-use loop if `tools` is set) |
| `abort()` | Cancel the in-flight request |

### `<ai-message>`

Declarative prompt content. Two use cases in a single element:

| `role` | Behavior |
|---|---|
| `system` (default) | Becomes `options.system` for every `send()`. If the `system` attribute is set on `<ai-agent>`, that attribute wins and this element is ignored. Only the first such child is used. |
| `user` / `assistant` | Seeded into `messages` at `connectedCallback` time as a **few-shot template**. All such children are collected in document order. Seeding is skipped if `messages` was set programmatically before connect, or in remote mode (the server owns conversation state). |

The message content is taken from the element's text content with `String.prototype.trim()` applied — leading/trailing whitespace and indentation newlines from HTML authoring are stripped, so `<ai-message>\n  Hello\n</ai-message>` seeds `"Hello"`. If you need literal trailing whitespace in a few-shot example, set `messages` programmatically instead. Shadow DOM suppresses rendering. Whitespace-only children are skipped during seeding.

**Ordering contract.** On `connectedCallback`, children are walked once in **document order**. The first `role="system"` child (or a role-less child) becomes `options.system`; all `role="user"` / `role="assistant"` children are concatenated into the seed `messages` array in the order they appear. System and user/assistant children can therefore be interleaved in markup without affecting the seeded conversation — the system-prompt and history channels are independent.

**Dynamic `<ai-message>` additions after connect are not re-seeded.** Seeding runs once, right after `connectedCallback` in a microtask (so children constructed imperatively before `appendChild` have time to upgrade). Children added after that point are ignored — to grow a few-shot template dynamically, push directly to `el.messages`:

```js
el.messages = [...el.messages, { role: "user", content: "..." }, { role: "assistant", content: "..." }];
```

```html
<!-- System prompt only -->
<ai-agent provider="openai" model="gpt-4o" base-url="/api/ai">
  <ai-message role="system">
    You are a helpful coding assistant.
    Always provide TypeScript examples.
  </ai-message>
</ai-agent>

<!-- Few-shot template: system + example turn -->
<ai-agent provider="openai" model="gpt-4o" base-url="/api/ai">
  <ai-message role="system">Translate English to French. Reply with the translation only.</ai-message>
  <ai-message role="user">Hello</ai-message>
  <ai-message role="assistant">Bonjour</ai-message>
  <ai-message role="user">Good morning</ai-message>
  <ai-message role="assistant">Bonjour</ai-message>
</ai-agent>
```

The next `send()` appends the new user prompt to the seeded history, so the model sees the full few-shot context plus the live question.

## wc-bindable-protocol

Both `AiCore` and `<ai-agent>` declare `wc-bindable-protocol` compliance.

### Core (`AiCore`)

```typescript
static wcBindable = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "content",   event: "ai-agent:content-changed" },
    { name: "messages",  event: "ai-agent:messages-changed" },
    { name: "usage",     event: "ai-agent:usage-changed" },
    { name: "loading",   event: "ai-agent:loading-changed" },
    { name: "streaming", event: "ai-agent:streaming-changed" },
    { name: "error",     event: "ai-agent:error" },
  ],
};
```

### Shell (`<ai-agent>`)

```typescript
static wcBindable = {
  ...AiCore.wcBindable,
  properties: [
    ...AiCore.wcBindable.properties,
    { name: "trigger", event: "ai-agent:trigger-changed" },
  ],
};
```

## Framework Integration

Since `<ai-agent>` is HAWC + `wc-bindable-protocol`, it works with any framework through thin adapters from `@wc-bindable/*`.

### React

```tsx
import { useWcBindable } from "@wc-bindable/react";
import type { WcsAiValues } from "@wc-bindable/ai";

function Chat() {
  const [ref, { content, messages, loading, streaming }] =
    useWcBindable<HTMLElement, WcsAiValues>();

  return (
    <>
      <ai-agent ref={ref} provider="openai" model="gpt-4o" base-url="/api/ai" />
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
import type { WcsAiValues } from "@wc-bindable/ai";

const { ref, values } = useWcBindable<HTMLElement, WcsAiValues>();
</script>

<template>
  <ai-agent :ref="ref" provider="openai" model="gpt-4o" base-url="/api/ai" />
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

<ai-agent provider="openai" model="gpt-4o" base-url="/api/ai"
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

const aiEl = document.querySelector("ai-agent");

bind(aiEl, (name, value) => {
  if (name === "content") {
    document.getElementById("response").textContent = value;
  }
});
```

## Remote Mode

`<ai-agent>` can run its Core on a different host and drive the Shell in the browser over WebSocket.

Two independent reasons to choose this mode:

1. **You need server-owned state.** Authoritative conversation history, protocol-level rate limiting and quotas, per-user audit logging, or cross-device session continuity. These are difficult to bolt onto a stateless backend proxy.
2. **You are building the backend from scratch.** `AiCore` already implements provider abstraction, SSE parsing, streaming, abort propagation, and the `wc-bindable-protocol` wire format. A remote deployment reuses that on the server and needs ~15 lines of glue (see [Server setup](#server-setup)). Writing a backend proxy from scratch means reimplementing per-provider URL/header/streaming forwarding and abort handling yourself.

### When to stay with a backend proxy instead

- You already have HTTP proxy or API-gateway infrastructure and want `<ai-agent>` to slot into it. WebSocket deployments have their own operational shape (sticky sessions, idle timeouts, separate scaling), which is only worth it if you gain something from (1) above.
- Your deployment target cannot host long-lived WebSocket connections (some serverless platforms, CDN-fronted edge functions).
- You only need to keep the API key out of the browser. Either mode does that — pick by infrastructure fit, not by the API-key requirement alone.

```
browser                                         server
┌────────────────────┐    WebSocket    ┌───────────────────────┐
│ <ai-agent>  (Shell) │  ─────────────▶ │ RemoteShellProxy      │
│ RemoteCoreProxy    │  ◀───────────── │  ↕                    │
└────────────────────┘                 │ AiCore → fetch(LLM)   │
                                       └───────────────────────┘
```

The Shell exposes the same surface — `prompt`, `model`, `content`, `messages`, `error`, `send()`, `abort()` — whether the Core is local or remote. `provider` / `model` / streaming state / conversation history are all synced through `wc-bindable-protocol`.

### Enable remote mode

Set the `remote` config before calling `bootstrapAi()` (or before the first `<ai-agent>` connects):

```js
import { bootstrapAi } from "@wc-bindable/ai";

bootstrapAi({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: "wss://example.com/ai-agent",
  },
});
```

Or load the environment-resolving auto entrypoint (see below) and skip `bootstrapAi()`:

```js
import "@wc-bindable/ai/auto/remoteEnv";
```

### `remoteSettingType`

| Value | Resolution order for `remoteCoreUrl` |
|-------|--------------------------------------|
| `"config"` (default) | Uses the literal `remoteCoreUrl` string you pass in. |
| `"env"` | `globalThis.process?.env?.AI_REMOTE_CORE_URL` → `globalThis.AI_REMOTE_CORE_URL` → `""`. Good for Node bundler replacement (Vite `define`, webpack `DefinePlugin`) or `<script>window.AI_REMOTE_CORE_URL = "..."</script>` before the first `<ai-agent>` connects. |

### Error surface

Remote-mode failures are exposed through the same `ai-agent:error` event and `el.error` getter as local mode. Two classes of failures are surfaced locally even though they originate outside the server's `AiCore`:

- **Connection failures.** Initial failure fires `ai-agent:error` with `Error("... WebSocket connection failed: <url>")`; a drop after `open` uses `"connection lost"`. If the server had synced `loading`/`streaming`=`true`, they are reset to `false` so the UI does not stay busy.
- **Transport-layer errors during `send()`.** Timeouts, disposed proxies, and raw `DOMException` from `WebSocket.send` are treated as transport failures: `el.send()` resolves to `null`, `el.error` is populated, `loading`/`streaming` are reset. Server-side business errors (validation, provider 4xx/5xx) are re-thrown to match local-mode contract.

### `remoteCoreUrl` is required when enabled

Setting `enableRemote: true` with an empty URL does not throw out of `appendChild`. Instead, `connectedCallback` catches the initialization error, fires `ai-agent:error`, and exposes the same `Error` through `el.error`.

### Auto entrypoints

| Entrypoint | Behavior |
|------------|----------|
| `@wc-bindable/ai/auto` | Registers the custom elements with default (local) config. |
| `@wc-bindable/ai/auto/remoteEnv` | Registers the custom elements and enables remote mode with `remoteSettingType: "env"`. `AI_REMOTE_CORE_URL` is resolved when a `<ai-agent>` element initializes its remote connection. |

### Server setup

`@wc-bindable/ai` does **not** ship a server helper — `AiCore` itself runs unchanged on the server. Wire it to the browser by pairing it with `RemoteShellProxy` + `WebSocketServerTransport` from `@wc-bindable/remote`.

#### Minimal example (Node + `ws`)

```ts
import { WebSocketServer } from "ws";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import { AiCore } from "@wc-bindable/ai";

const wss = new WebSocketServer({ port: 8080, path: "/ai-agent" });

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

Point the browser at `wss://<host>:8080/ai-agent` via `remoteCoreUrl`. Instantiate `AiCore` **per connection** — `AiCore` owns conversation history, in-flight `AbortController`, and streaming state, and must not be shared across sessions.

##### Pooling and reuse on edge runtimes

On platforms where cold start on `new AiCore()` is a real cost (CF Workers, Vercel Edge, Lambda at low concurrency), a pool of pre-warmed Cores is sometimes attractive. `AiCore` is not a thread-safe pool entry, but its *per-request* state can be reset to pool-entry condition between requests:

1. **Cancel any in-flight work.** `core.abort()` — no-op when idle; otherwise aborts the active `fetch` and the streaming pipeline.
2. **Reset conversation history.** `core.messages = []` — emits `messages-changed` and rebuilds internal state.
3. **Drop tool handler bindings carrying the previous principal.** Call `core.unregisterTool(name)` for every per-user handler registered via `core.registerTool()`, or recreate the Core entirely if you don't track what was registered (new construction is cheap — the cold-start cost is mostly `fetch` warm-up, not object allocation).

After (1)–(3), `content` / `usage` / `loading` / `streaming` / `error` are observable state, not hidden machinery; the next `send()` clears them at turn start (`_setLoading(true); _setStreaming(false); _setError(null); _setUsage(null);`) so stale values do not leak into the next request's event stream. **What you must not reuse**: anything that captured the previous connection's user in a closure (tool handlers, custom provider instances, `EventTarget` listeners attached to the Core by the previous session's code). The process-wide `registerTool()` map survives — that is by design for user-agnostic tools, so pool cleanup must not blanket-clear it.

For WebSocket servers, the simpler and safer default is a fresh `AiCore` per `connection` event. Pool only when profiling actually shows construction as the bottleneck.

#### Injecting the provider API key server-side

This is the whole reason to run remote. `<ai-agent>.send()` in remote mode forwards `{ model, apiKey, baseUrl, apiVersion, ... }` from the DOM element to the server as `send` command arguments ([components/Ai.ts:383-392](src/components/Ai.ts#L383-L392)). In a hardened deployment the browser has no `api-key` attribute, so the incoming `apiKey` is `""` — the server must override it before calling the provider:

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

#### Registering tool handlers server-side

When `<ai-agent>` runs in remote mode, handler functions in `el.tools` are stripped before serialization (functions are not JSON-encodable). The server resolves handlers by name from a process-wide registry populated via `registerTool()`:

```ts
import { registerTool } from "@wc-bindable/ai";

registerTool("get_weather", async ({ location }) => {
  // Runs server-side: full access to secrets, database connections, private APIs.
  return await fetchWeather(location);
});

registerTool("search_kb", async ({ query, limit }) => {
  return await queryVectorStore(query, limit);
});
```

Client side continues to pass full `AiTool` entries (including `handler` for local fallback); the Shell strips `handler` on send. If a client declares a tool that is not registered on the server, the loop inserts an error tool message and continues — the model typically backs off gracefully.

**Per-user authorization must use the per-Core registry, not the process-wide one.** The module-level `registerTool()` is a single `Map` keyed by tool name — a handler registered inside `createCores` with a user-specific closure will silently overwrite any earlier connection's handler of the same name, and subsequent `send()` calls from the older session will execute the newer user's handler. Use `core.registerTool()` for anything that depends on the authenticated principal:

```ts
createCores: (user, ws) => {
  const core = new ServerAiCore();
  // Bound to THIS connection's user — no cross-connection leakage.
  core.registerTool("delete_account", async (args) => {
    if (!user.canDelete) throw new Error("forbidden");
    return deleteAccount(user.id, args);
  });
  // ...
}
```

Resolution order at tool-call time is: per-call `tool.handler` → `core.registerTool()` instance registry → module-level `registerTool()` process registry. Keep the module-level registry for stateless, user-agnostic tools (a pure weather lookup that takes no user context); put anything gated on identity / permissions on the Core instance.

**Both registries are gated by `AiRequestOptions.tools`.** The registry is a *handler* fallback — it never widens the per-request tool catalog. If a model hallucinates or replays a tool name that the current `send()` call did not declare in `options.tools`, the call is answered with a `"not defined on this send() invocation"` error tool message regardless of what is registered. This prevents a privileged registered handler (for example a `delete_account` bound to a different endpoint) from being reachable just because the model produced its name.

**HMR / hot-reload.** Bundlers that re-execute the registering module (Vite, webpack) will call `registerTool("name", handler)` a second time with a *different* function reference. The registry silently replaces the entry in both cases — same security shape as the `createCores` overwrite above, now stretched across a reload cycle where an older browser tab's in-flight `send()` can reach the newly-installed handler. The library emits one `console.warn` per reference-changing overwrite **only in development builds** (gated on `import.meta.env.DEV` / `NODE_ENV !== "production"`); production runs stay silent by design, so a noisy reload cycle does not reach end-user consoles. Silence the dev warning and drop the footgun by pairing registration with `unregisterTool(name)` in your bundler's dispose hook:

```ts
import { registerTool, unregisterTool } from "@wc-bindable/ai";

registerTool("get_weather", getWeatherHandler);

if (import.meta.hot) {
  import.meta.hot.dispose(() => unregisterTool("get_weather"));
}
```

If a production deployment needs a louder signal for bootstrap-ordering bugs (the same module registering twice with different handlers at startup), wrap `registerTool` in application code that checks `getRegisteredTool(name)` first and throws, rather than relying on the dev-only warning.

#### Authenticated deployments (pair with `<auth0-gate>`)

A public WebSocket endpoint that dispenses LLM tokens is a direct cost vector. Production deployments should gate the Core on an authenticated handshake. The recommended pattern is to combine `<auth0-gate>` in remote mode with `createAuthenticatedWSS` from `@wc-bindable/auth0/server`, and use its `createCores` hook to construct `ServerAiCore` only after token verification:

```ts
import { createAuthenticatedWSS } from "@wc-bindable/auth0/server";
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

See [@wc-bindable/auth0 README-REMOTE.md](../auth0-gate/README-REMOTE.md#server-side) and [SPEC-REMOTE.md](../auth0-gate/SPEC-REMOTE.md) for the `createAuthenticatedWSS` handler options, handshake error codes, and the `auth:refresh` contract used when Auth0 access tokens expire mid-session.

#### Cleanup checklist

- `ws.on("close", ...)` → `core.abort()` then `shell.dispose()`. Without `abort()`, an in-flight `fetch` keeps running until the provider responds and racks up token cost for a client who is already gone.
- Do not reuse a `RemoteShellProxy` or `AiCore` across reconnects — the client's fresh WebSocket triggers a new `connection` event, and a new Core/proxy pair is cheap.
- If you front the WebSocket with a reverse proxy (nginx, CloudFront, ALB), raise the idle timeout above your longest expected streaming response — provider completions can run for minutes under high `max_tokens`.

## Configuration

```javascript
import { bootstrapAi } from "@wc-bindable/ai";

bootstrapAi({
  autoTrigger: true,
  triggerAttribute: "data-aitarget",
  tagNames: {
    ai: "ai-agent",
    aiMessage: "ai-message",
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
  AiHttpError, WcsAiCoreValues, WcsAiValues,
  AiRole, AiToolCall, AiTool, AiToolChoice, AiToolCallDelta,
  AiContent, AiContentPart, AiContentTextPart, AiContentImagePart,
} from "@wc-bindable/ai";

// Runtime registry for remote-mode tool handler resolution
import { registerTool, unregisterTool } from "@wc-bindable/ai";
```

```typescript
type AiRole = "system" | "user" | "assistant" | "tool";

type AiFinishReason = "stop" | "length" | "tool_use" | "safety" | "other";

interface AiToolCall {
  id: string;
  name: string;
  arguments: string;   // JSON string
}

type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; mediaType?: string };

type AiContent = string | AiContentPart[];

interface AiMessage {
  role: AiRole;
  content: AiContent;
  toolCalls?: AiToolCall[];   // assistant turn that requested tools
  toolCallId?: string;        // role === "tool" result correlation
  finishReason?: AiFinishReason;       // populated on stored assistant turns
  providerHints?: Record<string, any>; // namespaced per-provider overrides
}

interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler?: (args: any) => unknown | Promise<unknown>;
}

type AiToolChoice = "auto" | "none" | { name: string };

interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface AiHttpError {
  status: number;
  statusText: string;
  body: string;
  retryAfter?: number;   // seconds; populated from the `Retry-After` header when present
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
- Prompt caching: set `providerHints.anthropic.cacheControl` on any `AiMessage` to mark a cache breakpoint — the wire representation of that message gets `cache_control: { type: "ephemeral" }` on its last content block (see [Provider hints](#provider-hints) below). Ignored by all other providers.

#### Provider hints

`AiMessage.providerHints` is a namespaced passthrough for provider-specific knobs the neutral surface cannot express. Keys are provider names; values are provider-defined objects shipped on the wire as-is. Unknown keys are silent no-ops (no request-time rejection).

**`providerHints.anthropic.cacheControl`** — Enable Claude's prompt caching on this message:

```ts
el.messages = [
  {
    role: "system",
    content: LONG_SYSTEM_PROMPT,        // > ~1024 tokens to be worth caching
    providerHints: { anthropic: { cacheControl: true } },
  },
  ...previousTurns,
];
```

| Hint value | Wire effect |
|---|---|
| `true` | Sugar: expands to `cache_control: { type: "ephemeral" }` on the last content block. |
| `{ type: "ephemeral" }` | Sent verbatim. Accepts future `type` values without a library release (e.g. if Anthropic introduces longer-TTL cache types). |
| any other shape | Ignored. |

Mechanics:

- **System caching.** A system message carrying the hint flips the top-level `system` field from a string to `[{ type: "text", text, cache_control }, ...]`. System messages without the hint in the same request render as plain text blocks in the same array. System prompts set via the `options.system` shortcut (or the `system` attribute on `<ai-agent>`) **cannot be cached** — there is no `AiMessage` to hang the hint on. To cache the system prompt, place it in `messages[]` as `{ role: "system", content, providerHints }` instead.
- **Message caching.** On user / assistant / tool messages, the hint attaches `cache_control` to the last content block (appending to an already-array content, or promoting a string content to `[{ type: "text", text, cache_control }]`). Place the hint on the message that marks your cache breakpoint — everything *up to and including* that block becomes the cacheable prefix.
- **Anthropic limit: 4 breakpoints.** The provider rejects a request with more than four `cache_control` marks. The library does not cap or warn — if you sprinkle hints on every message, Anthropic returns a 400 and `el.error` surfaces it. Mark only the stable prefix boundaries (system prompt, fixed few-shot preamble, long document, etc.).
- **No client-side eligibility check.** Whether the cached prefix actually exceeds Anthropic's token minimum (currently ~1024 input tokens, subject to change) is a runtime property the library does not inspect; the provider silently skips cache reuse when the prefix is too short.
- **Cross-provider safety.** Other providers ignore `providerHints.anthropic` entirely — `OpenAiProvider`, `AzureOpenAiProvider`, and `GoogleProvider` never read the namespace, so the same `AiMessage` history can flow to any provider without conditional shaping in the consumer.

The hint is intentionally permissive (no schema validation) so that new `cache_control` variants or other Anthropic-specific fields can be added at the call site without waiting for a library release — the tradeoff is that typos become silent no-ops. If caching appears ineffective, inspect the outgoing request body to verify the `cache_control` field landed where intended.

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
- Multimodal: text + image input supported (see [Multimodal](#multimodal)). Images **must be `data:` URLs** — Gemini's `inlineData` takes inline base64 bytes, and http(s) URLs are not accepted by the API. Providing an http URL raises a synchronous error at `buildRequest` time with guidance to fetch+encode client-side. Audio/video parts are not yet exposed through `AiMessage`.
- Tool calling: the provider preserves a server-supplied `functionCall.id` verbatim (Vertex AI / newer API versions use this to disambiguate parallel same-name calls) and echoes it back in `functionResponse.id`. When no id is present (public v1beta API), a synthetic `gemini:<name>:<counter>` id is used internally for in-memory correlation and never serialized to the wire.
- Vertex AI (OAuth, region-specific endpoints) is out of scope for a dedicated provider; point `base-url` at a proxy if you need it.

## Security

> The `api-key` attribute is exposed in the DOM and is intended for **development and prototyping only**.
> In production, use `base-url` to point to a backend proxy that handles authentication server-side.

```html
<!-- Development -->
<ai-agent provider="openai" model="gpt-4o" api-key="sk-..." />

<!-- Production (recommended) -->
<ai-agent provider="openai" model="gpt-4o" base-url="/api/ai" />
```

## Error contract

A cross-cutting summary of how each failure class surfaces, consolidated from the per-section notes above ([Input Validation](#input-validation), [Tool use §Error handling within the loop](#error-handling-within-the-loop), [Structured output §Constraints](#constraints), [Abort](#abort), [Remote Mode §Error surface](#error-surface)). Use this to decide where to `try / catch` vs. where to bind state.

### Three channels

| Channel | What reaches it |
|---|---|
| **Synchronous throw / promise rejection from `send()`** | Precondition violations the caller must fix: invalid `temperature` / `maxTokens` / `maxToolRoundtrips` / `provider`, empty or non-string/array `prompt`, `responseSchema` that is not a plain object, `responseSchema` + `tools` both set, Gemini + http(s) image URL. Also: remote-mode **server-side business errors** (provider 4xx/5xx, server validation) are re-thrown to match local-mode contract. Wrap `send()` in `try / catch` to react. |
| **`el.error` state + `ai-agent:error` event** | Failures that originate after the request is dispatched: provider HTTP 4xx/5xx, `maxToolRoundtrips` exceeded, remote WebSocket connect failure / drop, remote transport-layer failures during `send()` (timeouts, disposed proxy, raw `DOMException`). `send()` resolves to `null`; `loading` / `streaming` are reset. Bind `error` for UI — do **not** `try / catch`. |
| **Tool message payload (`{ error: "<message>" }`)** | Handler throws and unknown tool names during the tool-use loop. The model sees the error in the next turn and typically recovers. `el.error` stays `null`; `send()` continues and resolves normally. Not directly observable from the caller — listen to `ai-agent:tool-call-completed` if you need UI hooks. |

### Per-failure reference

| Failure | Channel | `send()` result | `messages` | `el.error` |
|---|---|---|---|---|
| Invalid `temperature` / `maxTokens` / `maxToolRoundtrips` / `provider` / `prompt` | Sync throw → Promise reject | rejects | unchanged | unchanged |
| `responseSchema` not a plain object | Sync throw → Promise reject | rejects | unchanged | unchanged |
| `responseSchema` + `tools` both set | Sync throw → Promise reject | rejects | unchanged | unchanged |
| Gemini + http(s) image URL | Sync throw → Promise reject | rejects | unchanged | unchanged |
| Tool handler throws | Tool message `{error}` | string (loop continues) | includes tool-error message | `null` |
| Unknown tool name from model | Tool message `{error}` | string (loop continues) | includes tool-error message | `null` |
| `maxToolRoundtrips` exceeded | `el.error` | `null` | rolled back for this send() | `Error` |
| Provider HTTP 4xx / 5xx | `el.error` | `null` | user turn rolled back | `AiHttpError` |
| Abort (`abort()` or new `send()`) | Neither (control signal) | `null` | rolled back | `null` (**not set**) |
| Remote WebSocket connect / drop | `el.error` | (no in-flight send) / `null` | — | `Error` |
| Remote transport failure during `send()` (timeout, disposed proxy, raw `DOMException`) | `el.error` | `null` | rolled back | `Error` |
| Remote server-side business error (provider 4xx/5xx, server validation) | Promise reject | rejects | rolled back | populated |

### Quick rule of thumb

- **Bind `el.error`** for everything the user can't fix by changing call-site arguments — HTTP failures, roundtrip exhaustion, WebSocket drop, remote transport glitches.
- **`try / catch`** around `send()` only if you're dispatching unvalidated options from UI, or you deploy in remote mode and want to distinguish server-side business errors (reject) from transport glitches (`el.error`, resolves `null`).
- **Tool handler errors never reach your code.** They're scoped to the tool-use loop — the model sees them and recovers. If you need handler failures as a caller signal, either re-throw out of the loop yourself (by NOT using the built-in loop — invoke tools manually) or listen to `ai-agent:tool-call-completed` for observability.

### Safety refusals are not errors

When a model declines to produce a response for policy reasons, the provider returns **HTTP 200** with the refusal text (or an empty body) as a normal assistant turn:

| Provider | Signal |
|---|---|
| OpenAI / Azure | `choices[0].finish_reason` = `"content_filter"`; may also include a `refusal` field on the message |
| Anthropic | `stop_reason` = `"refusal"` (Claude 3.5+) or refusal text in the content block |
| Google (Gemini) | `candidates[0].finishReason` = `"SAFETY"` with `safetyRatings[]` attached |

These **do not populate `el.error`** — the request succeeded. `content` holds the refusal text (or `""` on hard blocks), `messages` gets the refusal as an `{ role: "assistant", content: "...", finishReason: "safety" }` entry, and `send()` resolves normally. Branch the UI off `finishReason` on the stored assistant message:

```ts
const last = el.messages.at(-1);
if (last?.role === "assistant" && last.finishReason === "safety") {
  showRefusalBanner();        // "This request was declined."
} else {
  renderAssistantBubble(last);
}
```

`finishReason` is normalized across providers to one of `"stop" | "length" | "tool_use" | "safety" | "other"` (see [AiFinishReason](#typescript-types) for the full per-provider mapping). Safety-adjacent Gemini values (`RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `LANGUAGE`) all collapse to `"safety"` because UI branching is the same for them; consumers needing per-category triage (e.g. "recitation vs. safety classifier" for compliance logging) must subclass the provider or tag at the proxy layer.

`AiHttpError` is still the right channel when the consumer wants a refusal to *fail* rather than *succeed*. Pattern:

- **Proxy-layer tagging.** Read `candidates[0].finishReason` / `choices[0].finish_reason` server-side; on safety values, respond with `422` + `X-Finish-Reason: safety` so the browser sees an `AiHttpError` instead of a normal assistant turn. Use this when the UI cannot render a refusal in-line and should instead surface the bounce like any other 4xx.

`finishReason` is absent on assistant messages whose turn reported no explicit reason (rare — most providers always set one), and absent on user / system / tool messages. History assigned programmatically via `core.messages = [...]` preserves `finishReason` when present; the validator does not require it.

## Design Notes

- `content`, `messages`, `usage`, `loading`, `streaming`, and `error` are **output state**
- `prompt`, `trigger`, `provider`, `model` are **input / command surface**
- `trigger` is intentionally one-way: writing `true` executes send, reset emits completion. **Ordering with `prompt`.** `trigger` reads `el.prompt` synchronously at the moment it is set to `true`, so `prompt` must be assigned *before* `trigger` when using the JS API:
  ```js
  el.prompt = "...";
  el.trigger = true;   // reads el.prompt now
  ```
  Writing `trigger = true` with an empty / unset `prompt` is a no-op — `AiCore.send()` rejects synchronously with `"prompt is required"`, the `trigger` setter swallows that rejection (trigger is a fire-and-forget command surface, not a promise), and the trigger flag flips back to `false`. `el.error` is **not** populated in that case because the validation happens before the state-setting path; the failure is observable only as "trigger cycled without content ever streaming." For cases where the prompt source is itself async (e.g. a promise chain), set `prompt` inside the async callback and then flip `trigger`, or call `el.send()` directly so the caller sees the rejection. In HTML attributes, order of `prompt` assignment vs. `trigger` depends on how the framework / binding applies the mapping; bind `prompt` through a JS property (rather than an attribute) so assignment order is under your control
- `content` updates are batched via `requestAnimationFrame` — each rAF cycle emits at most one `ai-agent:content-changed` event, limiting DOM updates to ~60fps even under high-throughput streaming
- on error, the user message is removed from history to keep it clean for retry
- a new `send()` automatically aborts any in-flight request
- `messages` is both readable (output state) and writable (for history reset/restore)
- `system` attribute takes priority over `<ai-message role="system">`
- Anthropic's `max_tokens` defaults to 4096 if not specified
- Google (Gemini) uses distinct endpoints for streaming (`:streamGenerateContent?alt=sse`) vs non-streaming (`:generateContent`); the `assistant` role is translated to `model` on the wire; stream end is signalled by `candidates[0].finishReason` rather than a `[DONE]` sentinel; multimodal image input is accepted as `data:` URLs (http(s) URLs throw at `buildRequest`); a server-supplied `functionCall.id` is preserved verbatim for Vertex AI parallel-call disambiguation, with a synthetic `gemini:<name>:<counter>` id used internally as fallback and stripped before serialization
- tool use runs an auto-loop inside `AiCore.send()`: handlers execute in parallel via `Promise.all`, results are appended as `role: "tool"` messages, and the loop re-fetches until the model stops requesting tools or `maxToolRoundtrips` (default 10) is hit
- handler errors and unknown tool names are captured into the tool message payload so the model can recover, instead of rejecting `send()` — only `maxToolRoundtrips` exhaustion and abort surface as terminal errors
- `registerTool(name, handler)` provides a process-wide registry that `AiCore` consults when `tool.handler` is absent — this is how remote mode resolves handlers after the Shell strips functions from the wire payload
- `responseSchema` constrains the final response to a JSON object: OpenAI/Azure/Google translate to their native schema fields; Anthropic is emulated via a synthetic forced `tool_use` and unwrapped back into a JSON content string. Forcing non-streaming on Anthropic is intentional — streaming input_json_delta deltas reliably across stateless chunk parsing is out of scope for v1. Mutually exclusive with `tools`.
- `<ai-message role="user|assistant">` children seed the initial `messages` history at `connectedCallback` for few-shot templates; `role="system"` children continue to flow through `_collectSystem()` into `options.system` on each send. Seeding is skipped when `messages` was set programmatically before connect or in remote mode (server-owned state).
- multimodal input widens `AiMessage.content` from `string` to `string | AiContentPart[]`; only `user` messages carry mixed parts on the wire (assistant/system/tool with array content are flattened to concatenated text). Google (Gemini) accepts only `data:` URLs for images — http(s) URLs throw at `buildRequest` with a clear message, rather than letting the API return a cryptic 400.
- stored assistant messages carry a normalized `finishReason` (`"stop" | "length" | "tool_use" | "safety" | "other"`) — providers map their native `finish_reason` / `stop_reason` / `finishReason` vocabularies into this union; unknown values collapse to `"other"` so the field stays forward-compatible. Safety refusals reach the consumer through this field, not through `el.error` (see [Error contract §Safety refusals](#safety-refusals-are-not-errors))
- `AiMessage.providerHints` is a namespaced passthrough for provider-specific wire fields (Anthropic prompt caching via `providerHints.anthropic.cacheControl`; see [Provider details §Provider hints](#provider-hints)). Other providers silently ignore unknown namespaces, so the same history is safe to flow through any provider without per-site shaping
- no provider SDK required — all providers use `fetch` + `ReadableStream` + SSE parsing directly

## License

MIT
