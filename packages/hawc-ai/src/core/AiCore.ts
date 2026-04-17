import { raiseError } from "../raiseError.js";
import {
  IWcBindable, IAiProvider, AiMessage, AiUsage, AiRequestOptions,
} from "../types.js";
import { SseParser } from "../streaming/SseParser.js";
import { OpenAiProvider } from "../providers/OpenAiProvider.js";
import { AnthropicProvider } from "../providers/AnthropicProvider.js";
import { AzureOpenAiProvider } from "../providers/AzureOpenAiProvider.js";
import { GoogleProvider } from "../providers/GoogleProvider.js";

function resolveProvider(name: string): IAiProvider {
  switch (name) {
    case "openai": return new OpenAiProvider();
    case "anthropic": return new AnthropicProvider();
    case "azure-openai": return new AzureOpenAiProvider();
    case "google": return new GoogleProvider();
    default: raiseError(`Unknown provider: "${name}". Use "openai", "anthropic", "azure-openai", or "google".`);
  }
}

/**
 * Headless AI inference core.
 * Manages conversation history, streaming, and rAF-batched content updates.
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

  send(prompt: string, options: AiRequestOptions): Promise<string | null> {
    if (!prompt) raiseError("prompt is required.");
    if (!this._provider) raiseError("provider is required. Set provider before calling send().");
    if (!options.model) raiseError("model is required. See @wc-bindable/hawc-ai README §Supported Providers for each provider's model catalog (no default is shipped because model identifiers drift faster than library releases).");
    if (options.temperature !== undefined && !Number.isFinite(options.temperature)) {
      raiseError(`temperature must be a finite number, got ${options.temperature}.`);
    }
    if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
      raiseError(`maxTokens must be a positive integer, got ${options.maxTokens}.`);
    }
    return this._doSend(prompt, options);
  }

  // --- Internal ---

  private async _doSend(prompt: string, options: AiRequestOptions): Promise<string | null> {
    this.abort();
    const abortController = new AbortController();
    this._abortController = abortController;
    const { signal } = abortController;
    const isCurrent = () => this._abortController === abortController;

    this._setLoading(true);
    this._setStreaming(false);
    this._setError(null);
    this._setUsage(null);
    this._content = "";
    this._setContent("");

    // Keep the exact message reference so abort can remove it precisely from history.
    const userMessage: AiMessage = { role: "user", content: prompt };
    this._messages.push(userMessage);
    this._emitMessages();

    // Build the API message list from the optional system prompt plus current history.
    const apiMessages: AiMessage[] = [];
    if (options.system) {
      apiMessages.push({ role: "system", content: options.system });
    }
    apiMessages.push(...this._messages);

    try {
      const request = this._provider!.buildRequest(apiMessages, options);
      const response = await globalThis.fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        this._removeMessage(userMessage);
        if (isCurrent()) {
          this._setError({ status: response.status, statusText: response.statusText, body: errorBody });
          this._setLoading(false);
        }
        return null;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const isEventStream = contentType.includes("text/event-stream");
      const shouldStream = (options.stream !== false) && isEventStream && response.body;
      if (shouldStream) {
        const streamResult = await this._processStream(response.body!, abortController);
        if (!isCurrent()) this._removeMessage(userMessage);
        return streamResult;
      } else {
        const data = await response.json();
        const result = this._provider!.parseResponse(data);
        if (!isCurrent()) {
          this._removeMessage(userMessage);
          return null;
        }
        this._content = result.content;
        this._setContent(this._content);
        if (result.usage) this._setUsage(result.usage);
        this._messages.push({ role: "assistant", content: this._content });
        this._emitMessages();
        this._setLoading(false);
        return this._content;
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        this._removeMessage(userMessage);
        if (isCurrent()) {
          this._setStreaming(false);
          this._setLoading(false);
        }
        return null;
      }
      this._removeMessage(userMessage);
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

  private _removeMessage(message: AiMessage): void {
    const idx = this._messages.indexOf(message);
    if (idx === -1) return;
    this._messages.splice(idx, 1);
    this._emitMessages();
  }

  private async _processStream(body: ReadableStream<Uint8Array>, abortController: AbortController): Promise<string | null> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let lastUsage: AiUsage | undefined;
    const isCurrent = () => this._abortController === abortController;

    this._setStreaming(true);

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
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Avoid mutating shared state if a newer send() has already replaced this request.
    if (!isCurrent()) return null;

    // Flush the final content synchronously.
    this._cancelFlush();
    this._setContent(this._content);

    if (lastUsage) this._setUsage(lastUsage);
    this._messages.push({ role: "assistant", content: this._content });
    this._emitMessages();
    this._setStreaming(false);
    this._setLoading(false);

    return this._content;
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
}
