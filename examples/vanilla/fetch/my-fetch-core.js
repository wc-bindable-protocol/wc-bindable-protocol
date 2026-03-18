/**
 * Core: MyFetchCore (EventTarget)
 *
 * Pure business logic — no DOM dependency.
 * Works in any runtime with EventTarget + CustomEvent (browser, Node.js, Deno, Workers).
 *
 * - property: "value"   — response data (JSON or text)
 * - property: "loading" — whether a request is in progress
 * - property: "error"   — error info (null when no error)
 * - property: "status"  — HTTP status code
 */
export class MyFetchCore extends EventTarget {
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

  #target;
  #value = null;
  #loading = false;
  #error = null;
  #status = 0;
  #abortController = null;

  constructor(target) {
    super();
    this.#target = target ?? this;
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

  // --- internal helpers ---

  #setLoading(loading) {
    this.#loading = loading;
    this.#target.dispatchEvent(
      new CustomEvent("my-fetch:loading-changed", { detail: loading, bubbles: true }),
    );
  }

  #setError(error) {
    this.#error = error;
    if (error?.status) this.#status = error.status;
    this.#target.dispatchEvent(
      new CustomEvent("my-fetch:error", { detail: error, bubbles: true }),
    );
  }

  #setResponse(value, status) {
    this.#value = value;
    this.#status = status;
    this.#target.dispatchEvent(
      new CustomEvent("my-fetch:response", { detail: { value, status }, bubbles: true }),
    );
  }

  // --- public methods ---

  abort() {
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
  }

  async fetch(url, options = {}) {
    if (!url) throw new Error("MyFetchCore: url is required");

    const method = (options.method || "GET").toUpperCase();

    this.abort();
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    this.#setLoading(true);
    this.#setError(null);

    try {
      const response = await globalThis.fetch(url, { method, signal });

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
}
