import type { AiContent, AiContentPart } from "../types.js";

/**
 * Extract the concatenated text of a possibly-multimodal content value.
 * Used when sending non-user messages (system / tool) whose content the
 * provider expects to be a plain string, or when flattening for metrics.
 */
export function flattenContentToText(content: AiContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<AiContentPart, { type: "text" }> => p.type === "text")
    .map(p => p.text)
    .join("");
}

/**
 * Parse a `data:<mediaType>[;base64],<payload>` URL. Returns the media type
 * and base64 payload, or null if the URL is not a data URL or is malformed.
 * Non-base64 data URLs (percent-encoded) are not supported — providers
 * requiring base64 will throw via the caller's own routing.
 */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  if (!url.startsWith("data:")) return null;
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

/**
 * Assert that every content-part entry is of a shape the current
 * implementation understands. Providers call this before serializing.
 */
export function assertKnownContentParts(parts: AiContentPart[]): void {
  for (const p of parts) {
    if (p.type === "text") {
      if (typeof p.text !== "string") {
        throw new Error("[@wc-bindable/hawc-ai] content part of type 'text' requires a string `text` field.");
      }
    } else if (p.type === "image") {
      if (typeof p.url !== "string" || p.url === "") {
        throw new Error("[@wc-bindable/hawc-ai] content part of type 'image' requires a non-empty `url` field.");
      }
    } else {
      throw new Error(`[@wc-bindable/hawc-ai] unknown content part type: ${(p as any).type}. Only 'text' and 'image' are supported in v1.`);
    }
  }
}
