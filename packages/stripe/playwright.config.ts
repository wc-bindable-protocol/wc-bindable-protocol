import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/integration",
  timeout: 20_000,
  use: {
    browserName: "chromium",
  },
});