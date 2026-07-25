import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PROTOCOL_VERSION } from "@pidex/api";
import { afterEach, describe, expect, test } from "vitest";
import { createViteConfig, waitForBackend } from "./vite.config.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Pidex Vite config", () => {
  test("uses the Pidex server port for the dev proxy", () => {
    const config = createViteConfig(
      { command: "serve", mode: "development", isPreview: false, isSsrBuild: false },
      { PORT: "6123" },
    );

    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      proxy: { "/api": { target: "http://127.0.0.1:6123", ws: true } },
    });
    expect(config.plugins?.[0]).toMatchObject({ name: "wait-for-pidex-backend" });
  });

  test("does not initialize backend development behavior for tests or builds", () => {
    for (const configEnv of [
      { command: "serve", mode: "test", isPreview: false, isSsrBuild: false },
      { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
    ] as const) {
      expect(() => createViteConfig(configEnv, { PORT: "invalid" })).not.toThrow();
      const config = createViteConfig(configEnv, { PORT: "invalid" });
      expect(config.server).toBeUndefined();
      expect(config.plugins?.flat()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "wait-for-pidex-backend" })]),
      );
    }
  });

  test.each(["0", "1023", "65536", "1.5", "not-a-port"])(
    "rejects invalid backend port %s",
    (port) => {
      expect(() =>
        createViteConfig(
          { command: "serve", mode: "development", isPreview: false, isSsrBuild: false },
          { PORT: port },
        ),
      ).toThrow("PORT must be an integer from 1024 through 65535");
    },
  );

  test("waits for a compatible backend health response", async () => {
    let attempts = 0;
    const backendOrigin = await startBackend((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/rpc/system/health");
      attempts += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          json:
            attempts < 2
              ? { ok: true, protocolVersion: -1 }
              : { ok: true, protocolVersion: PROTOCOL_VERSION },
        }),
      );
    });

    await waitForBackend(backendOrigin, { requestTimeout: 100, retryDelay: 1, timeout: 500 });
    expect(attempts).toBe(2);
  });

  test("bounds stalled backend health requests", async () => {
    const backendOrigin = await startBackend(() => undefined);
    const startedAt = Date.now();

    await expect(
      waitForBackend(backendOrigin, { requestTimeout: 20, retryDelay: 1, timeout: 80 }),
    ).rejects.toThrow(`Pidex backend did not become ready at ${backendOrigin}`);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

async function startBackend(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IP test address");
  return `http://127.0.0.1:${address.port}`;
}
