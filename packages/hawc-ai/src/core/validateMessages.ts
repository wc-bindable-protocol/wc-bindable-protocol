import { AiMessage, AiRole } from "../types.js";
import { assertKnownContentParts } from "../providers/contentHelpers.js";

const VALID_ROLES: ReadonlySet<AiRole> = new Set(["system", "user", "assistant", "tool"]);

/**
 * Validate a message history being injected into a Core (via the `messages`
 * setter, the `<hawc-ai>` `messages` property, or the remote `setWithAck`
 * path). The send-path already runs `assertKnownContentParts` on the prompt
 * parts, but history injection bypasses that and would otherwise ship
 * malformed payloads to the provider only to fail at the wire.
 *
 * Throws a plain Error on the first violation with a caller-friendly message
 * that identifies the offending index and field.
 */
export function validateMessages(messages: AiMessage[]): void {
  if (!Array.isArray(messages)) {
    throw new Error("[@wc-bindable/hawc-ai] messages must be an array of AiMessage.");
  }
  // Enforce the `AiMessage.toolCallId` contract ("correlates this message
  // with *the* assistant tool call that produced it" — singular, one-to-one).
  //
  // - `pendingToolCallIds`: declared by a prior assistant turn but not yet
  //   consumed by a tool message. A tool message must find its id here.
  // - `seenToolCallIds`: every id we have ever seen, pending or retired.
  //   A later assistant re-declaring the same id (or the same id appearing
  //   twice inside one `toolCalls` array) is treated as a shape error.
  // - On a matching tool message we delete from `pendingToolCallIds` so a
  //   second tool message with the same id is rejected as a replay.
  //
  // The reverse direction (assistant toolCalls without a following tool
  // response) is intentionally *not* enforced — restoring a history mid
  // tool-use round is a legitimate use case.
  const pendingToolCallIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") {
      throw new Error(`[@wc-bindable/hawc-ai] messages[${i}] must be an object.`);
    }
    if (!VALID_ROLES.has(m.role)) {
      throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].role must be one of "system", "user", "assistant", "tool"; got "${m.role}".`);
    }
    if (typeof m.content !== "string" && !Array.isArray(m.content)) {
      throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].content must be a string or AiContentPart[].`);
    }
    if (Array.isArray(m.content)) {
      try {
        assertKnownContentParts(m.content);
      } catch (err: any) {
        throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].content: ${err?.message ?? String(err)}`);
      }
    }
    if (m.role === "tool") {
      if (typeof m.toolCallId !== "string" || m.toolCallId === "") {
        throw new Error(`[@wc-bindable/hawc-ai] messages[${i}] with role "tool" requires a non-empty string toolCallId.`);
      }
      if (!pendingToolCallIds.has(m.toolCallId)) {
        if (seenToolCallIds.has(m.toolCallId)) {
          throw new Error(`[@wc-bindable/hawc-ai] messages[${i}] with role "tool" replays toolCallId "${m.toolCallId}" that was already consumed by an earlier tool message. Each tool call correlates to exactly one tool response.`);
        }
        throw new Error(`[@wc-bindable/hawc-ai] messages[${i}] with role "tool" references toolCallId "${m.toolCallId}" that does not correlate to any prior assistant tool call. Truncated or orphaned tool results break provider wire format.`);
      }
      // Retire the id so a subsequent tool message cannot reuse it.
      pendingToolCallIds.delete(m.toolCallId);
    }
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      if (!Array.isArray(m.toolCalls)) {
        throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls must be an array when present.`);
      }
      for (let j = 0; j < m.toolCalls.length; j++) {
        const tc = m.toolCalls[j];
        if (!tc || typeof tc !== "object") {
          throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls[${j}] must be an object.`);
        }
        if (typeof tc.id !== "string" || tc.id === "") {
          throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls[${j}].id must be a non-empty string.`);
        }
        if (typeof tc.name !== "string" || tc.name === "") {
          throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls[${j}].name must be a non-empty string.`);
        }
        if (typeof tc.arguments !== "string") {
          throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls[${j}].arguments must be a string (JSON-encoded arguments).`);
        }
        if (seenToolCallIds.has(tc.id)) {
          throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls[${j}].id "${tc.id}" duplicates an id already declared earlier. Tool call ids must be unique across the conversation.`);
        }
        seenToolCallIds.add(tc.id);
        pendingToolCallIds.add(tc.id);
      }
    }
    if (m.role !== "assistant" && (m as any).toolCalls !== undefined) {
      throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCalls is only valid on assistant messages; got role "${m.role}".`);
    }
    if (m.role !== "tool" && (m as any).toolCallId !== undefined) {
      throw new Error(`[@wc-bindable/hawc-ai] messages[${i}].toolCallId is only valid on tool messages; got role "${m.role}".`);
    }
  }
}
