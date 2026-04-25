/**
 * Validate a remote-core URL string and return a parsed `URL` instance.
 *
 * `new WebSocket(nonWsUrl)` throws `SyntaxError` in modern browsers, but the
 * message there is opaque ("The URL's scheme must be either 'ws' or 'wss'");
 * the checks here surface a configured-URL problem with more context. They
 * also defend against misconfiguration where `remoteCoreUrl` was accidentally
 * set to a page URL (http://…/client.html) and the WebSocket constructor's
 * internal coercion would otherwise be the only guard.
 *
 * Throws:
 *   - `Error("remote.enableRemote is true but remoteCoreUrl is empty")` when
 *     the caller passes an empty string (the enable-remote case where no URL
 *     was resolved).
 *   - `Error("remote.remoteCoreUrl is not a valid URL")` when `new URL(url)`
 *     throws.
 *   - `Error("remote.remoteCoreUrl must use ws:// or wss:// scheme")` when
 *     the parsed scheme is anything else.
 *
 * Extracted from `S3._initRemote` (C7-#2) so the validation block can be
 * unit-tested independently and so the element method stays focused on
 * wiring up the WebSocket + proxy + bind chain.
 */
export function validateRemoteCoreUrl(url: string): URL {
  if (!url) {
    throw new Error("[@wc-bindable/s3] remote.enableRemote is true but remoteCoreUrl is empty. Set remote.remoteCoreUrl or S3_REMOTE_CORE_URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[@wc-bindable/s3] remote.remoteCoreUrl is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`[@wc-bindable/s3] remote.remoteCoreUrl must use ws:// or wss:// scheme, got ${parsed.protocol} (${url}).`);
  }
  return parsed;
}
