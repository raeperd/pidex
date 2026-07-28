import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
export default defineConfig({
  // Component logic lives in the `<script module>` block of the component that owns it.
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    testTimeout: 10_000,
    // Icon packages ship uncompiled components that Vite would otherwise externalise.
    server: { deps: { inline: [/@lucide\/svelte/] } },
  },
});
