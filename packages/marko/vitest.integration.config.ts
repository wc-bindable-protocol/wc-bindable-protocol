import { defineConfig } from "vitest/config";
import path from "path";
import marko from "@marko/vite";

export default defineConfig({
  plugins: [marko()],
  resolve: {
    alias: {
      "@wc-bindable/core": path.resolve(
        __dirname,
        "../core/src/index.ts",
      ),
      "@wc-bindable/marko": path.resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["integration/**/*.test.ts"],
    exclude: [],
  },
});
