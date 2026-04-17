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
export function cloneMessage(m: AiMessage): AiMessage {
  const copy: AiMessage = { role: m.role, content: cloneContent(m.content) };
  if (m.toolCalls) copy.toolCalls = m.toolCalls.map(tc => ({ ...tc }));
  if (m.toolCallId !== undefined) copy.toolCallId = m.toolCallId;
  return copy;
}
