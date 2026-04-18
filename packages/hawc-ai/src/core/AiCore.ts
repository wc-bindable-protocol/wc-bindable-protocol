import { raiseError } from "../raiseError.js";
import {
  IWcBindable, IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiTool, AiToolCall,
  AiContentPart, AiFinishReason,
} from "../types.js";
import { assertKnownContentParts } from "../providers/contentHelpers.js";
import { SseParser } from "../streaming/SseParser.js";
import { OpenAiProvider } from "../providers/OpenAiProvider.js";
import { AnthropicProvider } from "../providers/AnthropicProvider.js";
import { AzureOpenAiProvider } from "../providers/AzureOpenAiProvider.js";
import { GoogleProvider } from "../providers/GoogleProvider.js";
import { getRegisteredTool, AiToolHandler } from "../toolRegistry.js";
import { cloneMessage } from "./cloneMessage.js";
import { validateMessages } from "./validateMessages.js";

/**
 * Normalize the HTTP `Retry-After` header to seconds.
 * Accepts either a delta-seconds value ("120") or an HTTP-date
 * ("Wed, 21 Oct 2015 07:28:00 GMT"). Returns `undefined` for missing,
 * unparseable, or past-dated values so consumers can treat absence uniformly.
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Delta-seconds form is a non-negative integer per RFC 9110.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const delta = Math.ceil((date - Date.now()) / 1000);
  return delta > 0 ? delta : undefined;
}

function resolveProvider(name: string): IAiProvider {
  switch (name) {
    case "openai": return new OpenAiProvider();
    case "anthropic": return new AnthropicProvider();
    case "azure-openai": return new AzureOpenAiProvider();
    case "google": return new GoogleProvider();
    default: raiseError(`Unknown provider: "${name}". Use "openai", "anthropic", "azure-openai", or "google".`);
  }
}

const DEFAULT_MAX_TOOL_ROUNDTRIPS = 10;

interface TurnResult {
  content: string;
  toolCalls?: AiToolCall[];
  usage?: AiUsage;
  finishReason?: AiFinishReason;
}

// Accumulator for streamed tool call fragments keyed by provider-reported index.
interface ToolCallAccumulator {
  id: string | undefined;
  name: string | undefined;
  arguments: string;
}

/**
 * Headless AI inference core.
 * Manages conversation history, streaming, rAF-batched content updates, and
 * the tool-use loop (auto-execute tool handlers between assistant turns until
 * the model stops requesting tools or maxToolRoundtrips is reached).
 */
