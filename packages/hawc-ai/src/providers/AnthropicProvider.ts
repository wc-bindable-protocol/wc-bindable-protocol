import { warnStreamParseFailure } from "../debug.js";
import {
  IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiProviderRequest,
  AiStreamChunkResult, AiToolCall, AiContent,
} from "../types.js";
import { validateRequestOptions } from "./validateRequestOptions.js";
import { flattenContentToText, parseDataUrl } from "./contentHelpers.js";

// Reserved tool name used internally when emulating structured-output on
// Anthropic (which lacks a native response_format/json_schema parameter).
// Responses whose only tool_use block carries this name are unwrapped back
// into a JSON string content by parseResponse, so callers see structured
// output the same way as with OpenAI/Google.
const STRUCTURED_OUTPUT_TOOL = "__wc_bindable_structured_response__";

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
      messages: nonSystemMessages.map(m => this._serializeMessage(m)),
      // Anthropic API requires max_tokens; fall back to a sane default when omitted.
      max_tokens: options.maxTokens ?? 4096,
      stream: options.stream ?? true,
    };
    if (systemMessages.length > 0) {
      body.system = systemMessages.map(m => flattenContentToText(m.content)).join("\n\n");
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        // Anthropic calls the JSON Schema field `input_schema`, unlike OpenAI's `parameters`.
        input_schema: t.parameters,
      }));
      if (options.toolChoice !== undefined) {
        body.tool_choice = this._serializeToolChoice(options.toolChoice);
      }
    }
    // Anthropic has no native response_format. Emulate by forcing a single
    // synthetic tool whose input_schema matches the requested shape; the
    // model's tool_use input then carries the structured payload. Streaming
    // this reliably would require tracking which content-block index is the
    // synthetic tool across stateless parseStreamChunk calls — defer to a
    // non-streaming round-trip for v1.
    if (options.responseSchema) {
      body.stream = false;
      const syntheticTool = {
        name: STRUCTURED_OUTPUT_TOOL,
        description: "Emit the final response as structured JSON conforming to the provided schema.",
        input_schema: options.responseSchema,
      };
      body.tools = [syntheticTool, ...(body.tools ?? [])];
      body.tool_choice = { type: "tool", name: STRUCTURED_OUTPUT_TOOL };
    }

    return { url, headers, body: JSON.stringify(body) };
  }

  private _serializeMessage(m: AiMessage): Record<string, any> {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: any[] = [];
      const text = flattenContentToText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.toolCalls) {
        let input: any = {};
        try { input = tc.arguments ? JSON.parse(tc.arguments) : {}; }
        catch { input = {}; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      return { role: "assistant", content: blocks };
    }
    if (m.role === "tool") {
      // Anthropic models tool results as user-role messages carrying tool_result blocks.
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: flattenContentToText(m.content),
        }],
      };
    }
    // user / assistant (no tool calls): allow multimodal passthrough.
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    return { role: m.role, content: this._serializeContentBlocks(m.content) };
  }

  private _serializeContentBlocks(content: Exclude<AiContent, string>): any[] {
    return content.map(part => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image") {
        // Anthropic accepts either { source: { type: "url", url } } (newer API)
        // or { source: { type: "base64", media_type, data } } (historical).
        // Route data: URLs through base64 for broadest compatibility; http(s)
        // URLs use the `url` source.
        const dataUrl = parseDataUrl(part.url);
        if (dataUrl) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType ?? dataUrl.mediaType,
              data: dataUrl.data,
            },
          };
        }
        return {
          type: "image",
          source: { type: "url", url: part.url },
        };
      }
      return part;
    });
  }

  private _serializeToolChoice(choice: NonNullable<AiRequestOptions["toolChoice"]>): any {
    if (choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "none" };
    if (typeof choice === "object" && choice.name) return { type: "tool", name: choice.name };
    return { type: "auto" };
  }

  parseResponse(data: any): { content: string; toolCalls?: AiToolCall[]; usage?: AiUsage } {
    const blocks = Array.isArray(data.content) ? data.content : [];
    const usage = data.usage ? this._parseUsage(data.usage) : undefined;

    // Structured-output emulation: a tool_use block with the reserved name is
    // unwrapped back into a JSON content string; tools field stays empty so
    // the caller sees a plain structured response rather than a tool-use turn.
    const structuredBlock = blocks.find((b: any) => b.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL);
    if (structuredBlock) {
      return {
        content: JSON.stringify(structuredBlock.input ?? {}),
        usage,
      };
    }

    const content = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    let toolCalls: AiToolCall[] | undefined;
    if (toolUseBlocks.length > 0) {
      const extracted: AiToolCall[] = toolUseBlocks
        .filter((b: any) => b.id && b.name)
        .map((b: any) => ({
          id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        }));
      if (extracted.length > 0) toolCalls = extracted;
    }
    return { content, toolCalls, usage };
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

      // tool_use block starts: capture id and name for this content-block index.
      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
        const cb = parsed.content_block;
        if (typeof parsed.index === "number" && cb.id && cb.name) {
          return {
            toolCallDeltas: [{ index: parsed.index, id: cb.id, name: cb.name }],
            done: false,
          };
        }
        return null;
      }

      // tool_use argument deltas: partial JSON fragments of the input object.
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
        if (typeof parsed.index === "number") {
          return {
            toolCallDeltas: [{
              index: parsed.index,
              argumentsDelta: parsed.delta.partial_json ?? "",
            }],
            done: false,
          };
        }
        return null;
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
