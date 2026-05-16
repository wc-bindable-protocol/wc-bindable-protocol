# @wc-bindable/stencil

Stencil adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/stencil @stencil/core
```

## Usage

```tsx
import { Component, Element, h } from "@stencil/core";
import { WcBindableController } from "@wc-bindable/stencil";

@Component({ tag: "todo-view" })
export class TodoView {
  @Element() host!: HTMLElement;

  private todoRef?: HTMLElement;
  private todo = new WcBindableController<{ items: string[]; count: number }>(
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
    return (
      <div>
        <my-todo ref={(el) => (this.todoRef = el)}></my-todo>
        <p>Count: {this.todo.values.count}</p>
        <ul>
          {this.todo.values.items.map((i) => (
            <li>{i}</li>
          ))}
        </ul>
      </div>
    );
  }
}
```

If the host itself is the bindable element you can pass it directly:

```ts
this.controller = new WcBindableController(this, this.host);
```

## API

### `new WcBindableController<V>(host, target, initialValues?)`

| Parameter | Type | Description |
|---|---|---|
| `host` | `HTMLElement \| object` | Stencil component instance or host element — passed to `forceUpdate()` when a bindable property changes |
| `target` | `HTMLElement \| null \| undefined \| () => HTMLElement \| null \| undefined` | The bindable element, or a getter that returns it once it is rendered |
| `initialValues` | `Partial<V>` | Optional initial values for bindable properties |

| Member | Type | Description |
|---|---|---|
| `values` | `V` | Latest property values; reading from `render()` becomes reactive via `forceUpdate(host)` |

| Method | Description |
|---|---|
| `connect()` | Call from `connectedCallback()` to start listening |
| `disconnect()` | Call from `disconnectedCallback()` to remove listeners |
| `update()` | Call from `componentDidRender()` / `componentDidUpdate()` to rebind if the target element changed |

- On each `update()` the target is re-resolved; if it changed, listeners are rebound to the new element.
- Calls `forceUpdate(host)` whenever a bindable property changes.
- If the element does not implement `wc-bindable`, the controller is a no-op.

## License

MIT
