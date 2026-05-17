# @wc-bindable/riot

Riot.js adapter for the **wc-bindable** protocol.

Bridges the protocol's `bind()` into Riot.js's `onMounted` / `onBeforeUnmount`
lifecycle and the `this.update()` re-render cycle, so a Web Component's
declared properties show up as plain state you can read inside your template.

## Install

```bash
npm install @wc-bindable/riot riot
```

## API

### `wcBindable(el, onUpdate): unbind`

Low-level helper. Call it from any lifecycle hook that gives you the DOM node;
the adapter does no re-render — you decide what to do with each update (typically
calling `this.update({ ... })` to merge the value into component state).

| Parameter | Type | Description |
|---|---|---|
| `el` | `Element` | The Web Component DOM node |
| `onUpdate` | `(name: string, value: unknown) => void` | Called once per declared property on initial sync, and again on every change event |

Returns an `unbind` function. If `el` does not implement the wc-bindable
protocol, the helper is a no-op and the returned function is safe to call.

### `createWcBindable<V>(initialValues?, options?): WcBindableBinder<V>`

Stateful helper. Holds a values object, mutates it as events arrive, and calls
the supplied `update` callback (typically `() => this.update()`) so your
template rerenders automatically.

Returns `{ values, bind, unbind }` — call `bind(el)` from `onMounted` and
`unbind()` from `onBeforeUnmount`. Read `values.<name>` from your template.

| Option | Type | Default |
|---|---|---|
| `update` | `() => void` | `() => {}` — wire this to `() => this.update()` to trigger a re-render on each change |

## Usage

`bind()` must be called with the bindable element itself. Inside a Riot
component, query it with `this.$("my-input")` (or via a ref).

```html
<my-form>
  <div>
    <my-input></my-input>
    <p>value: { binder.values.value }</p>
    <p>checked: { binder.values.checked }</p>
  </div>

  <script>
    import { createWcBindable } from "@wc-bindable/riot";

    export default {
      onBeforeMount() {
        this.binder = createWcBindable(
          { value: "", checked: false },
          { update: () => this.update() },
        );
      },
      onMounted() {
        this.binder.bind(this.$("my-input"));
      },
      onBeforeUnmount() {
        this.binder.unbind();
      },
    };
  </script>
</my-form>
```

### Low-level usage

When you prefer to keep all reactive state in Riot's `state` object, use the
low-level helper and forward each update via `this.update()`:

```html
<my-form>
  <div>
    <my-input></my-input>
    <p>value: { state.value }</p>
  </div>

  <script>
    import { wcBindable } from "@wc-bindable/riot";

    export default {
      state: { value: "" },
      onMounted() {
        this.unbind = wcBindable(this.$("my-input"), (name, value) => {
          this.update({ [name]: value });
        });
      },
      onBeforeUnmount() {
        this.unbind?.();
      },
    };
  </script>
</my-form>
```

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
