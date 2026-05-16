# @wc-bindable/lit

Lit adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/lit lit
```

## Usage

```ts
import { LitElement, html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { WcBindableController } from "@wc-bindable/lit";

class TodoView extends LitElement {
  private todoRef = createRef<HTMLElement>();
  private todo = new WcBindableController<{ items: string[]; count: number }>(
    this,
    () => this.todoRef.value,
    { items: [], count: 0 },
  );

  render() {
    return html`
      <lit-todo ${ref(this.todoRef)}></lit-todo>
      <p>Count: ${this.todo.values.count}</p>
      <ul>
        ${this.todo.values.items.map((i) => html`<li>${i}</li>`)}
      </ul>
    `;
  }
}
customElements.define("todo-view", TodoView);
```

If the host itself is the bindable element you can pass it directly:

```ts
this.controller = new WcBindableController(this, this);
```

## API

### `new WcBindableController<V>(host, target, initialValues?)`

| Parameter | Type | Description |
|---|---|---|
| `host` | `ReactiveControllerHost` | Lit host (typically `this` inside a `LitElement`) |
| `target` | `HTMLElement \| null \| undefined \| () => HTMLElement \| null \| undefined` | The bindable element, or a getter that returns it once it is rendered |
| `initialValues` | `Partial<V>` | Optional initial values for bindable properties |

| Member | Type | Description |
|---|---|---|
| `values` | `V` | Latest property values; reading from `render()` is reactive |

- Binds on `hostConnected` and unbinds on `hostDisconnected`.
- On every host update the target is re-resolved; if it changed, listeners are rebound to the new element.
- Calls `host.requestUpdate()` whenever a bindable property changes.
- If the element does not implement `wc-bindable`, the controller is a no-op.

## License

MIT
