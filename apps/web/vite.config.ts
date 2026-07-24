import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const backendUrl = "http://127.0.0.1:4783";

function waitForBackend(): Plugin {
  return {
    name: "wait-for-pidex-backend",
    apply: "serve",
    async configureServer() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${backendUrl}/api/health`);
          if (response.ok) return;
        } catch {
          // The server process is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Pidex backend did not become ready at ${backendUrl}`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [waitForBackend(), tailwindcss(), svelte()],
  server: { proxy: { "/api": { target: backendUrl, ws: true } } },
});
