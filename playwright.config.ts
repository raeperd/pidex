import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
export default defineConfig({ testDir: "./e2e", timeout: 30_000, retries: 0, workers: 1, use: { baseURL: "http://127.0.0.1:4783", trace: "retain-on-failure" }, projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["Pixel 7"] } }], webServer: { command: "pnpm build && pnpm start", url: "http://127.0.0.1:4783/api/health", reuseExistingServer: false, timeout: 120_000, env: { PIDEX_ADAPTER: "fake", WORKSPACE_ROOTS: process.cwd(), PIDEX_STATE_DIR: path.join(os.tmpdir(), `pidex-e2e-${process.pid}`) } } });
