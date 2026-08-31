import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ConfigEnv, type Plugin, type UserConfig } from "vite";
import { createPidexApplication } from "../server/src/main.ts";
import { parsePort } from "../server/src/security.ts";

interface DevelopmentEnvironment {
  readonly PORT?: string | undefined;
}

export default defineConfig((configEnv) => createViteConfig(configEnv));

function createViteConfig(
  { command, isPreview, mode }: ConfigEnv,
  environment: DevelopmentEnvironment = process.env,
): UserConfig {
  const development = command === "serve" && !isPreview && mode !== "test";
  const config: UserConfig = {
    plugins: [development ? pidexApplication() : undefined, tailwindcss(), sveltekit()],
    // pnpm injects @pidex/api into node_modules, so Vite would prebundle it and
    // keep serving the stale copy after `pnpm --filter @pidex/api build`. Serve
    // it unbundled and watch it so rebuilds reach the browser.
    optimizeDeps: { exclude: ["@pidex/api"] },
  };
  if (development)
    config.server = {
      host: "127.0.0.1",
      port: parsePort(environment.PORT),
      strictPort: false,
      watch: { ignored: ["!**/node_modules/@pidex/api/**"] },
    };
  return config;
}

function pidexApplication(): Plugin {
  let close: (() => Promise<void>) | undefined;
  return {
    name: "pidex-application",
    apply: "serve",
    async configureServer(vite) {
      if (!vite.httpServer) throw new Error("Pidex requires Vite's HTTP server");
      const application = await createPidexApplication();
      vite.middlewares.use((req, res, next) => {
        const route = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!route.startsWith("/api/")) return next();
        void application.handleRequest(req, res);
      });
      let closed = false;
      const closeApplication = async () => {
        if (closed) return;
        closed = true;
        await application.close();
      };
      close = closeApplication;
      vite.httpServer.once("close", () => void closeApplication());
    },
    async closeBundle() {
      await close?.();
    },
  };
}
