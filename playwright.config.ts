import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
const e2ePort = Number(process.env.PIDEX_E2E_PORT ?? 40_000 + (process.pid % 20_000));
process.env.PIDEX_E2E_PORT = String(e2ePort);
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;
export default defineConfig({
  testDir: "./e2e",
  timeout: 40_000,
  expect: { timeout: 8_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: {
    baseURL: e2eOrigin,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: "pnpm build && exec node apps/server/dist/main.js",
    url: e2eOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(e2ePort),
      PIDEX_PROJECT_ROOTS: process.cwd(),
      WORKSPACE_ROOTS: process.cwd(),
      PIDEX_STATE_DIR: path.join(os.tmpdir(), `pidex-e2e-${process.pid}`),
    },
  },
});
