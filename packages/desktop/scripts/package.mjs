import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopDirectory, "../..");
const stageDirectory = path.join(desktopDirectory, ".package");
const appDirectory = path.join(stageDirectory, "app");

await stageApplication();

async function stageApplication() {
  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });
  await runPnpm(["--filter", "@pidex/desktop", "deploy", "--prod", appDirectory]);
  await runPnpm([
    "--filter",
    "@pidex/server",
    "deploy",
    "--prod",
    path.join(stageDirectory, "server"),
  ]);
  await cp(path.join(repositoryRoot, "packages/web/dist"), path.join(stageDirectory, "web/dist"), {
    recursive: true,
  });
}

function runPnpm(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", arguments_, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}
