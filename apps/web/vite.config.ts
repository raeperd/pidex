import { healthSchema, type PidexApiContractClient } from "@pidex/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ConfigEnv, type Plugin, type UserConfig } from "vite";

const defaultBackendPort = 4783;
const backendStartupTimeout = 30_000;
const backendRequestTimeout = 1_000;
const backendRetryDelay = 100;

interface BackendEnvironment {
  readonly PORT?: string | undefined;
}

interface BackendWaitOptions {
  readonly requestTimeout?: number;
  readonly retryDelay?: number;
  readonly timeout?: number;
}

export default defineConfig((configEnv) => createViteConfig(configEnv));

export function createViteConfig(
  { command, isPreview, mode }: ConfigEnv,
  environment: BackendEnvironment = process.env,
): UserConfig {
  const backendOrigin =
    command === "serve" && !isPreview && mode !== "test"
      ? resolveBackendOrigin(environment.PORT)
      : undefined;

  const config: UserConfig = {
    base: "./",
    plugins: [
      backendOrigin === undefined ? undefined : waitForBackendPlugin(backendOrigin),
      tailwindcss(),
      svelte(),
    ],
  };
  if (backendOrigin)
    config.server = {
      host: "127.0.0.1",
      proxy: { "/api": { target: backendOrigin, ws: true } },
    };
  return config;
}

export function waitForBackendPlugin(backendOrigin: string): Plugin {
  return {
    name: "wait-for-pidex-backend",
    apply: "serve",
    async configureServer() {
      await waitForBackend(backendOrigin);
    },
  };
}

export async function waitForBackend(
  backendOrigin: string,
  options: BackendWaitOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? backendStartupTimeout;
  const requestTimeout = options.requestTimeout ?? backendRequestTimeout;
  const retryDelay = options.retryDelay ?? backendRetryDelay;
  const deadline = Date.now() + timeout;
  const backendClient = createBackendClient(backendOrigin);
  let lastError: unknown;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const health = await backendClient.system.health(
        {},
        { signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeout, remaining))) },
      );
      healthSchema.parse(health);
      return;
    } catch (error) {
      lastError = error;
    }

    const delay = Math.min(retryDelay, deadline - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(`Pidex backend did not become ready at ${backendOrigin}`, { cause: lastError });
}

function createBackendClient(backendOrigin: string): PidexApiContractClient {
  return createORPCClient(new RPCLink({ url: new URL("/api/rpc", backendOrigin) }));
}

function resolveBackendOrigin(portValue: string | undefined): string {
  return `http://127.0.0.1:${parseBackendPort(portValue)}`;
}

function parseBackendPort(value: string | undefined): number {
  if (value === undefined || value === "") return defaultBackendPort;
  if (!/^\d+$/.test(value)) throw invalidPort();
  const port = Number(value);
  if (port < 1024 || port > 65_535) throw invalidPort();
  return port;
}

function invalidPort(): Error {
  return new Error("PORT must be an integer from 1024 through 65535");
}
