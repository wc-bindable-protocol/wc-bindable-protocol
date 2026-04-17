import { AiMessage, AiRequestOptions, AiProviderRequest } from "../types.js";
import { raiseError } from "../raiseError.js";
import { OpenAiProvider } from "./OpenAiProvider.js";
import { validateRequestOptions } from "./validateRequestOptions.js";

export class AzureOpenAiProvider extends OpenAiProvider {
  override buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest {
    validateRequestOptions(options);
    if (!options.baseUrl) {
      raiseError("base-url is required for Azure OpenAI.");
    }

    const apiVersion = options.apiVersion || "2024-02-01";
    const url = `${options.baseUrl}/openai/deployments/${options.model}/chat/completions?api-version=${apiVersion}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.apiKey) {
      headers["api-key"] = options.apiKey;
    }

    const body: Record<string, any> = {
      messages: messages.map(m => this._serializeMessage(m)),
      stream: options.stream ?? true,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (body.stream) body.stream_options = { include_usage: true };
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
}
