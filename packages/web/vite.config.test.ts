import { describe, expect, test } from "vitest";
import viteConfig from "./vite.config.js";

const createViteConfig = async (
  configEnv: Parameters<Extract<typeof viteConfig, (...args: never[]) => unknown>>[0],
  environment: Record<string, string> = {},
) => {
  const previousPort = process.env.PORT;
  if ("PORT" in environment) process.env.PORT = environment.PORT;
  try {
    return await viteConfig(configEnv);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
};

describe("Pidex Vite config", () => {
  test("uses one Vite-owned development port with automatic fallback", async () => {
    const config = await createViteConfig(
      { command: "serve", mode: "development", isPreview: false, isSsrBuild: false },
      { PORT: "6123" },
    );

    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: 6123,
      strictPort: false,
    });
    expect(config.server?.proxy).toBeUndefined();
    expect(config.plugins?.[0]).toMatchObject({ name: "pidex-application" });
  });

  test("does not initialize development behavior for tests or builds", async () => {
    for (const configEnv of [
      { command: "serve", mode: "test", isPreview: false, isSsrBuild: false },
      { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
    ] as const) {
      const config = await createViteConfig(configEnv, { PORT: "invalid" });
      expect(config.server).toBeUndefined();
      expect(config.plugins?.flat()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "pidex-application" })]),
      );
    }
  });

  test.each(["0", "1023", "65536", "1.5", "not-a-port"])(
    "rejects invalid development port %s",
    async (port) => {
      await expect(
        createViteConfig(
          { command: "serve", mode: "development", isPreview: false, isSsrBuild: false },
          { PORT: port },
        ),
      ).rejects.toThrow("PORT must be an integer from 1024 through 65535");
    },
  );
});
