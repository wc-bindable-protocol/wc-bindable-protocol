import { raiseError } from "../raiseError.js";
import type { AiRequestOptions } from "../types.js";

/**
 * Shared input validation so every provider.buildRequest() rejects invalid
 * temperature/maxTokens uniformly when callers bypass AiCore.send().
 */
export function validateRequestOptions(options: AiRequestOptions): void {
  if (options.temperature !== undefined && !Number.isFinite(options.temperature)) {
    raiseError(`temperature must be a finite number, got ${options.temperature}.`);
  }
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)) {
    raiseError(`maxTokens must be a positive integer, got ${options.maxTokens}.`);
  }
}
