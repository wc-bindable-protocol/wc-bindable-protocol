import { LitElement, html, css } from "lit";

/**
 * <lit-todo> — A Lit-based todo component implementing the wc-bindable protocol.
 *
 * Properties exposed via protocol:
 *   - items: string[]  (the list of todo items)
 *   - count: number    (number of items)
 */
export class LitTodo extends LitElement {
  static wcBindable = {
    protocol: "wc-bindable" as const,
    version: 1,
    properties: [
      { name: "items", event: "lit-todo:items-changed" },
      { name: "count", event: "lit-todo:count-changed" },
    ],
  };

  static override properties = {
    _items: { state: true },
    _input: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }
    .input-row {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    input {
      flex: 1;
      padding: 6px 10px;
      font-size: 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
    button {
      padding: 6px 14px;
      font-size: 14px;
      cursor: pointer;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #f5f5f5;
    }
    button:hover { background: #e0e0e0; }
    ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid #eee;
    }
    .delete-btn {
      background: none;
      border: none;
      color: #e53e3e;
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
    }
    .delete-btn:hover { background: #fee; border-radius: 4px; }
    .empty { color: #999; font-style: italic; }
  `;

  _items: string[] = [];
  _input = "";

  get items(): string[] {
    return [...this._items];
  }

  get count(): number {
    return this._items.length;
  }

  private _notify() {
    this.dispatchEvent(
      new CustomEvent("lit-todo:items-changed", { detail: this.items }),
    );
    this.dispatchEvent(
      new CustomEvent("lit-todo:count-changed", { detail: this.count }),
    );
  }

  private _add() {
    const text = this._input.trim();
    if (!text) return;
    this._items = [...this._items, text];
    this._input = "";
    this._notify();
  }

  private _remove(index: number) {
    this._items = this._items.filter((_, i) => i !== index);
    this._notify();
  }

  private _onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") this._add();
  }

  render() {
    return html`
      <div class="input-row">
        <input
          type="text"
          placeholder="Add a todo..."
          .value=${this._input}
          @input=${(e: Event) => (this._input = (e.target as HTMLInputElement).value)}
          @keydown=${this._onKeydown}
        />
        <button @click=${this._add}>Add</button>
      </div>
      ${this._items.length === 0
        ? html`<div class="empty">No items yet</div>`
        : html`
            <ul>
              ${this._items.map(
                (item, i) => html`
                  <li>
                    <span>${item}</span>
                    <button class="delete-btn" @click=${() => this._remove(i)}>✕</button>
                  </li>
                `,
              )}
            </ul>
          `}
    `;
  }
}

customElements.define("lit-todo", LitTodo);
