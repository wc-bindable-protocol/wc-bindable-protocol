import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/integration",
  timeout: 15000,
  use: {
    browserName: "chromium",
  },
});
