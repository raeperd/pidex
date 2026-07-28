import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectCandidate } from "@pidex/api";
import { Effect } from "effect";
import { applicationError, HttpError } from "./errors.js";
import { isDescendant } from "./security.js";

const execFileAsync = promisify(execFile);

export const createProjectWorktree = Effect.fn("projects.createWorktree")(function* (
  sourceProjectPath: string,
) {
  const repository = yield* inspectRepository(sourceProjectPath);
  const relativeProjectPath = path.relative(repository.worktreeRoot, sourceProjectPath);
  if (!isDescendant(repository.worktreeRoot, sourceProjectPath))
    return yield* Effect.fail(
      HttpError.make({
        status: 400,
        code: "project_outside_repository",
        message: "Project directory is outside its Git working tree",
      }),
    );

  const token = randomBytes(4).toString("hex");
  const branch = `pidex/${token}`;
  const repositoryKey = createHash("sha256")
    .update(path.resolve(repository.commonGitDirectory))
    .digest("hex")
    .slice(0, 12);
  const worktreeRoot = path.join(
    managedWorktreesRoot(),
    repositoryKey,
    token,
    path.basename(repository.worktreeRoot),
  );
  yield* Effect.tryPromise({
    try: () => mkdir(path.dirname(worktreeRoot), { recursive: true, mode: 0o700 }),
    catch: (cause) => applicationError("worktree.directory.create", cause),
  });
  yield* runGit(
    repository.worktreeRoot,
    ["worktree", "add", "-b", branch, worktreeRoot, "HEAD"],
    "worktree_create_failed",
    "Git could not create a worktree for this project",
  );

  const mappedProjectPath = path.join(worktreeRoot, relativeProjectPath);
  return yield* Effect.tryPromise({
    try: () => realpath(mappedProjectPath),
    catch: (cause) => applicationError("worktree.project.resolve", cause),
  }).pipe(
    Effect.catch(() =>
      Effect.tryPromise({
        try: () => rollbackWorktree(repository.worktreeRoot, worktreeRoot, branch),
        catch: (cause) => applicationError("worktree.rollback", cause),
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          Effect.fail(
            HttpError.make({
              status: 400,
              code: "project_missing_from_worktree",
              message: "Project directory does not exist in the current Git revision",
            }),
          ),
        ),
      ),
    ),
  );
});

export function managedWorktreesRoot(): string {
  const stateDirectory = process.env.PIDEX_STATE_DIR ?? path.join(os.homedir(), ".pidex");
  try {
    return path.join(realpathSync(stateDirectory), "worktrees");
  } catch {
    return path.resolve(stateDirectory, "worktrees");
  }
}

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

const inspectRepository = Effect.fn("projects.inspectRepository")(function* (
  sourceProjectPath: string,
) {
  const output = yield* runGit(
    sourceProjectPath,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    "project_not_git",
    "Project is not inside a Git repository",
  );
  const [worktreeRoot, commonGitDirectory] = output.split(/\r?\n/).map((value) => value.trim());
  if (!worktreeRoot || !commonGitDirectory)
    return yield* Effect.fail(
      HttpError.make({
        status: 400,
        code: "project_not_git",
        message: "Git did not return repository information for this project",
      }),
    );
  return { worktreeRoot, commonGitDirectory };
});

function runGit(cwd: string, args: string[], code: string, message: string) {
  return Effect.tryPromise({
    try: () =>
      execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 120_000 }).then(
        ({ stdout }) => stdout,
      ),
    catch: () => HttpError.make({ status: 400, code, message }),
  });
}

async function rollbackWorktree(repositoryRoot: string, worktreeRoot: string, branch: string) {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreeRoot], {
      cwd: repositoryRoot,
      timeout: 120_000,
    });
  } catch {
    return;
  }
  try {
    await execFileAsync("git", ["branch", "-D", branch], {
      cwd: repositoryRoot,
      timeout: 120_000,
    });
  } catch {
    // The worktree was removed; a leftover branch is safe and visible to Git.
  }
}
