import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: {
    csp: { directives: { "default-src": ["self"], "style-src": ["self", "unsafe-inline"] } },
    adapter: adapter({ pages: "dist", assets: "dist" }),
  },
};
