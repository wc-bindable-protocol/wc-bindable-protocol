export interface ITagNames {
  readonly ai: string;
  readonly aiMessage: string;
}

export interface IWritableTagNames {
  ai?: string;
  aiMessage?: string;
}

export interface IRemoteConfig {
  readonly enableRemote: boolean;
  readonly remoteSettingType: "env" | "config";
  readonly remoteCoreUrl: string;
}

export interface IWritableRemoteConfig {
  enableRemote?: boolean;
  remoteSettingType?: "env" | "config";
  remoteCoreUrl?: string;
}

export interface IConfig {
  readonly autoTrigger: boolean;
  readonly triggerAttribute: string;
  readonly tagNames: ITagNames;
  readonly remote: IRemoteConfig;
}

export interface IWritableConfig {
  autoTrigger?: boolean;
  triggerAttribute?: string;
  tagNames?: IWritableTagNames;
  remote?: IWritableRemoteConfig;
}

export interface IWcBindableProperty {
  readonly name: string;
  readonly event: string;
  readonly getter?: (event: Event) => any;
}

export interface IWcBindableInput {
  readonly name: string;
  readonly attribute?: string;
}

export interface IWcBindableCommand {
  readonly name: string;
  readonly async?: boolean;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: 1;
  readonly properties: IWcBindableProperty[];
  readonly inputs?: IWcBindableInput[];
  readonly commands?: IWcBindableCommand[];
}

export type AiRole = "system" | "user" | "assistant" | "tool";

/**
 * Unified finish-reason enum. Providers ship distinct vocabularies
 * (OpenAI `stop|length|tool_calls|content_filter|function_call`,
 * Anthropic `end_turn|max_tokens|stop_sequence|tool_use|refusal|pause_turn`,
 * Google `STOP|MAX_TOKENS|SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|LANGUAGE|OTHER|...`);
 * each provider normalizes its native value into this enum.
 *
 * - `"stop"`: model completed naturally (OpenAI `stop`, Anthropic `end_turn`/`stop_sequence`, Google `STOP`).
 * - `"length"`: output was cut off by max-token budget.
 * - `"tool_use"`: turn ended because the assistant requested a tool call.
 *   Present even when the loop auto-executes the tool — consumers reading
 *   `messages[*].finishReason` can distinguish intermediate tool-use turns
 *   from the terminal assistant turn.
 * - `"safety"`: refused / blocked by provider safety classifier
 *   (OpenAI `content_filter`, Anthropic `refusal`,
 *   Google `SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|LANGUAGE`).
 *   Not an error — `send()` still resolves normally. Use this flag to branch
 *   UI (e.g. show a "declined" banner instead of a chat bubble).
 * - `"other"`: anything the library cannot confidently bucket (Anthropic
 *   `pause_turn`, Google `OTHER|MALFORMED_FUNCTION_CALL`, unknown strings
 *   from provider-proxy extensions). Do not treat as stop — inspect the
 *   raw provider response if disambiguation matters.
 */
export type AiFinishReason = "stop" | "length" | "tool_use" | "safety" | "other";

export interface AiToolCall {
  id: string;
  name: string;
  // Providers return arguments as a JSON string (OpenAI/Azure) or object
  // (Anthropic/Google). We normalize to a JSON string so consumers parse once,
  // and providers stringify once when emitting.
  arguments: string;
}

export interface AiContentTextPart {
  type: "text";
  text: string;
}

export interface AiContentImagePart {
  type: "image";
  // http(s):// URL or a data:image/...;base64,... URL. Providers that cannot
  // consume external URLs directly (Google Gemini) accept only data: URLs;
  // the caller is responsible for fetching+encoding in that case.
  url: string;
  // Hint for providers that need an explicit media type when the URL alone
  // doesn't reveal it (Anthropic's base64 source, Gemini's inlineData).
  // Defaults to inference from the data: URL header when omitted.
  mediaType?: string;
}

export type AiContentPart = AiContentTextPart | AiContentImagePart;

// Message content is either a plain string (text-only, the common case) or
// an ordered array of parts (multimodal). Providers accept arrays on user
// messages; assistant/system/tool messages that carry an array are flattened
// to the concatenated text parts before being sent on the wire.
export type AiContent = string | AiContentPart[];

