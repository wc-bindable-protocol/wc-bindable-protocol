import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import react from "@vitejs/plugin-react";
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
    react(),
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
        litTodo: path.resolve(__dirname, "vanilla/lit-todo/index.html"),
        reactLitTodo: path.resolve(__dirname, "react-lit-todo/index.html"),
        vueLitTodo: path.resolve(__dirname, "vue-lit-todo/index.html"),
      },
    },
  },
});
