import { describe, expect, test } from "vitest";
import { createViteConfig } from "./vite.config.js";

describe("Pidex Vite config", () => {
  test("uses one Vite-owned development port with automatic fallback", () => {
    const config = createViteConfig(
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

  test("does not initialize development behavior for tests or builds", () => {
    for (const configEnv of [
      { command: "serve", mode: "test", isPreview: false, isSsrBuild: false },
      { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
    ] as const) {
      expect(() => createViteConfig(configEnv, { PORT: "invalid" })).not.toThrow();
      const config = createViteConfig(configEnv, { PORT: "invalid" });
      expect(config.server).toBeUndefined();
      expect(config.plugins?.flat()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "pidex-application" })]),
      );
    }
  });

  test.each(["0", "1023", "65536", "1.5", "not-a-port"])(
    "rejects invalid development port %s",
    (port) => {
      expect(() =>
        createViteConfig(
          { command: "serve", mode: "development", isPreview: false, isSsrBuild: false },
          { PORT: port },
        ),
      ).toThrow("PORT must be an integer from 1024 through 65535");
    },
  );
});
