import { warnStreamParseFailure } from "../debug.js";
import {
  IAiProvider, AiMessage, AiUsage, AiRequestOptions, AiProviderRequest,
  AiStreamChunkResult, AiToolCall, AiToolCallDelta, AiContent, AiFinishReason,
} from "../types.js";
import { validateRequestOptions } from "./validateRequestOptions.js";
import { flattenContentToText, parseDataUrl } from "./contentHelpers.js";

// Synthetic id prefix for Gemini tool calls (Gemini's API does not supply ids;
// we encode the function name in the id so the next turn can reconstruct the
// wire-format `functionResponse.name` field without a separate lookup table).
const GEMINI_ID_PREFIX = "gemini:";

export class GoogleProvider implements IAiProvider {
  // Monotonic counter for generating unique synthetic tool-call ids and stream
  // accumulator indices. Instance-scoped; never decreases so collisions are
  // impossible across turns even though AiCore's accumulator resets per-turn.
  private _toolCallCounter = 0;

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

    // Build an id → name map by walking prior assistant tool-calls so tool
    // messages can look up the corresponding function name (and know whether
    // the id was a real Gemini-supplied id or our synthetic fallback).
    const idToName = new Map<string, string>();
    for (const m of nonSystemMessages) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) idToName.set(tc.id, tc.name);
      }
    }

    const body: Record<string, any> = {
      contents: nonSystemMessages.map(m => this._serializeMessage(m, idToName)),
    };
    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map(m => flattenContentToText(m.content)).join("\n\n") }],
      };
    }

    const generationConfig: Record<string, any> = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
    if (options.responseSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = options.responseSchema;
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    if (options.tools && options.tools.length > 0) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
      if (options.toolChoice !== undefined) {
        body.toolConfig = { functionCallingConfig: this._serializeToolChoice(options.toolChoice) };
      }
    }

    return { url, headers, body: JSON.stringify(body) };
  }

  private _serializeMessage(m: AiMessage, idToName: Map<string, string>): Record<string, any> {
    if (m.role === "assistant") {
      const parts: any[] = [];
      const text = flattenContentToText(m.content);
      if (text) parts.push({ text });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          let args: any = {};
          try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; }
          catch { args = {}; }
          // Echo a real Gemini-supplied id (Vertex / newer API versions) but
          // never ship our synthetic `gemini:<name>:<n>` fallback over the
          // wire — the server won't recognise it and might reject or mis-
          // correlate. Name-based correlation is still valid on the public
          // v1beta API where no id is expected.
          const fc: any = { name: tc.name, args };
          if (tc.id && !tc.id.startsWith(GEMINI_ID_PREFIX)) {
            fc.id = tc.id;
          }
          parts.push({ functionCall: fc });
        }
      }
      return { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] };
    }
    if (m.role === "tool") {
      // Recover the function name from the prior assistant tool-call's id
      // when possible; fall back to the synthetic id's embedded name, then to
      // a placeholder. The placeholder path is only hit if history was
      // truncated or the tool message was fabricated without a matching
      // assistant turn.
      const id = m.toolCallId ?? "";
      const name = idToName.get(id)
        ?? this._extractNameFromId(id)
        ?? "unknown_tool";
      const toolText = flattenContentToText(m.content);
      let response: any;
      try { response = toolText ? JSON.parse(toolText) : {}; }
      catch { response = { content: toolText }; }
      const functionResponse: any = { name, response };
      // Only echo the id when it came from the server; our synthetic fallback
      // (prefix `gemini:`) is an internal correlation token and would confuse
      // a real Gemini endpoint.
      if (id && !id.startsWith(GEMINI_ID_PREFIX)) {
        functionResponse.id = id;
      }
      // Gemini's documented Content.role enum is "user" | "model" only; the
      // official function-calling multi-turn example wraps functionResponse
      // parts in a user-role Content. Role "function" was silently tolerated
      // by some legacy SDKs but is rejected / ignored on Vertex and newer
      // v1beta endpoints, so we normalize to "user" here.
      return {
        role: "user",
        parts: [{ functionResponse }],
      };
    }
    // user (multimodal allowed).
    return { role: "user", parts: this._serializeUserParts(m.content) };
  }

  private _serializeUserParts(content: AiContent): any[] {
    if (typeof content === "string") return [{ text: content }];
    return content.map(part => {
      if (part.type === "text") return { text: part.text };
      if (part.type === "image") {
        const dataUrl = parseDataUrl(part.url);
        if (dataUrl) {
          return {
            inlineData: {
              mimeType: part.mediaType ?? dataUrl.mediaType,
              data: dataUrl.data,
            },
          };
        }
        // Gemini's fileData requires a URI it can fetch (Google Files API
        // upload or GCS URI). Arbitrary http(s) URLs are not accepted by the
        // API and will fail the request. Surface this early with a clear
        // error rather than letting Gemini return a cryptic 400.
        throw new Error(
          `[@wc-bindable/ai] Google (Gemini) image input requires a data: URL (base64-encoded). ` +
          `Received "${part.url.slice(0, 50)}${part.url.length > 50 ? "..." : ""}". ` +
          `Fetch the image and encode it to a data: URL before passing it as content.`,
        );
      }
      return part;
    });
  }

  private _serializeToolChoice(choice: NonNullable<AiRequestOptions["toolChoice"]>): any {
    if (choice === "auto") return { mode: "AUTO" };
    if (choice === "none") return { mode: "NONE" };
    if (typeof choice === "object" && choice.name) {
      return { mode: "ANY", allowedFunctionNames: [choice.name] };
    }
    return { mode: "AUTO" };
  }

  parseResponse(data: any): {
    content: string;
    toolCalls?: AiToolCall[];
    usage?: AiUsage;
    finishReason?: AiFinishReason;
  } {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const content = this._extractText(parts);
    const toolCalls = this._extractToolCalls(parts);
    const usage = data?.usageMetadata ? this._parseUsage(data.usageMetadata) : undefined;
    const finishReason = this._normalizeFinishReason(candidate?.finishReason);
    return { content, toolCalls, usage, finishReason };
  }

  parseStreamChunk(event: string | undefined, data: string): AiStreamChunkResult | null {
    try {
      const parsed = JSON.parse(data);
      const candidate = parsed?.candidates?.[0];
      const parts = candidate?.content?.parts;
      const delta = this._extractText(parts) || undefined;
      const usage = parsed?.usageMetadata ? this._parseUsage(parsed.usageMetadata) : undefined;
      const toolCallDeltas = this._extractStreamToolCallDeltas(parts);
      const finishReason = this._normalizeFinishReason(candidate?.finishReason);
      // Gemini has no definitive end-of-stream sentinel comparable to
      // OpenAI `[DONE]` or Anthropic `message_stop`: `finishReason` marks
      // the end of the *content turn* but `usageMetadata` is emitted in a
      // separate SSE event that arrives after it. Setting `done: true`
      // here would cause AiCore to short-circuit the read loop and drop
      // the trailing usage event. We always return `done: false` and let
      // the stream loop exit when the server closes the connection.
      return { delta, usage, toolCallDeltas, finishReason, done: false };
    } catch (error) {
      warnStreamParseFailure("google", event, data, error);
      return null;
    }
  }

  /**
   * Normalize Gemini's `finishReason` enum to AiFinishReason.
   *
   * Safety-adjacent values (`SAFETY`, `RECITATION`, `BLOCKLIST`,
   * `PROHIBITED_CONTENT`, `SPII`, `LANGUAGE`) collapse to `"safety"` even
   * though Gemini distinguishes them internally — the UI-level decision
   * (refusal banner vs. chat bubble) is the same for all of them. Consumers
   * that need per-category triage should inspect the raw provider response
   * via a custom provider subclass or proxy-layer tagging.
   */
  private _normalizeFinishReason(raw: unknown): AiFinishReason | undefined {
    if (typeof raw !== "string" || !raw) return undefined;
    switch (raw) {
      case "STOP":
        return "stop";
      case "MAX_TOKENS":
        return "length";
      case "SAFETY":
      case "RECITATION":
      case "BLOCKLIST":
      case "PROHIBITED_CONTENT":
      case "SPII":
      case "LANGUAGE":
        return "safety";
      default:
        // OTHER, MALFORMED_FUNCTION_CALL, FINISH_REASON_UNSPECIFIED, and any
        // unknown / future values fall through — consumers can still read
        // `messages[*].finishReason === "other"` to distinguish an
        // unclassifiable stop from a clean `"stop"`.
        return "other";
    }
  }

  private _extractText(parts: any): string {
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("");
  }

  private _extractToolCalls(parts: any): AiToolCall[] | undefined {
    if (!Array.isArray(parts)) return undefined;
    const out: AiToolCall[] = [];
    for (const p of parts) {
      const fc = p?.functionCall;
      if (!fc?.name) continue;
      // Preserve a server-supplied id verbatim (Vertex / newer Gemini API
      // versions include one to disambiguate parallel same-name calls). Fall
      // back to a synthetic id that encodes the function name for the public
      // v1beta endpoint where functionCall.id is not part of the schema.
      const id = typeof fc.id === "string" && fc.id
        ? fc.id
        : this._generateId(fc.name);
      out.push({
        id,
        name: fc.name,
        arguments: JSON.stringify(fc.args ?? {}),
      });
    }
    return out.length > 0 ? out : undefined;
  }

  private _extractStreamToolCallDeltas(parts: any): AiToolCallDelta[] | undefined {
    if (!Array.isArray(parts)) return undefined;
    const out: AiToolCallDelta[] = [];
    for (const p of parts) {
      const fc = p?.functionCall;
      if (!fc?.name) continue;
      // Gemini emits each functionCall as a complete object in one chunk rather
      // than delta-streaming the args (unlike OpenAI/Anthropic). Treat each
      // appearance as an atomic tool-call delta with a fresh index so parallel
      // calls in a single turn keep separate entries in AiCore's accumulator.
      const index = this._toolCallCounter++;
      // Same id-preservation policy as non-streaming parseResponse: use the
      // server-supplied id when present for disambiguating parallel calls on
      // Vertex / newer APIs; synthetic fallback for the public v1beta API.
      const id = typeof fc.id === "string" && fc.id
        ? fc.id
        : this._generateId(fc.name);
      out.push({
        index,
        id,
        name: fc.name,
        argumentsDelta: JSON.stringify(fc.args ?? {}),
      });
    }
    return out.length > 0 ? out : undefined;
  }

  private _generateId(name: string): string {
    // Encode the function name inside the id so _serializeMessage can recover
    // it when serializing a tool-result message back to Gemini's wire format.
    return `${GEMINI_ID_PREFIX}${name}:${this._toolCallCounter++}`;
  }

  private _extractNameFromId(id: string): string | null {
    if (!id.startsWith(GEMINI_ID_PREFIX)) return null;
    const rest = id.slice(GEMINI_ID_PREFIX.length);
    const colonIdx = rest.lastIndexOf(":");
    return colonIdx === -1 ? rest : rest.slice(0, colonIdx);
  }

  private _parseUsage(usage: any): AiUsage {
    const promptTokens = Number(usage.promptTokenCount) || 0;
    const completionTokens = Number(usage.candidatesTokenCount) || 0;
    const totalTokens = Number(usage.totalTokenCount) || (promptTokens + completionTokens);
    return { promptTokens, completionTokens, totalTokens };
  }
}
