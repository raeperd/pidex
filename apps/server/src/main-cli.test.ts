import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const children = new Set<ReturnType<typeof spawn>>();
const directories = new Set<string>();

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true })));
  directories.clear();
});

it("starts the standalone server without a desktop supervisor or fd3", async () => {
  const port = await availablePort();
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "pidex-standalone-"));
  directories.add(stateDirectory);
  const child = spawn(process.execPath, ["--import=tsx", "main.ts"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      PORT: String(port),
      PIDEX_STATE_DIR: stateDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  await expect(waitForHealth(port, child, output)).resolves.toBe(200);
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth(
  port: number,
  child: ReturnType<typeof spawn>,
  output: ReadonlyArray<string>,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Standalone server exited with ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/rpc/system/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
      if (response.ok) return response.status;
    } catch {
      // The server has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Standalone server did not become healthy: ${output.join("")}`);
}