export interface AiMessage {
  role: AiRole;
  content: AiContent;
  // Assistant turn's tool call requests, when present. Absence or empty array
  // means "no tools requested" — a terminal assistant message.
  toolCalls?: AiToolCall[];
  // Set only when role === "tool". Correlates this message with the assistant
  // tool call that produced it via AiToolCall.id.
  toolCallId?: string;
  // Populated by AiCore on assistant messages it appends to history. Normalized
  // from the provider's native finish/stop field; see AiFinishReason. Absent on
  // user / system / tool messages and on history injected via `messages =`
  // (assign it yourself if the history you're restoring carried one).
  finishReason?: AiFinishReason;
  // Provider-specific hints the default transport cannot express through the
  // neutral surface (prompt caching, safety-setting overrides, etc.). Keyed by
  // provider namespace so unrelated providers ignore each other's hints:
  //
  //   providerHints: { anthropic: { cacheControl: { type: "ephemeral" } } }
  //
  // The library passes the inner object through verbatim at wire-build time —
  // no schema validation, no normalization. A misspelled key is a silent no-op
  // rather than a request-time error. Consult each provider's docs for the
  // accepted shapes (supported keys listed in README §Provider Details).
  providerHints?: Record<string, any>;
}

export interface AiTool {
  name: string;
  description: string;
  // JSON Schema describing the argument shape. Passed to providers as-is.
  parameters: Record<string, any>;
  // Handler invoked with parsed arguments. Return value is stringified via
  // JSON.stringify when not already a string, and delivered as the tool
  // message content in the next turn.
  //
  // Optional so remote deployments can send tool declarations over the wire
  // (handlers are not serializable). When absent, AiCore falls back to the
  // process-wide registry populated via `registerTool()`. At least one of the
  // two must be present at invocation time, or the call resolves to an error
  // tool message.
  handler?: (args: any) => unknown | Promise<unknown>;
}

export type AiToolChoice = "auto" | "none" | { name: string };

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiRequestOptions {
  model: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  apiKey?: string;
  baseUrl?: string;
  apiVersion?: string;
  tools?: AiTool[];
  toolChoice?: AiToolChoice;
  // Defaults to 10. Guards against infinite tool-use loops when a model keeps
  // requesting tools indefinitely.
  maxToolRoundtrips?: number;
  // JSON Schema constraining the final assistant response to a structured
  // object. Providers that support it natively (OpenAI/Azure/Google) set
  // response_format / responseSchema; Anthropic is supported via a synthetic
  // tool-use turn. Mutually exclusive with `tools`. The returned content is
  // the JSON-stringified object; the consumer calls JSON.parse themselves.
  responseSchema?: Record<string, any>;
  // Optional name tag forwarded to providers that accept it (OpenAI's
  // json_schema.name). Defaults to "response".
  responseSchemaName?: string;
}

export interface AiProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface AiToolCallDelta {
  // Provider-reported index identifying which tool call in the current
  // assistant turn this delta refers to. Required because multiple tool
  // calls may be emitted in parallel within a single streamed turn.
  index: number;
  id?: string;
  name?: string;
  // Fragment of the arguments JSON string; accumulated across deltas by AiCore.
  argumentsDelta?: string;
}

export interface AiStreamChunkResult {
  delta?: string;
  usage?: Partial<AiUsage>;
  // Providers may emit multiple tool-call deltas per SSE event (OpenAI does
  // this for parallel tool calls). Keep as an array so each delta can carry
  // its own `index`.
  toolCallDeltas?: AiToolCallDelta[];
  // Normalized finish reason reported by the provider on the terminal chunk
  // of a turn. Streamed turns may emit `finishReason` on the same chunk as
  // the stream sentinel (OpenAI, Anthropic) or on a content-block chunk
  // shortly before a separate usage-only chunk (Gemini). AiCore keeps the
  // *last* non-undefined value seen across the turn.
  finishReason?: AiFinishReason;
  done: boolean;
}

export interface IAiProvider {
  buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest;
  parseResponse(data: any): {
    content: string;
    toolCalls?: AiToolCall[];
    usage?: AiUsage;
    finishReason?: AiFinishReason;
  };
  parseStreamChunk(event: string | undefined, data: string): AiStreamChunkResult | null;
}

export interface AiHttpError {
  status: number;
  statusText: string;
  body: string;
  // Seconds to wait before retrying, parsed from the response's `Retry-After`
  // header when present. Populated on any status that ships the header (most
  // commonly 429 and 503, occasionally 529 from Anthropic on overload). Both
  // delta-seconds and HTTP-date forms of the header are normalized to seconds;
  // past-dated or unparseable values are omitted. The library itself still does
  // not retry — this is exposed so a consumer building a retry queue can honor
  // the provider's hint without reparsing `body`.
  retryAfter?: number;
}

export interface WcsAiCoreValues {
  content: string;
  messages: AiMessage[];
  usage: AiUsage | null;
  loading: boolean;
  streaming: boolean;
  error: AiHttpError | Error | null;
}

export interface WcsAiValues extends WcsAiCoreValues {
  trigger: boolean;
}
