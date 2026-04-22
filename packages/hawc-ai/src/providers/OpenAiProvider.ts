import { warnStreamParseFailure } from "../debug.js";
import {
  IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiProviderRequest,
  AiStreamChunkResult, AiToolCall, AiToolCallDelta, AiContent, AiFinishReason,
} from "../types.js";
import { validateRequestOptions } from "./validateRequestOptions.js";
import { flattenContentToText } from "./contentHelpers.js";

export class OpenAiProvider implements IAiProvider {
  buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest {
    validateRequestOptions(options);
    const baseUrl = options.baseUrl || "https://api.openai.com";
    const url = `${baseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.apiKey) {
      headers["Authorization"] = `Bearer ${options.apiKey}`;
    }

    const body: Record<string, any> = {
      model: options.model,
      messages: messages.map(m => this._serializeMessage(m)),
      stream: options.stream ?? true,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    // stream_options is an OpenAI-specific extension; omit it for custom base URLs
    // (e.g. Ollama, vLLM) where it may cause 400 errors.
    if (body.stream && baseUrl === "https://api.openai.com") {
      body.stream_options = { include_usage: true };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      if (options.toolChoice !== undefined) {
        body.tool_choice = this._serializeToolChoice(options.toolChoice);
      }
    }
    if (options.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.responseSchemaName ?? "response",
          schema: options.responseSchema,
          strict: true,
        },
      };
    }

    return { url, headers, body: JSON.stringify(body) };
  }

  protected _serializeMessage(m: AiMessage): Record<string, any> {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const text = flattenContentToText(m.content);
      return {
        role: "assistant",
        // OpenAI accepts empty string but null is more conventional when content is absent.
        content: text || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: flattenContentToText(m.content), tool_call_id: m.toolCallId };
    }
    if (m.role === "system") {
      return { role: "system", content: flattenContentToText(m.content) };
    }
    if (m.role === "assistant") {
      // Assistant history is flattened to text per the AiContent contract:
      // multimodal parts (images) are only valid on user turns. Passing an
      // assistant array through verbatim risks shipping image_url blocks on
      // a role that the provider does not accept them on.
      return { role: "assistant", content: flattenContentToText(m.content) };
    }
    // user: allow multimodal array passthrough.
    return { role: m.role, content: this._serializeContent(m.content) };
  }

  protected _serializeContent(content: AiContent): string | any[] {
    if (typeof content === "string") return content;
    return content.map(part => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image") {
        return { type: "image_url", image_url: { url: part.url } };
      }
      return part;
    });
  }

  protected _serializeToolChoice(choice: NonNullable<AiRequestOptions["toolChoice"]>): any {
    if (choice === "auto" || choice === "none") return choice;
    if (typeof choice === "object" && choice.name) {
      return { type: "function", function: { name: choice.name } };
    }
    return "auto";
  }

  parseResponse(data: any): {
    content: string;
    toolCalls?: AiToolCall[];
    usage?: AiUsage;
    finishReason?: AiFinishReason;
  } {
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const content = msg?.content ?? "";
    const usage = data.usage ? this._parseUsage(data.usage) : undefined;
    const finishReason = this._normalizeFinishReason(choice?.finish_reason);
    let toolCalls: AiToolCall[] | undefined;
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      const extracted: AiToolCall[] = [];
      for (const tc of msg.tool_calls) {
        if (tc?.type !== "function") continue;
        const name = tc?.function?.name;
        if (!name || !tc?.id) continue;
        extracted.push({
          id: tc.id,
          name,
          arguments: tc.function?.arguments ?? "",
        });
      }
      if (extracted.length > 0) toolCalls = extracted;
    }
    return { content, toolCalls, usage, finishReason };
  }

  parseStreamChunk(_event: string | undefined, data: string): AiStreamChunkResult | null {
    if (data === "[DONE]") return { done: true };

    try {
      const parsed = JSON.parse(data);
      const choice = parsed.choices?.[0];
      const delta = choice?.delta?.content || undefined;
      const usage = parsed.usage ? this._parseUsage(parsed.usage) : undefined;
      const toolCallDeltas = this._extractToolCallDeltas(choice?.delta?.tool_calls);
      const finishReason = this._normalizeFinishReason(choice?.finish_reason);
      // Asymmetry: only `tool_calls` ends the stream early here. For `stop`,
      // `length`, `content_filter`, `function_call` the OpenAI (and
      // OpenAI-compatible: Azure, Ollama, vLLM, LiteLLM) stream still emits
      // a trailing usage-only chunk followed by the `[DONE]` sentinel, and
      // AiCore relies on reading that usage before closing the turn. For
      // `tool_calls` some proxies never emit `[DONE]` after the final
      // arguments delta, so without an early `done` flag the read loop
      // would hang until the server closed the socket. Usage is not
      // available on `tool_calls` chunks on those proxies anyway, so the
      // early exit loses nothing.
      const done = choice?.finish_reason === "tool_calls";
      return { delta, usage, toolCallDeltas, finishReason, done };
    } catch (error) {
      warnStreamParseFailure("openai", _event, data, error);
      return null;
    }
  }

  /**
   * Normalize OpenAI's `finish_reason` (also shared with Azure and
   * OpenAI-compatible proxies like Ollama, vLLM, LiteLLM) to AiFinishReason.
   *
   * `function_call` is the deprecated pre-tool_calls name for the same event
   * — mapped identically so a proxy that still emits the legacy value is not
   * misclassified. Unknown / future values fall through to `"other"`.
   */
  protected _normalizeFinishReason(raw: unknown): AiFinishReason | undefined {
    if (typeof raw !== "string" || !raw) return undefined;
    switch (raw) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      case "tool_calls":
      case "function_call":
        return "tool_use";
      case "content_filter":
        return "safety";
      default:
        return "other";
    }
  }

  protected _extractToolCallDeltas(rawDeltas: any): AiToolCallDelta[] | undefined {
    if (!Array.isArray(rawDeltas) || rawDeltas.length === 0) return undefined;
    const out: AiToolCallDelta[] = [];
    for (const d of rawDeltas) {
      if (typeof d?.index !== "number") continue;
      const delta: AiToolCallDelta = { index: d.index };
      if (typeof d.id === "string") delta.id = d.id;
      if (typeof d.function?.name === "string") delta.name = d.function.name;
      if (typeof d.function?.arguments === "string") delta.argumentsDelta = d.function.arguments;
      out.push(delta);
    }
    return out.length > 0 ? out : undefined;
  }

  protected _parseUsage(usage: any): AiUsage {
    const promptTokens = Number(usage.prompt_tokens) || 0;
    const completionTokens = Number(usage.completion_tokens) || 0;
    const totalTokens = Number(usage.total_tokens) || (promptTokens + completionTokens);
    return { promptTokens, completionTokens, totalTokens };
  }
}
