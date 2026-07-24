import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [target] : [];
  });
}

function importsIn(directory: string): Array<{ file: string; specifier: string }> {
  return sourceFiles(directory).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/(?:from\s+|import\s*\(|import\s+)["']([^"']+)["']/g)].map(
      (match) => ({ file: path.relative(repositoryRoot, file), specifier: match[1]! }),
    );
  });
}

function crossAppImports(app: "web" | "server" | "desktop", targets: string[]) {
  return importsIn(path.join(repositoryRoot, "apps", app)).filter(({ specifier }) =>
    targets.some(
      (target) =>
        specifier.startsWith(`@pidex/${target}`) ||
        specifier.includes(`apps/${target}`) ||
        new RegExp(`(?:\\.\\./)+${target}/`).test(specifier),
    ),
  );
}

describe("documented architecture boundaries", () => {
  it("keeps the browser independent from server and Electron implementations", () => {
    expect(crossAppImports("web", ["server", "desktop"])).toEqual([]);
  });

  it("keeps the server independent from web and Electron implementations", () => {
    expect(crossAppImports("server", ["web", "desktop"])).toEqual([]);
  });

  it("makes Electron spawn the server instead of importing its implementation", () => {
    expect(crossAppImports("desktop", ["server"])).toEqual([]);
  });

  it("keeps the shared API package implementation-neutral", () => {
    const forbidden = importsIn(path.join(repositoryRoot, "packages", "api", "src")).filter(
      ({ specifier }) =>
        specifier.startsWith("node:") || ["electron", "svelte", "ws"].includes(specifier),
    );
    expect(forbidden).toEqual([]);
  });
});
