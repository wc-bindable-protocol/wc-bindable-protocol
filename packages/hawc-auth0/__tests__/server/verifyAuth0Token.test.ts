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

  it("normalizes string-typed permissions/roles to empty arrays (fail-closed)", async () => {
    // Misconfigured Auth0 rule / legacy claim: a bare string instead of
    // an array. Without runtime validation, downstream
    // `roles.includes("admin")` would substring-match e.g. "admin_readonly"
    // and grant admin by accident. Verify fail-closed normalization.
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "auth0|789",
        permissions: "admin_readonly",
        roles: "admin_readonly",
      },
    });

    const result = await verifyAuth0Token("token-4", {
      domain: `strarray-${Date.now()}.auth0.com`,
      audience: "aud",
    });

    expect(result.permissions).toEqual([]);
    expect(result.roles).toEqual([]);
    expect(result.roles.includes("admin")).toBe(false);
  });

  it("filters non-string elements out of permissions/roles arrays", async () => {
    // Mixed-type array — keep strings, drop nulls / numbers / objects.
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "auth0|abc",
        permissions: ["read", 42, null, "write", { role: "admin" }],
        roles: ["user", undefined, "staff"],
      },
    });

    const result = await verifyAuth0Token("token-5", {
      domain: `mixed-${Date.now()}.auth0.com`,
      audience: "aud",
    });

    expect(result.permissions).toEqual(["read", "write"]);
    expect(result.roles).toEqual(["user", "staff"]);
  });

  it("normalizes null / object-typed permissions/roles to empty arrays", async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "auth0|def",
        permissions: null,
        roles: { admin: true },
      },
    });

    const result = await verifyAuth0Token("token-6", {
      domain: `nullobj-${Date.now()}.auth0.com`,
      audience: "aud",
    });

    expect(result.permissions).toEqual([]);
    expect(result.roles).toEqual([]);
  });
});
