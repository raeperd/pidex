import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ConfigEnv, type Plugin, type UserConfig } from "vite";
import { createPidexApplication } from "../server/src/main.ts";
import { parsePort } from "../server/src/security.ts";

interface DevelopmentEnvironment {
  readonly PORT?: string | undefined;
}

export default defineConfig((configEnv) => createViteConfig(configEnv));

export function createViteConfig(
  { command, isPreview, mode }: ConfigEnv,
  environment: DevelopmentEnvironment = process.env,
): UserConfig {
  const development = command === "serve" && !isPreview && mode !== "test";
  const config: UserConfig = {
    base: "./",
    plugins: [development ? pidexApplication() : undefined, tailwindcss(), svelte()],
  };
  if (development)
    config.server = {
      host: "127.0.0.1",
      port: parsePort(environment.PORT),
      strictPort: false,
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
      const upgrade = application.handleUpgrade.bind(application);
      vite.httpServer.prependListener("upgrade", upgrade);
      vite.middlewares.use((req, res, next) => {
        const route = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!route.startsWith("/api/")) return next();
        void application.handleRequest(req, res);
      });
      let closed = false;
      const closeApplication = async () => {
        if (closed) return;
        closed = true;
        vite.httpServer?.off("upgrade", upgrade);
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
