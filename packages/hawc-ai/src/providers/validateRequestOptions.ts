import { raiseError } from "../raiseError.js";
import type { AiRequestOptions } from "../types.js";

/**
 * Shared input validation so every provider.buildRequest() rejects invalid
 * options uniformly when callers bypass AiCore.send() and use the exported
 * providers directly.
 */
export function validateRequestOptions(options: AiRequestOptions): void {
  if (options.temperature !== undefined && !Number.isFinite(options.temperature)) {
    raiseError(`temperature must be a finite number, got ${options.temperature}.`);
  }
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
    raiseError(`maxTokens must be a positive integer, got ${options.maxTokens}.`);
  }
  if (options.responseSchema !== undefined) {
    if (typeof options.responseSchema !== "object" || options.responseSchema === null || Array.isArray(options.responseSchema)) {
      raiseError("responseSchema must be a JSON Schema object.");
    }
    if (options.tools && options.tools.length > 0) {
      raiseError("responseSchema and tools cannot both be set on the same request. Structured output and tool use are mutually exclusive in this API.");
    }
  }
}
