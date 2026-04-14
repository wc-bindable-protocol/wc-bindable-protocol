import { describe, it, expect } from "vitest";
import { extractTokenFromProtocol } from "../../src/server/extractTokenFromProtocol";

describe("extractTokenFromProtocol", () => {
  it("extracts token from a simple string", () => {
    const token = extractTokenFromProtocol("hawc-auth0.bearer.eyJhbGciOiJSUzI1NiJ9.payload.sig");
    expect(token).toBe("eyJhbGciOiJSUzI1NiJ9.payload.sig");
  });

  it("extracts token from a comma-separated string", () => {
    const token = extractTokenFromProtocol("other-protocol, hawc-auth0.bearer.my-jwt");
    expect(token).toBe("my-jwt");
  });

  it("extracts token from an array", () => {
    const token = extractTokenFromProtocol(["other", "hawc-auth0.bearer.my-jwt"]);
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
      "No hawc-auth0.bearer.* entry",
    );
  });

  it("throws when token part is empty", () => {
    expect(() => extractTokenFromProtocol("hawc-auth0.bearer.")).toThrow(
      "Empty token",
    );
  });
});
