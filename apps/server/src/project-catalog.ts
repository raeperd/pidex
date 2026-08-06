import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectCandidate, WorktreeSupport } from "@pidex/api";
import { Effect } from "effect";
import { applicationError, HttpError } from "./errors.js";
import { isDescendant } from "./security.js";

const execFileAsync = promisify(execFile);

export const projectWorktreeSupport = Effect.fn("projects.worktreeSupport")(function* (
  projectPath: string,
) {
  return yield* inspectRepository(projectPath).pipe(
    Effect.andThen(() =>
      runGit(
        projectPath,
        ["rev-parse", "--verify", "HEAD"],
        "project_has_no_head",
        "Project does not have a committed Git revision",
      ),
    ),
    Effect.match({
      onFailure: (): WorktreeSupport => "unsupported",
      onSuccess: (): WorktreeSupport => "supported",
    }),
  );
});

export const initializeProjectGit = Effect.fn("projects.initializeGit")(function* (
  projectPath: string,
) {
  yield* runGit(
    projectPath,
    ["init"],
    "git_initialize_failed",
    "Git could not initialize this project",
  );
});

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
  const managedRoot = yield* managedWorktreesRoot();
  const worktreeRoot = path.join(
    managedRoot,
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
      rollbackWorktree(repository.worktreeRoot, worktreeRoot, branch).pipe(
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

export const removeProjectWorktree = Effect.fn("projects.removeWorktree")(function* (
  sourceProjectPath: string,
  worktreeProjectPath: string,
) {
  const sourceRepository = yield* inspectRepository(sourceProjectPath);
  const worktreeRepository = yield* inspectRepository(worktreeProjectPath);
  const branch = (yield* runGit(
    worktreeRepository.worktreeRoot,
    ["branch", "--show-current"],
    "worktree_branch_read_failed",
    "Git could not identify the worktree branch",
  )).trim();
  const managedRoot = yield* managedWorktreesRoot();
  if (
    path.resolve(sourceRepository.commonGitDirectory) !==
      path.resolve(worktreeRepository.commonGitDirectory) ||
    !isDescendant(managedRoot, worktreeRepository.worktreeRoot) ||
    !/^pidex\/[0-9a-f]{8}$/.test(branch)
  )
    return yield* Effect.fail(
      HttpError.make({
        status: 400,
        code: "workspace_not_managed_worktree",
        message: "Workspace is not a managed Pidex worktree",
      }),
    );

  yield* runGit(
    sourceRepository.worktreeRoot,
    ["worktree", "remove", worktreeRepository.worktreeRoot],
    "worktree_remove_failed",
    "Git could not remove the worktree",
  );
  yield* runGit(
    sourceRepository.worktreeRoot,
    ["branch", "-D", branch],
    "worktree_branch_remove_failed",
    "Git could not remove the worktree branch",
  );
});

export const managedWorktreesRoot = Effect.fn("projects.managedWorktreesRoot")(function* () {
  const worktreesDirectory =
    process.env.PIDEX_WORKTREES_DIR ?? path.join(os.homedir(), ".pidex", "worktrees");
  yield* Effect.tryPromise({
    try: () => mkdir(worktreesDirectory, { recursive: true, mode: 0o700 }),
    catch: (cause) => applicationError("worktree.directory.create", cause),
  });
  return yield* Effect.tryPromise({
    try: () => realpath(worktreesDirectory),
    catch: (cause) => applicationError("worktree.directory.resolve", cause),
  });
});

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

function rollbackWorktree(repositoryRoot: string, worktreeRoot: string, branch: string) {
  return runGit(
    repositoryRoot,
    ["worktree", "remove", "--force", worktreeRoot],
    "worktree_rollback_failed",
    "Git could not roll back the worktree",
  ).pipe(
    Effect.andThen(
      runGit(
        repositoryRoot,
        ["branch", "-D", branch],
        "worktree_rollback_failed",
        "Git could not roll back the worktree",
      ).pipe(Effect.ignore),
    ),
    Effect.ignore,
  );
}
