import { Component, h } from "@stencil/core";
import { WcBindableController } from "@wc-bindable/stencil";
import { parseStyle } from "../../util/parse-style";

interface MyCounterValues {
  count: number;
}

interface MyCounterElement extends HTMLElement {
  count: number;
}

const card =
  "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

@Component({ tag: "stencil-counter-app", shadow: false })
export class StencilCounterApp {
  private counterRef?: MyCounterElement;
  private counter = new WcBindableController<MyCounterValues>(
    this,
    () => this.counterRef,
  );

  connectedCallback() {
    this.counter.connect();
  }

  disconnectedCallback() {
    this.counter.disconnect();
  }

  componentDidRender() {
    this.counter.update();
  }

  render() {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: "600px", margin: "40px auto", padding: "0 20px" }}>
        <p><a href="/index.html">&larr; Examples</a></p>
        <h1>wc-bindable: Stencil &mdash; Counter</h1>

        <div style={parseStyle(card)}>
          <div style={parseStyle(label)}>Counter Component</div>
          <my-counter ref={(el?: HTMLElement) => (this.counterRef = el as MyCounterElement | undefined)}></my-counter>
        </div>

        <div style={parseStyle(card)}>
          <div style={parseStyle(label)}>Bound Values (via WcBindableController)</div>
          <pre style={{ fontSize: "14px", color: "#2563eb" }}>
            {JSON.stringify(this.counter.values, null, 2)}
          </pre>
        </div>
      </div>
    );
  }
}

