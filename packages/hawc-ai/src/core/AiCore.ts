import { raiseError } from "../raiseError.js";
import {
  IWcBindable, IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiTool, AiToolCall,
  AiContent, AiContentPart,
} from "../types.js";
import { assertKnownContentParts } from "../providers/contentHelpers.js";
import { SseParser } from "../streaming/SseParser.js";
import { OpenAiProvider } from "../providers/OpenAiProvider.js";
import { AnthropicProvider } from "../providers/AnthropicProvider.js";
import { AzureOpenAiProvider } from "../providers/AzureOpenAiProvider.js";
import { GoogleProvider } from "../providers/GoogleProvider.js";
import { getRegisteredTool } from "../toolRegistry.js";

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
    return this._messages.map(m => ({ ...m }));
  }

  set messages(value: AiMessage[]) {
    this._messages = value.map(m => ({ ...m }));
    this._emitMessages();
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
    // don't touch each other's history.
    const pushedMessages: AiMessage[] = [];
    const pushMessage = (m: AiMessage) => {
      this._messages.push(m);
      pushedMessages.push(m);
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

    const userContent: AiContent = typeof prompt === "string" ? prompt : prompt;
    pushMessage({ role: "user", content: userContent });

    const tools = options.tools ?? [];
    const toolsByName = new Map<string, AiTool>(tools.map(t => [t.name, t]));
    const maxRoundtrips = options.maxToolRoundtrips ?? DEFAULT_MAX_TOOL_ROUNDTRIPS;

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

        const turn = await this._fetchTurn(apiMessages, options, abortController);
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

        const assistantMessage: AiMessage = { role: "assistant", content: turn.content };
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          assistantMessage.toolCalls = turn.toolCalls;
        }
        pushMessage(assistantMessage);
        lastAssistantContent = turn.content;

        if (!turn.toolCalls || turn.toolCalls.length === 0) {
          // Terminal turn: model did not request more tools.
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
        const toolResults = await Promise.all(turn.toolCalls.map(async (call) => {
          this._target.dispatchEvent(new CustomEvent("hawc-ai:tool-call-requested", {
            detail: { toolCall: { ...call } },
            bubbles: true,
          }));
          const tool = toolsByName.get(call.name);
          // Handler resolution order: per-call `tool.handler`, then the
          // process-wide registry populated via `registerTool()`. The latter
          // is how server-side deployments supply handlers when the Shell
          // sends tool declarations over WebSocket without their functions.
          const handler = tool?.handler ?? getRegisteredTool(call.name);
          if (!handler) {
            const reason = tool
              ? `Tool "${call.name}" has no handler (neither on the options.tools entry nor in the process registry).`
              : `Tool "${call.name}" is not defined on this send() invocation.`;
            const content = JSON.stringify({ error: reason });
            this._target.dispatchEvent(new CustomEvent("hawc-ai:tool-call-completed", {
              detail: { toolCall: { ...call }, error: `unknown tool: ${call.name}` },
              bubbles: true,
            }));
            return { toolCallId: call.id, content };
          }
          try {
            const args = call.arguments ? JSON.parse(call.arguments) : {};
            const result = await handler(args);
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
        this._setError({ status: response.status, statusText: response.statusText, body: errorBody });
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

          if (result.done) {
            streamDone = true;
            break;
          }
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
        }
      }
    } finally {
      reader.releaseLock();
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
