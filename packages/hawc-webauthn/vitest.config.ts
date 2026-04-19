import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["__tests__/**/*.{test,spec}.{js,ts}"],
    setupFiles: ["__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/types.ts",
        "src/index.ts",
        "src/server/index.ts",
      ],
    },
  },
});
