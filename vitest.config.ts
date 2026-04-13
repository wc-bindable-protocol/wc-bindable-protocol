import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@wc-bindable/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@wc-bindable/remote": path.resolve(__dirname, "packages/remote/src/index.ts"),
      "solid-js/web": path.resolve(__dirname, "node_modules/solid-js/web/dist/web.js"),
      "solid-js": path.resolve(__dirname, "node_modules/solid-js/dist/solid.js"),
    },
  },
  test: {
    environment: "happy-dom",
    exclude: ["**/integration/**", "**/node_modules/**"],
  },
});
