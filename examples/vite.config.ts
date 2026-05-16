import fs from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import solid from "vite-plugin-solid";
import { qwikVite } from "@builder.io/qwik/optimizer";
import marko from "@marko/vite";
import path from "path";

function collectExampleInputs(rootDir: string): Record<string, string> {
  const inputs: Record<string, string> = {};

  function walk(currentDir: string) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.name !== "index.html") continue;

      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
      if (relativePath === "index.html") continue;

      const key = relativePath.slice(0, -"/index.html".length).replace(/\//g, "-");
      inputs[key] = fullPath;
    }
  }

  walk(rootDir);
  return inputs;
}

const exampleInputs = collectExampleInputs(__dirname);

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
        /[\\/]examples[\\/]react[\\/].*\.tsx?$/,
        /[\\/]examples[\\/]preact[\\/].*\.tsx?$/,
      ],
    }),
    svelte(),
    solid({
      include: /[\\/]examples[\\/]solid[\\/].*\.tsx?$/,
    }),
    qwikVite({
      csr: true,
      srcDir: path.resolve(__dirname, "qwik"),
      // Match examples/qwik/ source files AND the segment chunks qwikVite
      // generates from them. The filter must NOT match packages/qwik/ — the
      // adapter source there already uses the lower-level inlinedQrl API, so
      // a second optimizer pass tries to hoist its `task` variable and breaks
      // it with "task is not defined" at runtime.
      fileFilter: (id) =>
        /[\\/]examples[\\/]qwik[\\/]/.test(id) ||
        /\.tsx?_[^/\\]+\.js$/.test(id),
    }),
    {
      // qwikVite's config() hook sets `esbuild: false` in serve mode, which
      // breaks JSX transforms for the other framework examples that lean on
      // Vite's default esbuild step (plugin-react adds the Refresh wrapper
      // but defers JSX transform to esbuild). Restore it after qwikVite.
      name: "restore-esbuild-for-non-qwik-examples",
      config: () => ({ esbuild: { jsx: "automatic" } }),
    },
    marko({ linked: false }),
  ],
  resolve: {
    alias: {
      "@wc-bindable/core": path.resolve(__dirname, "../packages/core/src/index.ts"),
      "@wc-bindable/marko": path.resolve(__dirname, "../packages/marko/src/index.ts"),
      // Marko 5's nested @internal/* modules ship Node and browser variants,
      // but Vite's dep optimizer doesn't honor their "browser" export
      // condition and picks the Node entries — which use setImmediate and
      // export the server registry shape instead of the browser one. Alias
      // each @internal/* module to its browser file explicitly.
      "@internal/set-immediate": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/set-immediate/index-browser.js"),
      "@internal/components-registry": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-registry/index-browser.js"),
      "@internal/components-util": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-util/index-browser.js"),
      "@internal/components-entry": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-entry/index-browser.js"),
      "@internal/components-entry-legacy": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-entry-legacy/index-browser.js"),
      "@internal/components-beginComponent": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-beginComponent/index-browser.js"),
      "@internal/components-endComponent": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-endComponent/index-browser.js"),
      "@internal/components-define-widget-legacy": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/components-define-widget-legacy/index-browser.js"),
      "@internal/create-readable": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/create-readable/index-browser.js"),
      "@internal/loader": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/loader/index-browser.js"),
      "@internal/preserve-tag": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/preserve-tag/index-browser.js"),
      "@internal/require": path.resolve(__dirname, "../node_modules/marko/src/node_modules/@internal/require/index-browser.js"),
    },
  },
  server: {
    open: "/index.html",
  },
  build: {
    rollupOptions: {
      input: exampleInputs,
    },
  },
});
