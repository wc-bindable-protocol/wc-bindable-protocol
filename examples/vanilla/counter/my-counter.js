/**
 * Sample wc-bindable custom element: <my-counter>
 *
 * A simple counter component that implements the wc-bindable protocol.
 * - property: "count" (number)
 * - event: "count-changed" (dispatched when the count changes)
 */
class MyCounter extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [{ name: "count", event: "count-changed" }],
  };

  #count = 0;
  #shadow;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "open" });
    this.#shadow.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-family: system-ui, sans-serif;
        }
        button {
          width: 32px;
          height: 32px;
          font-size: 18px;
          cursor: pointer;
          border: 1px solid #ccc;
          border-radius: 4px;
          background: #f5f5f5;
        }
        button:hover { background: #e0e0e0; }
        span { min-width: 40px; text-align: center; font-size: 20px; }
      </style>
      <button id="dec">−</button>
      <span id="display">0</span>
      <button id="inc">+</button>
    `;

    this.#shadow.getElementById("dec").addEventListener("click", () => {
      this.count = this.#count - 1;
    });
    this.#shadow.getElementById("inc").addEventListener("click", () => {
      this.count = this.#count + 1;
    });
  }

  get count() {
    return this.#count;
  }

  set count(v) {
    this.#count = v;
    this.#shadow.getElementById("display").textContent = String(v);
    this.dispatchEvent(new CustomEvent("count-changed", { detail: v }));
  }
}

customElements.define("my-counter", MyCounter);
