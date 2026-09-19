import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: { actionTimeout: 5000 },
  timeout: 30_000,
  reporter: "list",
});
