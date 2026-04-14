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
}
