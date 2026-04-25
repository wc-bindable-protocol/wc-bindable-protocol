import { describe, it, expect } from "vitest";
import { extractTokenFromProtocol } from "../../src/server/extractTokenFromProtocol";

describe("extractTokenFromProtocol", () => {
  it("extracts token from a simple string", () => {
    const token = extractTokenFromProtocol("auth0-gate.bearer.eyJhbGciOiJSUzI1NiJ9.payload.sig");
    expect(token).toBe("eyJhbGciOiJSUzI1NiJ9.payload.sig");
  });

  it("extracts token from a comma-separated string", () => {
    const token = extractTokenFromProtocol("other-protocol, auth0-gate.bearer.my-jwt");
    expect(token).toBe("my-jwt");
  });

  it("extracts token from an array", () => {
    const token = extractTokenFromProtocol(["other", "auth0-gate.bearer.my-jwt"]);
    expect(token).toBe("my-jwt");
  });

  it("trims leading/trailing whitespace on array entries", () => {
    // Regression: comma-separated string input was trimmed, but array
    // input was not — entries arriving with whitespace from upstream
    // proxies / non-`ws` servers would fail `startsWith(PROTOCOL_PREFIX)`
    // and surface as the generic "no entry" authentication failure
    // even when the client sent a valid subprotocol.
    const token = extractTokenFromProtocol([
      " other ",
      "  auth0-gate.bearer.my-jwt  ",
    ]);
    expect(token).toBe("my-jwt");
  });

  it("throws on undefined header", () => {
    expect(() => extractTokenFromProtocol(undefined)).toThrow(
      "Missing Sec-WebSocket-Protocol header",
    );
  });

  it("throws on empty string", () => {
    expect(() => extractTokenFromProtocol("")).toThrow(
      "Missing Sec-WebSocket-Protocol header",
    );
  });

  it("throws when no matching protocol is found", () => {
    expect(() => extractTokenFromProtocol("graphql-ws")).toThrow(
      "No auth0-gate.bearer.* entry",
    );
  });

  it("throws when token part is empty", () => {
    expect(() => extractTokenFromProtocol("auth0-gate.bearer.")).toThrow(
      "Empty token",
    );
  });

  it("throws a clear error when the header is not a string/string[] at runtime", () => {
    // The declared input type is `string | string[] | undefined`, but
    // custom servers (raw http upgrade handlers, Deno/Bun adapters) can
    // still hand us a `Buffer` or plain object at runtime. Without the
    // runtime-shape guard, `protocolHeader.split(",")` throws a confusing
    // `TypeError: X.split is not a function` deep in the parse path.
    const buffer = Buffer.from("auth0-gate.bearer.my-jwt");
    expect(() => extractTokenFromProtocol(buffer as unknown as string)).toThrow(
      /Sec-WebSocket-Protocol header must be a string or string\[\]/,
    );
    expect(() => extractTokenFromProtocol({ foo: 1 } as unknown as string)).toThrow(
      /Sec-WebSocket-Protocol header must be a string or string\[\]/,
    );
  });
});
