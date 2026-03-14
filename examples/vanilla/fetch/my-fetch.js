/**
 * Sample wc-bindable custom element: <my-fetch>
 *
 * A declarative fetch component that implements the wc-bindable protocol.
 * - property: "value"   — response data (JSON or text)
 * - property: "loading" — whether a request is in progress
 * - property: "error"   — error info (null when no error)
 * - property: "status"  — HTTP status code
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
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "my-fetch:response", getter: (e) => e.detail.value },
      { name: "loading", event: "my-fetch:loading-changed" },
      { name: "error", event: "my-fetch:error" },
      {
        name: "status",
        event: "my-fetch:response",
        getter: (e) => e.detail.status,
      },
    ],
  };

  #value = null;
  #loading = false;
  #error = null;
  #status = 0;
  #abortController = null;

  constructor() {
    super();
  }

  // --- public getters ---

  get value() {
    return this.#value;
  }
  get loading() {
    return this.#loading;
  }
  get error() {
    return this.#error;
  }
  get status() {
    return this.#status;
  }

  // --- attribute accessors ---

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

  // --- internal helpers ---

  #setLoading(loading) {
    this.#loading = loading;
    this.dispatchEvent(
      new CustomEvent("my-fetch:loading-changed", {
        detail: loading,
        bubbles: true,
      }),
    );
  }

  #setError(error) {
    this.#error = error;
    if (error?.status) this.#status = error.status;
    this.dispatchEvent(
      new CustomEvent("my-fetch:error", {
        detail: error,
        bubbles: true,
      }),
    );
  }

  #setResponse(value, status) {
    this.#value = value;
    this.#status = status;
    this.dispatchEvent(
      new CustomEvent("my-fetch:response", {
        detail: { value, status },
        bubbles: true,
      }),
    );
  }

  // --- public methods ---

  abort() {
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
  }

  async fetch() {
    const url = this.url;
    if (!url) throw new Error("<my-fetch>: url attribute is required");

    this.abort();
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    this.#setLoading(true);
    this.#setError(null);

    try {
      const response = await globalThis.fetch(url, {
        method: this.method,
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.#setError({
          status: response.status,
          statusText: response.statusText,
          body,
        });
        this.#setLoading(false);
        return null;
      }

      const contentType = response.headers.get("Content-Type") || "";
      const data = contentType.includes("application/json")
        ? await response.json()
        : await response.text();

      this.#setResponse(data, response.status);
      this.#setLoading(false);
      return data;
    } catch (e) {
      if (e.name === "AbortError") {
        this.#setLoading(false);
        return null;
      }
      this.#setError(e);
      this.#setLoading(false);
      return null;
    } finally {
      this.#abortController = null;
    }
  }

  // --- lifecycle ---

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
