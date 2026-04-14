import { warnStreamParseFailure } from "../debug.js";
import { IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiProviderRequest, AiStreamChunkResult } from "../types.js";
import { validateRequestOptions } from "./validateRequestOptions.js";

export class AnthropicProvider implements IAiProvider {
  buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest {
    validateRequestOptions(options);
    const baseUrl = options.baseUrl || "https://api.anthropic.com";
    const url = `${baseUrl}/v1/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (options.apiKey) {
      headers["x-api-key"] = options.apiKey;
    }

    const systemMessages = messages.filter(m => m.role === "system");
    const nonSystemMessages = messages.filter(m => m.role !== "system");

    const body: Record<string, any> = {
      model: options.model,
      messages: nonSystemMessages.map(m => ({ role: m.role, content: m.content })),
      // Anthropic API requires max_tokens; fall back to a sane default when omitted.
      max_tokens: options.maxTokens ?? 4096,
      stream: options.stream ?? true,
    };
    if (systemMessages.length > 0) {
      body.system = systemMessages.map(m => m.content).join("\n\n");
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;

    return { url, headers, body: JSON.stringify(body) };
  }

  parseResponse(data: any): { content: string; usage?: AiUsage } {
    const content = Array.isArray(data.content)
      ? data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : "";
    const usage = data.usage ? this._parseUsage(data.usage) : undefined;
    return { content, usage };
  }

  private _parseUsage(usage: any): AiUsage {
    const promptTokens = Number(usage.input_tokens) || 0;
    const completionTokens = Number(usage.output_tokens) || 0;
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  parseStreamChunk(event: string | undefined, data: string): AiStreamChunkResult | null {
    if (event === "message_stop") return { done: true };

    try {
      const parsed = JSON.parse(data);

      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
        return { delta: parsed.delta.text, done: false };
      }

      if (parsed.type === "message_start" && parsed.message?.usage) {
        // Anthropic reports input_tokens up front, so keep the initial usage snapshot here.
        return { usage: this._parseUsage(parsed.message.usage), done: false };
      }

      if (parsed.type === "message_delta" && parsed.usage) {
        // Later deltas update only output_tokens; AiCore merges this partial usage with the earlier snapshot.
        // Leave completionTokens undefined when output_tokens is absent so _mergeUsage preserves the prior value.
        const outputTokens = parsed.usage.output_tokens;
        return {
          usage: { completionTokens: outputTokens != null ? Number(outputTokens) : undefined },
          done: false,
        };
      }

      return null;
    } catch (error) {
      warnStreamParseFailure("anthropic", event, data, error);
      return null;
    }
  }
}
