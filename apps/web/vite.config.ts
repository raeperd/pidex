import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), svelte()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:4783", ws: true } } },
});
