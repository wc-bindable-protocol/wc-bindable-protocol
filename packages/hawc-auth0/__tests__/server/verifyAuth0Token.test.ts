import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

import { verifyAuth0Token } from "../../src/server/verifyAuth0Token";

describe("verifyAuth0Token", () => {
  let jwtVerify: ReturnType<typeof vi.fn>;
  let createRemoteJWKSet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const jose = await import("jose");
    jwtVerify = jose.jwtVerify as ReturnType<typeof vi.fn>;
    createRemoteJWKSet = jose.createRemoteJWKSet as ReturnType<typeof vi.fn>;
    jwtVerify.mockReset();
    createRemoteJWKSet.mockClear();
  });

  it("throws when JWT payload has no sub", async () => {
    jwtVerify.mockResolvedValue({ payload: { permissions: [] } });

    await expect(
      verifyAuth0Token("token", { domain: "test.auth0.com", audience: "aud" }),
    ).rejects.toThrow("JWT payload missing 'sub' claim");
  });

  it("reuses JWKS cache per domain", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });
    const domain = `cache-test-${Date.now()}.auth0.com`;

    await verifyAuth0Token("token-1", { domain, audience: "aud" });
    await verifyAuth0Token("token-2", { domain, audience: "aud" });

    expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
  });

  it("returns default empty permissions and roles", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|456" } });

    const result = await verifyAuth0Token("token-3", {
      domain: `defaults-${Date.now()}.auth0.com`,
      audience: "aud",
    });

    expect(result.permissions).toEqual([]);
    expect(result.roles).toEqual([]);
  });
});
