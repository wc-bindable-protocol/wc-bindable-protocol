import { Component, h } from "@stencil/core";
import { WcBindableController } from "@wc-bindable/stencil";
import { parseStyle } from "../../util/parse-style";

interface LitTodoValues {
  items: string[];
  count: number;
}

const card =
  "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

@Component({ tag: "stencil-lit-todo-app", shadow: false })
export class StencilLitTodoApp {
  private todoRef?: HTMLElement;
  private todo = new WcBindableController<LitTodoValues>(
    this,
    () => this.todoRef,
    { items: [], count: 0 },
  );

  connectedCallback() {
    this.todo.connect();
  }

  disconnectedCallback() {
    this.todo.disconnect();
  }

  componentDidRender() {
    this.todo.update();
  }

  render() {
    const v = this.todo.values;
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: "600px", margin: "40px auto", padding: "0 20px" }}>
        <p><a href="/index.html">&larr; Examples</a></p>
        <h1>wc-bindable: Stencil &mdash; Lit Todo</h1>

        <div style={parseStyle(card)}>
          <div style={parseStyle(label)}>
            Lit Todo Component
            {v.count != null ? (
              <span style={{
                display: "inline-block",
                background: "#2563eb",
                color: "white",
                borderRadius: "12px",
                padding: "2px 10px",
                fontSize: "13px",
                marginLeft: "8px",
              }}>
                {String(v.count)}
              </span>
            ) : null}
          </div>
          <lit-todo ref={(el?: HTMLElement) => (this.todoRef = el)}></lit-todo>
        </div>

        <div style={parseStyle(card)}>
          <div style={parseStyle(label)}>Bound Values (via WcBindableController)</div>
          <pre style={{ fontSize: "14px", color: "#2563eb" }}>
            {JSON.stringify(v, null, 2)}
          </pre>
        </div>

        {v.items && v.items.length > 0 ? (
          <div style={parseStyle(card)}>
            <div style={parseStyle(label)}>Stencil-rendered item list (from bound state)</div>
            <ul>{v.items.map((item) => <li>{item}</li>)}</ul>
          </div>
        ) : null}
      </div>
    );
  }
}
