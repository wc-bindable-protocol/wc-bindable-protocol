import type { IWcBindable, UserContext } from "../types.js";

/**
 * Reference implementation: a server-side Core that exposes
 * authenticated user information as wc-bindable properties.
 *
 * Instantiate with the `UserContext` returned by `verifyAuth0Token()`.
 */
export class UserCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "currentUser", event: "hawc-auth0:user-changed" },
      { name: "permissions", event: "hawc-auth0:permissions-changed" },
      { name: "roles",       event: "hawc-auth0:roles-changed" },
    ],
  };

  private _user: UserContext;

  constructor(user: UserContext) {
    super();
    this._user = user;
  }

  get currentUser(): { sub: string; email?: string; name?: string } {
    return {
      sub:   this._user.sub,
      email: this._user.email,
      name:  this._user.name,
    };
  }

  get permissions(): string[] {
    return [...this._user.permissions];
  }

  get roles(): string[] {
    return [...this._user.roles];
  }

  /**
   * Replace the backing UserContext (e.g. after an in-band token refresh)
   * and dispatch wc-bindable change events for any field whose value
   * differs from the previous context.
   */
  updateUser(user: UserContext): void {
    const prev = this._user;
    this._user = user;

    if (
      prev.sub !== user.sub ||
      prev.email !== user.email ||
      prev.name !== user.name
    ) {
      this.dispatchEvent(new CustomEvent("hawc-auth0:user-changed", {
        detail: this.currentUser,
        bubbles: true,
      }));
    }
    if (!_sameStringArray(prev.permissions, user.permissions)) {
      this.dispatchEvent(new CustomEvent("hawc-auth0:permissions-changed", {
        detail: this.permissions,
        bubbles: true,
      }));
    }
    if (!_sameStringArray(prev.roles, user.roles)) {
      this.dispatchEvent(new CustomEvent("hawc-auth0:roles-changed", {
        detail: this.roles,
        bubbles: true,
      }));
    }
  }
}

function _sameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
