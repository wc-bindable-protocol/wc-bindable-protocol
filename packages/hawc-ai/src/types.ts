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

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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
}

export interface AiProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface AiStreamChunkResult {
  delta?: string;
  usage?: Partial<AiUsage>;
  done: boolean;
}

export interface IAiProvider {
  buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest;
  parseResponse(data: any): { content: string; usage?: AiUsage };
  parseStreamChunk(event: string | undefined, data: string): AiStreamChunkResult | null;
}

export interface AiHttpError {
  status: number;
  statusText: string;
  body: string;
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
