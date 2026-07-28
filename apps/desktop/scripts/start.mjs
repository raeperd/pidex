import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "darwin" ? prepareMacOSRuntime() : electronPath;
const result = spawnSync(executable, [desktopDirectory, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function prepareMacOSRuntime() {
  const sourceBundle = path.resolve(path.dirname(electronPath), "../..");
  const iconPath = path.join(desktopDirectory, "assets", "icon.icns");
  const electronVersion = require("electron/package.json").version;
  const iconHash = createHash("sha256").update(readFileSync(iconPath)).digest("hex").slice(0, 12);
  const cacheRoot = path.join(tmpdir(), "pidex-electron-runtime");
  const appBundle = path.join(
    cacheRoot,
    `${electronVersion}-${process.arch}-${iconHash}-v1`,
    "pidex.app",
  );
  const appExecutable = path.join(appBundle, "Contents", "MacOS", "pidex");

  if (existsSync(appExecutable)) return appExecutable;

  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(cacheRoot, ".staging-"));
  const stagingBundle = path.join(stagingRoot, "pidex.app");

  try {
    execFileSync("/bin/cp", ["-cR", sourceBundle, stagingBundle]);
    rebrandMacOSBundle(stagingBundle, iconPath);
    mkdirSync(path.dirname(appBundle), { recursive: true });
    if (!existsSync(appBundle)) renameSync(stagingBundle, appBundle);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return appExecutable;
}

function rebrandMacOSBundle(appBundle, iconPath) {
  const contentsDirectory = path.join(appBundle, "Contents");
  const plistPath = path.join(contentsDirectory, "Info.plist");
  const executableDirectory = path.join(contentsDirectory, "MacOS");

  renameSync(path.join(executableDirectory, "Electron"), path.join(executableDirectory, "pidex"));
  copyFileSync(iconPath, path.join(contentsDirectory, "Resources", "pidex.icns"));
  setPlistString(plistPath, "CFBundleDisplayName", "pidex");
  setPlistString(plistPath, "CFBundleExecutable", "pidex");
  setPlistString(plistPath, "CFBundleIconFile", "pidex.icns");
  setPlistString(plistPath, "CFBundleIdentifier", "dev.pidex");
  setPlistString(plistPath, "CFBundleName", "pidex");
  execFileSync(macOSUtilityPath("codesign"), ["--force", "--sign", "-", appBundle]);
}

function setPlistString(plistPath, key, value) {
  execFileSync(macOSUtilityPath("plutil"), ["-replace", key, "-string", value, plistPath]);
}

function macOSUtilityPath(name) {
  return path.join("/", "usr", "bin", name);
}
