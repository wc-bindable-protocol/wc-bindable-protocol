import { AiMessage, AiContent } from "../types.js";

function cloneContent(content: AiContent): AiContent {
  if (typeof content === "string") return content;
  return content.map(part => ({ ...part }));
}

/**
 * Deep-enough copy of AiMessage so external callers cannot mutate the array
 * fields (`content` when it is a parts array, `toolCalls`) and silently alter
 * the owning Core's history without emitting a change event.
 */
function cloneProviderHints(hints: Record<string, any>): Record<string, any> {
  // Hints are a namespaced passthrough so shapes are provider-defined; deep
  // clone via JSON round-trip to prevent external mutation of nested fields
  // (e.g. `providerHints.anthropic.cacheControl`) from reaching back into
  // the Core's stored history. Fall back to a shallow spread if a hint
  // carries a non-JSON value (functions, BigInt) so we stay best-effort
  // rather than throwing on an exotic payload.
  try {
    return JSON.parse(JSON.stringify(hints));
  } catch {
    return { ...hints };
  }
}

export function cloneMessage(m: AiMessage): AiMessage {
  const copy: AiMessage = { role: m.role, content: cloneContent(m.content) };
  if (m.toolCalls) copy.toolCalls = m.toolCalls.map(tc => ({ ...tc }));
  if (m.toolCallId !== undefined) copy.toolCallId = m.toolCallId;
  if (m.finishReason !== undefined) copy.finishReason = m.finishReason;
  if (m.providerHints !== undefined) copy.providerHints = cloneProviderHints(m.providerHints);
  return copy;
}
