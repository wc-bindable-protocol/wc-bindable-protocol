import { PROTOCOL_PREFIX } from "../protocolPrefix.js";

/**
 * Extract a JWT from the `Sec-WebSocket-Protocol` header.
 *
 * The client sends the token as a subprotocol in the form
 * `{PROTOCOL_PREFIX}{JWT}`. This function finds the matching entry
 * and returns the bare token string.
 *
 * @throws If no matching protocol entry is found.
 */
export function extractTokenFromProtocol(
  protocolHeader: string | string[] | undefined,
): string {
  if (!protocolHeader) {
    throw new Error("[@wc-bindable/hawc-auth0] Missing Sec-WebSocket-Protocol header.");
  }

  // The header may be a comma-separated string or an array.
  const protocols: string[] = Array.isArray(protocolHeader)
    ? protocolHeader
    : protocolHeader.split(",").map((s) => s.trim());

  for (const proto of protocols) {
    if (proto.startsWith(PROTOCOL_PREFIX)) {
      const token = proto.slice(PROTOCOL_PREFIX.length);
      if (!token) {
        throw new Error("[@wc-bindable/hawc-auth0] Empty token in Sec-WebSocket-Protocol.");
      }
      return token;
    }
  }

  throw new Error(
    `[@wc-bindable/hawc-auth0] No ${PROTOCOL_PREFIX}* entry in Sec-WebSocket-Protocol.`,
  );
}
