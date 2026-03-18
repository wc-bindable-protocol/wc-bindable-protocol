import { MyFetchCore } from "./my-fetch-core.js";

/**
 * Shell: <my-fetch> (HTMLElement)
 *
 * Thin DOM wrapper around MyFetchCore.
 * Provides attribute mapping and lifecycle hooks.
 * Core dispatches events directly on this HTMLElement (passed as target).
 *
 * Attributes:
 *   url      — request URL (required)
 *   method   — HTTP method (default: GET)
 *   manual   — if present, does not auto-fetch on connect
 *
 * Methods:
 *   fetch()  — trigger the request
 *   abort()  — cancel in-flight request
 */
class MyFetch extends HTMLElement {
  static wcBindable = MyFetchCore.wcBindable;

  #core;

  constructor() {
    super();
    this.#core = new MyFetchCore(this);
  }

  // --- proxy getters to core ---

  get value() {
    return this.#core.value;
  }
  get loading() {
    return this.#core.loading;
  }
  get error() {
    return this.#core.error;
  }
  get status() {
    return this.#core.status;
  }

  // --- attribute accessors (DOM-specific) ---

  get url() {
    return this.getAttribute("url") || "";
  }
  set url(v) {
    this.setAttribute("url", v);
  }

  get method() {
    return (this.getAttribute("method") || "GET").toUpperCase();
  }
  set method(v) {
    this.setAttribute("method", v);
  }

  get manual() {
    return this.hasAttribute("manual");
  }
  set manual(v) {
    v ? this.setAttribute("manual", "") : this.removeAttribute("manual");
  }

  // --- public methods (delegate to core) ---

  abort() {
    this.#core.abort();
  }

  async fetch() {
    const url = this.url;
    if (!url) throw new Error("<my-fetch>: url attribute is required");
    return this.#core.fetch(url, { method: this.method });
  }

  // --- lifecycle (DOM-specific) ---

  connectedCallback() {
    this.style.display = "none";
    if (!this.manual && this.url) {
      this.fetch();
    }
  }

  disconnectedCallback() {
    this.abort();
  }
}

customElements.define("my-fetch", MyFetch);
