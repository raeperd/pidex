import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: process.env.CI ? 3 : 1,
  use: { actionTimeout: 5000 },
  timeout: 30_000,
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "test-results/results.json" }]]
    : "list",
});
