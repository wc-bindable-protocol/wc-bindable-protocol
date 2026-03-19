<script setup lang="ts">
import { useWcBindable } from "../../packages/vue/src/index.ts";
import type { LitTodoElement, LitTodoValues } from "../vanilla/lit-todo/types.ts";
import "../vanilla/lit-todo/lit-todo.ts";
import appSource from "./App.vue?raw";

const { ref: todoRef, values } = useWcBindable<LitTodoElement, LitTodoValues>();
</script>

<template>
  <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Vue — Lit Todo</h1>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">
        Lit Todo Component
        <span
          v-if="values.count != null"
          style="display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px"
        >
          {{ values.count }}
        </span>
      </div>
      <lit-todo ref="todoRef" />
    </div>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Bound Values (via useWcBindable)</div>
      <pre style="font-size: 14px; color: #2563eb">{{ JSON.stringify(values, null, 2) }}</pre>
    </div>

    <div
      v-if="values.items && values.items.length > 0"
      style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px"
    >
      <div style="font-weight: 600; margin-bottom: 8px">Vue-rendered item list (from bound state)</div>
      <ul>
        <li v-for="(item, i) in values.items" :key="i">{{ item }}</li>
      </ul>
    </div>

    <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>{{ appSource }}</code></pre>
    </details>
  </div>
</template>
