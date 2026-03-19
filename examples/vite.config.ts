import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import solid from "vite-plugin-solid";
import path from "path";

export default defineConfig({
  root: __dirname,
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith("my-") || tag.startsWith("lit-"),
        },
      },
    }),
    react({
      include: [
        /react-.*\.tsx?$/,
        /preact-.*\.tsx?$/,
      ],
    }),
    svelte(),
    solid({
      include: /solid-.*\.tsx?$/,
    }),
  ],
  resolve: {
    alias: {
      "@wc-bindable/core": path.resolve(__dirname, "../packages/core/src/index.ts"),
    },
  },
  server: {
    open: "/index.html",
  },
  build: {
    rollupOptions: {
      input: {
        counter: path.resolve(__dirname, "vanilla/counter/index.html"),
        fetch: path.resolve(__dirname, "vanilla/fetch/index.html"),
        reactCounter: path.resolve(__dirname, "react-counter/index.html"),
        reactFetch: path.resolve(__dirname, "react-fetch/index.html"),
        vueCounter: path.resolve(__dirname, "vue-counter/index.html"),
        vueFetch: path.resolve(__dirname, "vue-fetch/index.html"),
        preactCounter: path.resolve(__dirname, "preact-counter/index.html"),
        svelteCounter: path.resolve(__dirname, "svelte-counter/index.html"),
        solidCounter: path.resolve(__dirname, "solid-counter/index.html"),
        angularCounter: path.resolve(__dirname, "angular-counter/index.html"),
        alpineCounter: path.resolve(__dirname, "alpine-counter/index.html"),
        preactFetch: path.resolve(__dirname, "preact-fetch/index.html"),
        svelteFetch: path.resolve(__dirname, "svelte-fetch/index.html"),
        solidFetch: path.resolve(__dirname, "solid-fetch/index.html"),
        angularFetch: path.resolve(__dirname, "angular-fetch/index.html"),
        alpineFetch: path.resolve(__dirname, "alpine-fetch/index.html"),
        litTodo: path.resolve(__dirname, "vanilla/lit-todo/index.html"),
        reactLitTodo: path.resolve(__dirname, "react-lit-todo/index.html"),
        vueLitTodo: path.resolve(__dirname, "vue-lit-todo/index.html"),
        preactLitTodo: path.resolve(__dirname, "preact-lit-todo/index.html"),
        svelteLitTodo: path.resolve(__dirname, "svelte-lit-todo/index.html"),
        solidLitTodo: path.resolve(__dirname, "solid-lit-todo/index.html"),
        angularLitTodo: path.resolve(__dirname, "angular-lit-todo/index.html"),
        alpineLitTodo: path.resolve(__dirname, "alpine-lit-todo/index.html"),
      },
    },
  },
});