export class AiCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "content", event: "hawc-ai:content-changed" },
      { name: "messages", event: "hawc-ai:messages-changed" },
      { name: "usage", event: "hawc-ai:usage-changed" },
      { name: "loading", event: "hawc-ai:loading-changed" },
      { name: "streaming", event: "hawc-ai:streaming-changed" },
      { name: "error", event: "hawc-ai:error" },
    ],
    inputs: [
      { name: "provider" },
      { name: "messages" },
    ],
    commands: [
      { name: "send", async: true },
      { name: "abort" },
    ],
  };

  private _target: EventTarget;
  private _content: string = "";
  private _messages: AiMessage[] = [];
  private _usage: AiUsage | null = null;
  private _loading: boolean = false;
  private _streaming: boolean = false;
  private _error: any = null;
  private _provider: IAiProvider | null = null;
  private _abortController: AbortController | null = null;
  private _flushScheduled: boolean = false;
  private _rafId: any = 0;
  // Instance-scoped tool handler registry. Takes precedence over the process-
  // wide registry so authenticated deployments can bind handlers to a specific
  // user/connection via `createCores` without the per-connection closures
  // clobbering each other's `registerTool("same_name", ...)` calls.
  private _toolHandlers: Map<string, AiToolHandler> = new Map();

  constructor(target?: EventTarget) {
    super();
    this._target = target ?? this;
  }

  get content(): string { return this._content; }
  get usage(): AiUsage | null { return this._usage; }
  get loading(): boolean { return this._loading; }
  get streaming(): boolean { return this._streaming; }
  get error(): any { return this._error; }

  get messages(): AiMessage[] {
    return this._messages.map(cloneMessage);
  }

  set messages(value: AiMessage[]) {
    validateMessages(value);
    this._messages = value.map(cloneMessage);
    this._emitMessages();
  }

  /**
   * Register a tool handler scoped to this Core instance. Resolution order at
   * tool-call time: per-call `tool.handler` → this instance registry → the
   * process-wide registry (see `registerTool` in index). Use the instance
   * registry for per-user / per-connection authorization so concurrent
   * connections in `createAuthenticatedWSS.createCores` do not overwrite each
   * other's handlers.
   */
  registerTool(name: string, handler: AiToolHandler): void {
    if (!name) raiseError("registerTool: name is required.");
    if (typeof handler !== "function") raiseError("registerTool: handler must be a function.");
    this._toolHandlers.set(name, handler);
  }

  unregisterTool(name: string): boolean {
    return this._toolHandlers.delete(name);
  }

  getRegisteredTool(name: string): AiToolHandler | undefined {
    return this._toolHandlers.get(name);
  }

  get provider(): IAiProvider | null { return this._provider; }

  set provider(value: IAiProvider | string | null) {
    if (typeof value === "string") {
      this._provider = resolveProvider(value);
    } else {
      this._provider = value;
    }
  }

  // --- State setters (dispatch events) ---

  private _setContent(content: string): void {
    this._content = content;
    this._target.dispatchEvent(new CustomEvent("hawc-ai:content-changed", {
      detail: content,
      bubbles: true,
    }));
  }

  private _emitMessages(): void {
    this._target.dispatchEvent(new CustomEvent("hawc-ai:messages-changed", {
      detail: this.messages,
      bubbles: true,
    }));
  }

  private _setUsage(usage: AiUsage | null): void {
    this._usage = usage;
    this._target.dispatchEvent(new CustomEvent("hawc-ai:usage-changed", {
      detail: usage,
      bubbles: true,
    }));
  }

  private _setLoading(loading: boolean): void {
    this._loading = loading;
    this._target.dispatchEvent(new CustomEvent("hawc-ai:loading-changed", {
      detail: loading,
      bubbles: true,
    }));
  }

  private _setStreaming(streaming: boolean): void {
    this._streaming = streaming;
    this._target.dispatchEvent(new CustomEvent("hawc-ai:streaming-changed", {
      detail: streaming,
      bubbles: true,
    }));
  }

  private _setError(error: any): void {
    if (error instanceof Error && typeof (error as any).toJSON !== "function") {
      (error as any).toJSON = () => ({
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      });
    }
    this._error = error;
    this._target.dispatchEvent(new CustomEvent("hawc-ai:error", {
      detail: this._error,
      bubbles: true,
    }));
  }

  // --- rAF batching ---

  private _scheduleFlush(): void {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    const raf = globalThis.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(cb, 16));
    this._rafId = raf(() => {
      this._flushScheduled = false;
      this._rafId = 0;
      this._setContent(this._content);
    });
  }

  private _cancelFlush(): void {
    if (this._rafId) {
      const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
      cancel(this._rafId);
      this._rafId = 0;
      this._flushScheduled = false;
    }
  }

  // --- Public API ---

  abort(): void {
    if (this._abortController) {
      this._abortController.abort();
      // Keep the reference until _doSend finally clears it under the isCurrent guard.
    }
  }

  send(prompt: string | AiContentPart[], options: AiRequestOptions): Promise<string | null> {
    if (prompt === undefined || prompt === null) raiseError("prompt is required.");
    if (typeof prompt === "string") {
      if (!prompt) raiseError("prompt is required.");
    } else if (Array.isArray(prompt)) {
      if (prompt.length === 0) raiseError("prompt is required; content parts array is empty.");
      assertKnownContentParts(prompt);
    } else {
      raiseError("prompt must be a string or an AiContentPart[] array.");
    }
    if (!this._provider) raiseError("provider is required. Set provider before calling send().");
    if (!options.model) raiseError("model is required. See @wc-bindable/hawc-ai README §Supported Providers for each provider's model catalog (no default is shipped because model identifiers drift faster than library releases).");
    if (options.temperature !== undefined && !Number.isFinite(options.temperature)) {
      raiseError(`temperature must be a finite number, got ${options.temperature}.`);
    }
    if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
      raiseError(`maxTokens must be a positive integer, got ${options.maxTokens}.`);
    }
    if (options.maxToolRoundtrips !== undefined && (!Number.isInteger(options.maxToolRoundtrips) || options.maxToolRoundtrips < 0)) {
      raiseError(`maxToolRoundtrips must be a non-negative integer, got ${options.maxToolRoundtrips}.`);
    }
    if (options.responseSchema !== undefined) {
      if (typeof options.responseSchema !== "object" || options.responseSchema === null || Array.isArray(options.responseSchema)) {
        raiseError("responseSchema must be a JSON Schema object.");
      }
      if (options.tools && options.tools.length > 0) {
        raiseError("responseSchema and tools cannot both be set on the same send() call. Structured output and tool use are mutually exclusive in this API.");
      }
    }
    return this._doSend(prompt, options);
  }

  // --- Internal ---

  private async _doSend(prompt: string | AiContentPart[], options: AiRequestOptions): Promise<string | null> {
    this.abort();
    const abortController = new AbortController();
    this._abortController = abortController;
    const { signal } = abortController;
    const isCurrent = () => this._abortController === abortController;

    this._setLoading(true);
    this._setStreaming(false);
    this._setError(null);
    this._setUsage(null);

    // Track messages pushed by *this* invocation so concurrent sends rolling back
    // don't touch each other's history. Incoming messages are deep-copied so
    // later mutation of the caller's prompt/tool-result objects (notably the
    // `AiContentPart[]` array handed to send()) cannot silently rewrite
    // internal history without firing a messages-changed event.
    const pushedMessages: AiMessage[] = [];
    const pushMessage = (m: AiMessage) => {
      const cloned = cloneMessage(m);
      this._messages.push(cloned);
      pushedMessages.push(cloned);
      this._emitMessages();
    };
    const rollback = () => {
      let mutated = false;
      for (const m of pushedMessages) {
        const idx = this._messages.indexOf(m);
        if (idx !== -1) {
          this._messages.splice(idx, 1);
          mutated = true;
        }
      }
      if (mutated) this._emitMessages();
    };

    pushMessage({ role: "user", content: prompt });

    const maxRoundtrips = options.maxToolRoundtrips ?? DEFAULT_MAX_TOOL_ROUNDTRIPS;
    // `maxToolRoundtrips: 0` is documented as "disables tool use even if
    // tools is set". Honor that by stripping `tools` / `toolChoice` from the
    // provider request: the model never sees the tool catalog, cannot emit
    // tool calls, and send() returns a plain assistant response instead of
    // rolling back with a "roundtrips exceeded" error. Callers who want the
    // model to see tools but refuse to execute them should use
    // `toolChoice: "none"` explicitly.
    const effectiveOptions: AiRequestOptions = maxRoundtrips === 0
      ? { ...options, tools: undefined, toolChoice: undefined }
      : options;
    const tools = effectiveOptions.tools ?? [];
    const toolsByName = new Map<string, AiTool>(tools.map(t => [t.name, t]));

    let aggregateUsage: AiUsage | null = null;
    let roundtrips = 0;
    let lastAssistantContent = "";

    try {
      while (true) {
        // Build the message list sent to the provider: optional system prompt
        // plus the current working history (user prompt on turn 1, plus any
        // tool-result messages pushed from prior turns).
        const apiMessages: AiMessage[] = [];
        if (options.system) {
          apiMessages.push({ role: "system", content: options.system });
        }
        apiMessages.push(...this._messages);

        // Reset per-turn content so streaming deltas refer to the current turn only.
        this._cancelFlush();
        this._content = "";
        this._setContent("");

        const turn = await this._fetchTurn(apiMessages, effectiveOptions, abortController);
        if (turn === null) {
          // HTTP error (error state set by _fetchTurn) or concurrent abort.
          rollback();
          if (isCurrent()) {
            this._setStreaming(false);
            this._setLoading(false);
          }
          return null;
        }

        if (!isCurrent()) {
          rollback();
          return null;
        }

        if (turn.usage) {
          aggregateUsage = this._accumulateUsage(aggregateUsage, turn.usage);
          this._setUsage(aggregateUsage);
        }

        // Defensive against a provider that returns tool_calls despite
        // having no tool catalog in the request (maxToolRoundtrips === 0
        // strips tools/toolChoice above). In that case the user explicitly
        // opted out of tool use, so we drop the bogus tool_calls and treat
        // the turn as terminal instead of throwing "roundtrips exceeded".
        const hasToolCalls = !!(turn.toolCalls && turn.toolCalls.length > 0);
        const treatAsTerminal = !hasToolCalls || maxRoundtrips === 0;

        const assistantMessage: AiMessage = { role: "assistant", content: turn.content };
        if (hasToolCalls && !treatAsTerminal) {
          assistantMessage.toolCalls = turn.toolCalls;
        }
        // Preserve the provider's finish reason on the stored assistant turn
        // so consumers can branch UI on it (e.g. "safety" → refusal banner).
        // Intermediate tool-use turns in the loop also get theirs recorded,
        // which lets history readers distinguish a tool-use continuation from
        // a terminal assistant turn without re-consulting `toolCalls`.
        if (turn.finishReason !== undefined) {
          assistantMessage.finishReason = turn.finishReason;
        }
        pushMessage(assistantMessage);
        lastAssistantContent = turn.content;

        if (treatAsTerminal) {
          // Either model did not request more tools, or tool use is disabled
          // for this call (maxToolRoundtrips === 0) and we are ignoring any
          // tool_calls the provider returned out of contract.
          this._setLoading(false);
          return lastAssistantContent;
        }

        roundtrips++;
        if (roundtrips > maxRoundtrips) {
          throw new Error(
            `[@wc-bindable/hawc-ai] maxToolRoundtrips (${maxRoundtrips}) exceeded; aborting tool-use loop.`,
          );
        }

        // Execute all tool calls in parallel. Individual handler errors are
        // captured into the tool message payload so the model can recover;
        // only non-recoverable failures (abort) bubble out.
        const toolResults = await Promise.all(turn.toolCalls!.map(async (call) => {
          this._target.dispatchEvent(new CustomEvent("hawc-ai:tool-call-requested", {
            detail: { toolCall: { ...call } },
            bubbles: true,
          }));
          // `options.tools` is the capability boundary for this send(). If
          // the model emits a call for a name that was not declared, we
          // refuse to invoke even when a handler exists in the instance /
          // process registry — otherwise a hallucinated or replayed tool
          // name could reach a registered handler that the caller never
          // exposed on this request (e.g. a privileged handler registered
          // for a different endpoint). The registries exist only to supply
          // the *handler* for a declaration whose `handler` field was
          // stripped (remote mode), not to widen the tool catalog.
          const tool = toolsByName.get(call.name);
          let handler: AiToolHandler | undefined;
          let reason: string | null = null;
          if (!tool) {
            reason = `Tool "${call.name}" is not defined on this send() invocation.`;
          } else {
            handler = tool.handler
              ?? this._toolHandlers.get(call.name)
              ?? getRegisteredTool(call.name);
            if (!handler) {
              reason = `Tool "${call.name}" has no handler (neither on the options.tools entry, the core's instance registry, nor the process registry).`;
            }
          }
          if (reason) {
            const content = JSON.stringify({ error: reason });
            // Emit the specific reason so consumers can distinguish a
            // capability-boundary rejection ("not defined on this send()")
            // from a deployment/config bug ("has no handler"). Collapsing
            // both into a generic "unknown tool" string hides a security-
            // relevant signal from observers of the event surface.
            this._target.dispatchEvent(new CustomEvent("hawc-ai:tool-call-completed", {
              detail: { toolCall: { ...call }, error: reason },
              bubbles: true,
            }));
            return { toolCallId: call.id, content };
          }
          try {
            const args = call.arguments ? JSON.parse(call.arguments) : {};
            const result = await handler!(args);
            const content = typeof result === "string" ? result : JSON.stringify(result ?? null);
            this._target.dispatchEvent(new CustomEvent("hawc-ai:tool-call-completed", {
              detail: { toolCall: { ...call }, result },
              bubbles: true,
            }));
            return { toolCallId: call.id, content };
          } catch (err: any) {
            const message = err?.message ?? String(err);
            this._target.dispatchEvent(new CustomEvent("hawc-ai:tool-call-completed", {
              detail: { toolCall: { ...call }, error: message },
              bubbles: true,
            }));
            return { toolCallId: call.id, content: JSON.stringify({ error: message }) };
          }
        }));

        if (!isCurrent() || signal.aborted) {
          rollback();
          if (isCurrent()) {
            this._setLoading(false);
            this._setStreaming(false);
          }
          return null;
        }

        for (const r of toolResults) {
          pushMessage({ role: "tool", content: r.content, toolCallId: r.toolCallId });
        }
        // Loop continues: next turn will include these tool messages in history.
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        rollback();
        if (isCurrent()) {
          this._setStreaming(false);
          this._setLoading(false);
        }
        return null;
      }
      rollback();
      if (isCurrent()) {
        this._setError(e);
        this._setStreaming(false);
        this._setLoading(false);
      }
      return null;
    } finally {
      if (isCurrent()) {
        this._abortController = null;
        this._cancelFlush();
      }
    }
  }

  private async _fetchTurn(
    apiMessages: AiMessage[],
    options: AiRequestOptions,
    abortController: AbortController,
  ): Promise<TurnResult | null> {
    const { signal } = abortController;
    const isCurrent = () => this._abortController === abortController;

    const request = this._provider!.buildRequest(apiMessages, options);
    const response = await globalThis.fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      if (isCurrent()) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        this._setError({
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        });
      }
      // Null signals "failure observed + state already handled" to _doSend.
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isEventStream = contentType.includes("text/event-stream");
    const shouldStream = (options.stream !== false) && isEventStream && response.body;

    if (shouldStream) {
      return await this._processStream(response.body!, abortController);
    }

    const data = await response.json();
    const parsed = this._provider!.parseResponse(data);
    if (!isCurrent()) return null;
    this._content = parsed.content;
    this._setContent(this._content);
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      finishReason: parsed.finishReason,
    };
  }

  /**
   * Remove a message by reference. No-op if the message is not in the history.
   * Kept as a utility so callers (and tests) can drop a known message without
   * racing against concurrent mutations.
   */
  private _removeMessage(message: AiMessage): void {
    const idx = this._messages.indexOf(message);
    if (idx === -1) return;
    this._messages.splice(idx, 1);
    this._emitMessages();
  }

  private async _processStream(body: ReadableStream<Uint8Array>, abortController: AbortController): Promise<TurnResult | null> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let lastUsage: AiUsage | undefined;
    // Streaming providers emit finishReason on whichever chunk closes the
    // content turn (OpenAI's final `[DONE]`-adjacent chunk, Anthropic's
    // `message_delta`, Gemini's candidate-bearing chunk that also carries
    // `finishReason`). Accumulate last-non-undefined so a trailing usage-only
    // chunk (Gemini) does not clobber the reason seen on the earlier chunk.
    let lastFinishReason: AiFinishReason | undefined;
    const toolCallAcc = new Map<number, ToolCallAccumulator>();
    const isCurrent = () => this._abortController === abortController;

    this._setStreaming(true);

    const applyToolCallDelta = (d: { index: number; id?: string; name?: string; argumentsDelta?: string }) => {
      let entry = toolCallAcc.get(d.index);
      if (!entry) {
        entry = { id: undefined, name: undefined, arguments: "" };
        toolCallAcc.set(d.index, entry);
      }
      if (d.id !== undefined) entry.id = d.id;
      if (d.name !== undefined) entry.name = d.name;
      if (d.argumentsDelta !== undefined) entry.arguments += d.argumentsDelta;
    };

    try {
      // Termination contract:
      //
      // - Providers that emit an explicit end-of-stream sentinel (OpenAI
      //   `[DONE]`, Anthropic `message_stop`) set `result.done = true`.
      //   We finish processing the *rest of the current batch* so
      //   trailing metadata events packed in the same reader.read()
      //   buffer are not discarded, then exit the outer loop so send()
      //   returns even if an OpenAI-compatible proxy (Ollama / vLLM /
      //   LiteLLM) keeps the HTTP stream open after the terminator.
      //
      // - Providers without a definitive sentinel (Gemini) must *not*
      //   set `done: true` on `finishReason`, because usage metadata is
      //   delivered in a separate SSE event that arrives after the
      //   final-content event (sometimes in the same read buffer, often
      //   in a later one). For those, the loop exits when the server
      //   closes the stream naturally and `reader.read()` resolves with
      //   `{ done: true }`.
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const events = parser.feed(text);

        for (const sseEvent of events) {
          const result = this._provider!.parseStreamChunk(sseEvent.event, sseEvent.data);
          if (!result) continue;

          if (result.delta && isCurrent()) {
            this._content += result.delta;
            this._scheduleFlush();
          }

          if (result.usage) {
            lastUsage = this._mergeUsage(lastUsage, result.usage);
          }

          if (result.toolCallDeltas) {
            for (const d of result.toolCallDeltas) applyToolCallDelta(d);
          }

          if (result.finishReason !== undefined) {
            lastFinishReason = result.finishReason;
          }

          // Do NOT break the inner loop here: drain same-batch events
          // (notably Gemini's usage-only event immediately following the
          // finishReason-carrying content event when both parse out of
          // one reader.read() buffer). The outer loop still exits on
          // the next while-check.
          if (result.done) streamDone = true;
        }
      }
      // Flush any incomplete multibyte sequence left in the TextDecoder, then
      // flush the SSE parser for any unterminated event.
      const remaining = decoder.decode();
      if (remaining) {
        const remainingEvents = parser.feed(remaining);
        for (const sseEvent of remainingEvents) {
          const result = this._provider!.parseStreamChunk(sseEvent.event, sseEvent.data);
          if (!result) continue;
          if (result.delta && isCurrent()) {
            this._content += result.delta;
          }
          if (result.usage) {
            lastUsage = this._mergeUsage(lastUsage, result.usage);
          }
          if (result.toolCallDeltas) {
            for (const d of result.toolCallDeltas) applyToolCallDelta(d);
          }
          if (result.finishReason !== undefined) {
            lastFinishReason = result.finishReason;
          }
        }
      }
      const trailing = parser.flush();
      if (trailing) {
        const result = this._provider!.parseStreamChunk(trailing.event, trailing.data);
        if (result) {
          if (result.delta && isCurrent()) {
            this._content += result.delta;
          }
          if (result.usage) {
            lastUsage = this._mergeUsage(lastUsage, result.usage);
          }
          if (result.toolCallDeltas) {
            for (const d of result.toolCallDeltas) applyToolCallDelta(d);
          }
          if (result.finishReason !== undefined) {
            lastFinishReason = result.finishReason;
          }
        }
      }
    } finally {
      // `reader.releaseLock()` alone would leave the response body stream
      // alive — an OpenAI-compatible proxy (Ollama / vLLM / LiteLLM) that
      // keeps the HTTP connection open after `[DONE]` / `message_stop`
      // would then hold a socket and any buffered bytes until GC. Calling
      // `reader.cancel()` propagates cancellation to the underlying source
      // so `fetch` can free the socket immediately. Fire-and-forget with a
      // swallowed rejection: awaiting would gate send()'s return on a
      // potentially-slow cancel implementation, and any error here is
      // irrelevant to the caller (the stream is already logically done on
      // the happy path; on the error path the outer try/catch has already
      // captured the failure).
      reader.cancel().catch(() => {});
    }

    if (!isCurrent()) return null;

    // Flush final content synchronously so bindings settle before the next turn
    // (or before send() resolves on the terminal turn).
    this._cancelFlush();
    this._setContent(this._content);
    this._setStreaming(false);

    const toolCalls = this._materializeToolCalls(toolCallAcc);

    return {
      content: this._content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: lastUsage,
      finishReason: lastFinishReason,
    };
  }

  private _materializeToolCalls(acc: Map<number, ToolCallAccumulator>): AiToolCall[] {
    // Order by provider-reported index so parallel tool calls keep their
    // original ordering across turns.
    const indices = Array.from(acc.keys()).sort((a, b) => a - b);
    const result: AiToolCall[] = [];
    for (const i of indices) {
      const entry = acc.get(i)!;
      if (!entry.id || !entry.name) {
        // An accumulator missing id or name is a provider bug or a truncated
        // stream — skip rather than surface a malformed tool call.
        continue;
      }
      result.push({ id: entry.id, name: entry.name, arguments: entry.arguments });
    }
    return result;
  }

  private _mergeUsage(existing: AiUsage | undefined, incoming: Partial<AiUsage>): AiUsage {
    // Streaming providers may emit usage incrementally, so preserve previously known fields.
    const merged = {
      promptTokens: incoming.promptTokens ?? existing?.promptTokens ?? 0,
      completionTokens: incoming.completionTokens ?? existing?.completionTokens ?? 0,
      totalTokens: 0,
    };
    merged.totalTokens = merged.promptTokens + merged.completionTokens;
    return merged;
  }

  private _accumulateUsage(existing: AiUsage | null, incoming: AiUsage): AiUsage {
    if (!existing) return { ...incoming };
    return {
      promptTokens: existing.promptTokens + incoming.promptTokens,
      completionTokens: existing.completionTokens + incoming.completionTokens,
      totalTokens: existing.totalTokens + incoming.totalTokens,
    };
  }
}
