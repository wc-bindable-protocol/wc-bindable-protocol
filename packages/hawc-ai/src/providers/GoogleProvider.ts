import { warnStreamParseFailure } from "../debug.js";
import { IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiProviderRequest, AiStreamChunkResult } from "../types.js";
import { validateRequestOptions } from "./validateRequestOptions.js";

export class GoogleProvider implements IAiProvider {
  buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest {
    validateRequestOptions(options);
    const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";
    const stream = options.stream ?? true;
    // Gemini uses ?alt=sse to force SSE framing; without it, streaming endpoints
    // emit a chunked JSON array that SseParser cannot consume.
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `${baseUrl}/v1beta/models/${options.model}:${action}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.apiKey) {
      headers["x-goog-api-key"] = options.apiKey;
    }

    const systemMessages = messages.filter(m => m.role === "system");
    const nonSystemMessages = messages.filter(m => m.role !== "system");

    const body: Record<string, any> = {
      contents: nonSystemMessages.map(m => ({
        // Gemini uses "model" for the assistant turn; "user" stays as-is.
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    };
    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map(m => m.content).join("\n\n") }],
      };
    }

    const generationConfig: Record<string, any> = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    return { url, headers, body: JSON.stringify(body) };
  }

  parseResponse(data: any): { content: string; usage?: AiUsage } {
    const content = this._extractText(data?.candidates?.[0]?.content?.parts);
    const usage = data?.usageMetadata ? this._parseUsage(data.usageMetadata) : undefined;
    return { content, usage };
  }

  parseStreamChunk(event: string | undefined, data: string): AiStreamChunkResult | null {
    try {
      const parsed = JSON.parse(data);
      const candidate = parsed?.candidates?.[0];
      const delta = this._extractText(candidate?.content?.parts) || undefined;
      const usage = parsed?.usageMetadata ? this._parseUsage(parsed.usageMetadata) : undefined;
      // finishReason is set on the terminal chunk (STOP, MAX_TOKENS, SAFETY, etc.).
      // Absence means more chunks follow.
      const done = candidate?.finishReason != null;
      return { delta, usage, done };
    } catch (error) {
      warnStreamParseFailure("google", event, data, error);
      return null;
    }
  }

  private _extractText(parts: any): string {
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("");
  }

  private _parseUsage(usage: any): AiUsage {
    const promptTokens = Number(usage.promptTokenCount) || 0;
    const completionTokens = Number(usage.candidatesTokenCount) || 0;
    const totalTokens = Number(usage.totalTokenCount) || (promptTokens + completionTokens);
    return { promptTokens, completionTokens, totalTokens };
  }
}
