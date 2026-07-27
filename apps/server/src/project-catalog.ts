import { readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectCandidate } from "@pidex/api";
import { Effect } from "effect";
import { isDescendant } from "./security.js";

export const discoverProjectCandidates = Effect.fn("projects.discoverCandidates")(function* (
  allowedRoots: string[],
) {
  const candidates = new Map<string, ProjectCandidate>();
  for (const configuredRoot of configuredProjectRoots()) {
    const root = yield* optionalPromise(() => realpath(configuredRoot));
    if (!root || !allowedRoots.some((allowed) => isDescendant(allowed, root))) continue;

    const entries =
      (yield* optionalPromise(() => readdir(root, { withFileTypes: true, encoding: "utf8" }))) ??
      [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignoredNames.has(entry.name))
        continue;
      const candidatePath = yield* optionalPromise(() => realpath(path.join(root, entry.name)));
      if (
        !candidatePath ||
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
});

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

function optionalPromise<A>(evaluate: () => PromiseLike<A>): Effect.Effect<A | undefined> {
  return Effect.tryPromise(evaluate).pipe(Effect.catch(() => Effect.succeed(undefined)));
}
