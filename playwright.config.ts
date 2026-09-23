import { defineConfig } from "@playwright/test";

process.env.PIDEX_TEST_HEADLESS ??= "1";

export default defineConfig({
  testDir: "./tests",
  workers: process.env.CI ? 2 : "50%",
  use: { actionTimeout: 5000 },
  timeout: 30_000,
  reporter: "list",
});
