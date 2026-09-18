import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    // Remove this once the first behavior test is added.
    passWithNoTests: true,
  },
});
