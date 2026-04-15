import { describe, it, expect } from "vitest";
import { UserCore } from "../../src/server/UserCore";
import type { UserContext } from "../../src/types";

const mockUser: UserContext = {
  sub: "auth0|abc123",
  email: "test@example.com",
  name: "Test User",
  permissions: ["storage:upload", "storage:delete"],
  roles: ["admin"],
  orgId: "org_123",
  raw: { sub: "auth0|abc123", email: "test@example.com" },
};

describe("UserCore", () => {
  it("extends EventTarget", () => {
    const core = new UserCore(mockUser);
    expect(core).toBeInstanceOf(EventTarget);
  });

  it("has correct wcBindable declaration", () => {
    expect(UserCore.wcBindable.protocol).toBe("wc-bindable");
    expect(UserCore.wcBindable.version).toBe(1);
    expect(UserCore.wcBindable.properties).toHaveLength(3);

    const names = UserCore.wcBindable.properties.map((p) => p.name);
    expect(names).toEqual(["currentUser", "permissions", "roles"]);
  });

  it("currentUser returns sub, email, name", () => {
    const core = new UserCore(mockUser);
    expect(core.currentUser).toEqual({
      sub: "auth0|abc123",
      email: "test@example.com",
      name: "Test User",
    });
  });

  it("permissions returns a copy of the permissions array", () => {
    const core = new UserCore(mockUser);
    const perms = core.permissions;
    expect(perms).toEqual(["storage:upload", "storage:delete"]);
    // Must be a copy, not the same reference
    expect(perms).not.toBe(mockUser.permissions);
  });

  it("roles returns a copy of the roles array", () => {
    const core = new UserCore(mockUser);
    const roles = core.roles;
    expect(roles).toEqual(["admin"]);
    expect(roles).not.toBe(mockUser.roles);
  });

  it("works with minimal user context", () => {
    const minimal: UserContext = {
      sub: "auth0|min",
      permissions: [],
      roles: [],
      raw: { sub: "auth0|min" },
    };
    const core = new UserCore(minimal);
    expect(core.currentUser).toEqual({ sub: "auth0|min", email: undefined, name: undefined });
    expect(core.permissions).toEqual([]);
    expect(core.roles).toEqual([]);
  });

  describe("updateUser", () => {
    it("replaces the context and exposes new permissions/roles", () => {
      const core = new UserCore(mockUser);
      const next: UserContext = {
        ...mockUser,
        permissions: ["storage:upload", "storage:read"],
        roles: ["admin", "auditor"],
      };
      core.updateUser(next);
      expect(core.permissions).toEqual(["storage:upload", "storage:read"]);
      expect(core.roles).toEqual(["admin", "auditor"]);
    });

    it("dispatches permissions-changed only when permissions differ", () => {
      const core = new UserCore(mockUser);
      const events: string[] = [];
      core.addEventListener("hawc-auth0:permissions-changed", () => events.push("perm"));

      core.updateUser({ ...mockUser });
      expect(events).toEqual([]);

      core.updateUser({ ...mockUser, permissions: ["storage:upload", "storage:delete", "extra"] });
      expect(events).toEqual(["perm"]);
    });

    it("dispatches roles-changed only when roles differ", () => {
      const core = new UserCore(mockUser);
      const events: string[] = [];
      core.addEventListener("hawc-auth0:roles-changed", () => events.push("role"));

      core.updateUser({ ...mockUser });
      expect(events).toEqual([]);

      core.updateUser({ ...mockUser, roles: ["editor"] });
      expect(events).toEqual(["role"]);
    });

    it("dispatches user-changed only when sub/email/name differ", () => {
      const core = new UserCore(mockUser);
      const events: Array<{ sub: string }> = [];
      core.addEventListener("hawc-auth0:user-changed", (e) => {
        events.push((e as CustomEvent).detail);
      });

      core.updateUser({ ...mockUser });
      expect(events).toHaveLength(0);

      core.updateUser({ ...mockUser, email: "new@example.com" });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        sub: "auth0|abc123",
        email: "new@example.com",
        name: "Test User",
      });
    });

    it("event detail for permissions is a fresh copy (not the internal array)", () => {
      const core = new UserCore(mockUser);
      let detail: string[] | null = null;
      core.addEventListener("hawc-auth0:permissions-changed", (e) => {
        detail = (e as CustomEvent).detail;
      });

      core.updateUser({ ...mockUser, permissions: ["x", "y"] });
      expect(detail).toEqual(["x", "y"]);
      expect(detail).not.toBe(core.permissions);
    });
  });
});
