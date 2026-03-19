<script setup lang="ts">
import { useWcBindable } from "../../packages/vue/src/index.ts";
import type { MyCounterElement, MyCounterValues } from "../vanilla/counter/types.ts";
import "../vanilla/counter/my-counter.js";
import appSource from "./App.vue?raw";

const { ref: counterRef, values } = useWcBindable<MyCounterElement, MyCounterValues>();
</script>

<template>
  <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Vue — Counter</h1>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Counter Component</div>
      <my-counter ref="counterRef" />
    </div>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Bound Values (via useWcBindable)</div>
      <pre style="font-size: 14px; color: #2563eb">{{ JSON.stringify(values, null, 2) }}</pre>
    </div>

    <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>{{ appSource }}</code></pre>
    </details>
  </div>
</template>
