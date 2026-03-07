# @wc-bindable/vue

Vue adapter for the **wc-bindable** protocol.

## Install

```bash
npm install @wc-bindable/vue @wc-bindable/core
```

## Usage

```vue
<script setup lang="ts">
import { useWcBindable } from "@wc-bindable/vue";

const { ref, values } = useWcBindable<HTMLElement>({ value: "" });
</script>

<template>
  <my-input :ref="ref" />
  <p>Current value: {{ values.value }}</p>
</template>
```

## API

### `useWcBindable<T>(initialValues?)`

| Parameter | Type | Description |
|---|---|---|
| `T` | generic | The element type (e.g. `HTMLElement`) |
| `initialValues` | `Record<string, unknown>` | Optional initial values for bindable properties |

**Returns:** `{ ref, values }`

| Return | Type | Description |
|---|---|---|
| `ref` | `Ref<T \| null>` | Template ref to attach to the target element |
| `values` | `Record<string, unknown>` | Reactive object containing the latest property values |

- Binds on `onMounted` and cleans up on `onUnmounted`.
- If the element does not implement `wc-bindable`, the composable is a no-op.

## License

MIT
