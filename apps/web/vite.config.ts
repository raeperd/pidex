import { randomBytes } from "node:crypto";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ConfigEnv, type Plugin, type UserConfig } from "vite";
import { createPidexApplication } from "../server/src/main.ts";
import { parsePort } from "../server/src/security.ts";

interface DevelopmentEnvironment {
  readonly PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL?: string | undefined;
  readonly PORT?: string | undefined;
}

export default defineConfig((configEnv) => createViteConfig(configEnv));

export function createViteConfig(
  { command, isPreview, mode }: ConfigEnv,
  environment: DevelopmentEnvironment = process.env,
): UserConfig {
  const development = command === "serve" && !isPreview && mode !== "test";
  const desktopBootstrapCredential =
    environment.PIDEX_DESKTOP_BOOTSTRAP_CREDENTIAL ??
    (development ? randomBytes(32).toString("base64url") : "");
  const config: UserConfig = {
    define: {
      PIDEX_DEV_BOOTSTRAP_CREDENTIAL: JSON.stringify(desktopBootstrapCredential),
    },
    plugins: [
      development ? pidexApplication(desktopBootstrapCredential) : undefined,
      tailwindcss(),
      sveltekit(),
    ],
  };
  if (development)
    config.server = {
      host: "127.0.0.1",
      port: parsePort(environment.PORT),
      strictPort: false,
    };
  return config;
}

function pidexApplication(desktopBootstrapCredential: string): Plugin {
  let close: (() => Promise<void>) | undefined;
  return {
    name: "pidex-application",
    apply: "serve",
    async configureServer(vite) {
      if (!vite.httpServer) throw new Error("Pidex requires Vite's HTTP server");
      const application = await createPidexApplication({ desktopBootstrapCredential });
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
