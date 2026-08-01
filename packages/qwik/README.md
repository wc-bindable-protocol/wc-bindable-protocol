# @wc-bindable/qwik

Qwik adapter for the **wc-bindable** protocol.

Qwik 1.x (`@builder.io/qwik`) is the primary, stable target. A separate `/v2` sub-path targets Qwik 2.x (`@qwik.dev/core`) and is **experimental** — see the Qwik 2.x section below for the constraints.

## Install

```bash
# Qwik 1.x
npm install @wc-bindable/qwik @builder.io/qwik

# Qwik 2.x
npm install @wc-bindable/qwik @qwik.dev/core
```

## Usage

### Qwik 1.x

```tsx
import { component$ } from "@builder.io/qwik";
import { useWcBindable } from "@wc-bindable/qwik";

export const App = component$(() => {
  const { ref, values } = useWcBindable<HTMLElement, { value: string }>({
    value: "",
  });

  return (
    <>
      <my-input ref={ref}></my-input>
      <p>Value: {values.value}</p>
    </>
  );
});
```

### Qwik 2.x (experimental)

> **Note**: The `/v2` entry depends on `@qwik.dev/core/internal` for `useVisibleTaskQrl` / `inlinedQrl` / `TaskFn`, which Qwik 2 does not re-export from its public surface. Internal exports have no semver guarantee and may shift between beta releases, so the `peerDependencies` range is pinned to the exact tested Qwik 2 beta (currently `2.0.0-beta.35`). Using a different beta is unsupported and may break at runtime or at install time.

```tsx
import { component$ } from "@qwik.dev/core";
import { useWcBindable } from "@wc-bindable/qwik/v2";

export const App = component$(() => {
  const { ref, values } = useWcBindable<HTMLElement, { value: string }>({
    value: "",
  });

  return (
    <>
      <my-input ref={ref}></my-input>
      <p>Value: {values.value}</p>
    </>
  );
});
```

## API

### `useWcBindable<T, V>(initialValues?, options?)`

| Parameter | Type | Description |
|---|---|---|
| `initialValues` | `Partial<V>` | Optional initial values for bindable properties |
| `options` | `{ syncOn? }` | Forwarded to `bind()`. Defaults to `syncOn: "define"` — see [Late-defined elements](#late-defined-elements) |

Returns `{ ref, values }`:

| Member | Type | Description |
|---|---|---|
| `ref` | `Signal<T \| undefined>` | Pass to the bindable element's `ref` prop |
| `values` | `V` (reactive store) | Latest property values; reading from a template is reactive |

- Binding runs in `useVisibleTask$` — it activates client-side after the component becomes visible.
- The task tracks `ref.value`, so swapping the referenced element automatically rebinds.
- Cleanup runs on unmount via the task's `cleanup` callback.
- If the element does not implement `wc-bindable` — and is not a custom element still waiting for its definition — the hook is a no-op. See [Late-defined elements](#late-defined-elements).

## Late-defined elements

`bind()` is called with `syncOn: "define"` by default, so an element whose custom element
definition arrives *after* this adapter runs — import-map autoloading, a CDN
`<script type="module">`, a code-split route — still binds once the definition lands. Nothing
has to re-run, and no re-render is needed.

Before this default, a not-yet-upgraded element was skipped permanently and silently: discovery
failed, the adapter returned early, and because the element keeps its identity across upgrade
nothing ever noticed. Opt back into that behavior with `syncOn: "call"`.

```ts
const { ref, values } = useWcBindable<HTMLElement>({ value: "" }, { syncOn: "call" });
```

See [SPEC.md § Deferring Discovery Until Definition](../../SPEC.md#deferring-discovery-until-definition).

## Specification

The protocol contract this adapter implements lives in [SPEC.md](../../SPEC.md); the optional input/command invocation surface and the remote wire format live in [SPEC-extensions.md](../../SPEC-extensions.md). Runnable conformance vectors are in [CONFORMANCE.md](../../CONFORMANCE.md).

## License

MIT
