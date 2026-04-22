import type { IWcBindable, UserContext } from "../types.js";

/**
 * Reference implementation: a server-side Core that exposes
 * authenticated user information as wc-bindable properties.
 *
 * Instantiate with the `UserContext` returned by `verifyAuth0Token()`.
 *
 * Event naming: the `hawc-auth0-user:` prefix separates UserCore's
 * server-side bindable events from AuthCore's client-side events
 * (`hawc-auth0:`). Both cores publish a `user-changed` event but with
 * different payload shapes — AuthCore dispatches `AuthUser | null`
 * (the Auth0 ID token profile, including Auth0-specific fields like
 * `picture`, `sid`, `updated_at`), while UserCore dispatches a
 * server-side `{ sub, email, name }` projection of `UserContext`.
 *
 * Without the namespace, a pass-through / bridge that forwarded the
 * raw event name across the HAWC wire would silently overlap on the
 * client, delivering UserCore's restricted projection into consumers
 * that expected the full AuthCore profile (or vice versa). The
 * separate prefix keeps the two surfaces independently addressable
 * and lets consumers choose precisely which core they subscribe to.
 *
 * Separate `permissions-changed` / `roles-changed` events are also
 * namespaced for symmetry even though AuthCore does not emit those —
 * future AuthCore additions of RBAC state would otherwise collide.
 */
export class UserCore extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "currentUser", event: "hawc-auth0-user:user-changed" },
      { name: "permissions", event: "hawc-auth0-user:permissions-changed" },
      { name: "roles",       event: "hawc-auth0-user:roles-changed" },
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
      this.dispatchEvent(new CustomEvent("hawc-auth0-user:user-changed", {
        detail: this.currentUser,
        bubbles: true,
      }));
    }
    if (!_sameStringArray(prev.permissions, user.permissions)) {
      this.dispatchEvent(new CustomEvent("hawc-auth0-user:permissions-changed", {
        detail: this.permissions,
        bubbles: true,
      }));
    }
    if (!_sameStringArray(prev.roles, user.roles)) {
      this.dispatchEvent(new CustomEvent("hawc-auth0-user:roles-changed", {
        detail: this.roles,
        bubbles: true,
      }));
    }
  }
}

/**
 * Multiset equality on string arrays. Auth0 RBAC claims (`permissions`
 * / `roles`) are unordered sets by contract — a refresh that changes
 * ONLY the emit order (e.g. `["read","write"]` → `["write","read"]`)
 * must not fire a spurious change event, otherwise downstream
 * bindings re-render on noise. We compare by sorted copies so equal
 * multisets compare equal regardless of duplicates or order.
 */
function _sameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}
