import { readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectCandidate } from "@pidex/api";
import { isDescendant } from "./security.js";

const ignoredNames = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function configuredProjectRoots(): string[] {
  const configured = process.env.PIDEX_PROJECT_ROOTS?.split(path.delimiter).filter(Boolean);
  return configured?.length ? configured : [path.join(os.homedir(), "Projects")];
}

export async function discoverProjectCandidates(
  allowedRoots: string[],
): Promise<ProjectCandidate[]> {
  const candidates = new Map<string, ProjectCandidate>();
  for (const configuredRoot of configuredProjectRoots()) {
    let root: string;
    try {
      root = await realpath(configuredRoot);
    } catch {
      continue;
    }
    if (!allowedRoots.some((allowed) => isDescendant(allowed, root))) continue;

    const entries = await readdir(root, { withFileTypes: true, encoding: "utf8" }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignoredNames.has(entry.name))
        continue;
      let candidatePath: string;
      try {
        candidatePath = await realpath(path.join(root, entry.name));
      } catch {
        continue;
      }
      if (
        !isDescendant(root, candidatePath) ||
        !allowedRoots.some((allowed) => isDescendant(allowed, candidatePath))
      )
        continue;
      candidates.set(candidatePath, { name: entry.name, path: candidatePath });
      if (candidates.size >= 200) break;
    }
    if (candidates.size >= 200) break;
  }
  return [...candidates.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}
