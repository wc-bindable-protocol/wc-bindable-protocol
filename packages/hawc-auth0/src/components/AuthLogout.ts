import { config } from "../config.js";
import { Auth } from "./Auth.js";

/**
 * <hawc-auth0-logout> — declarative logout button.
 * Finds the parent or referenced <hawc-auth0> element and calls logout().
 *
 * Usage:
 *   <hawc-auth0-logout target="auth-id">ログアウト</hawc-auth0-logout>
 *   <hawc-auth0-logout return-to="/">ログアウト</hawc-auth0-logout>
 */
export class AuthLogout extends HTMLElement {
  connectedCallback(): void {
    this.addEventListener("click", this._handleClick);
    this.style.cursor = "pointer";
  }

  disconnectedCallback(): void {
    this.removeEventListener("click", this._handleClick);
  }

  get target(): string {
    return this.getAttribute("target") || "";
  }

  set target(value: string) {
    this.setAttribute("target", value);
  }

  get returnTo(): string {
    return this.getAttribute("return-to") || "";
  }

  set returnTo(value: string) {
    this.setAttribute("return-to", value);
  }

  private _handleClick = (event: Event): void => {
    event.preventDefault();

    const authElement = this._findAuth();
    if (!authElement) return;

    const options: Record<string, any> = {};
    if (this.returnTo) {
      options.logoutParams = { returnTo: this.returnTo };
    }

    authElement.logout(options);
  };

  private _findAuth(): Auth | null {
    // target属性でIDを指定している場合
    if (this.target) {
      const el = document.getElementById(this.target);
      if (el && el.tagName.toLowerCase() === config.tagNames.auth) {
        return el as unknown as Auth;
      }
      return null;
    }

    // 最寄りの<hawc-auth0>を探す
    const closest = this.closest(config.tagNames.auth);
    if (closest) {
      return closest as unknown as Auth;
    }

    // ドキュメント内の最初の<hawc-auth0>を探す
    const first = document.querySelector(config.tagNames.auth);
    return first as unknown as Auth | null;
  }
}
