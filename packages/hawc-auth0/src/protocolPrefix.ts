/**
 * Subprotocol prefix used on the `Sec-WebSocket-Protocol` header to
 * carry an Auth0 access token from client to server during the
 * WebSocket handshake. Wire format is `{prefix}{JWT}`.
 *
 * Shared across the client shell (`AuthShell`), the server token
 * extractor (`extractTokenFromProtocol`), and the server listener's
 * handshake filter (`createAuthenticatedWSS`) so all three agree on
 * the wire format. Previously each duplicated the literal, making a
 * prefix change silently break the client/server contract.
 */
export const PROTOCOL_PREFIX = "hawc-auth0.bearer.";
