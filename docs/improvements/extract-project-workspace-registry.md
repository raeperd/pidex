# Name the project registry hiding inside AppShell

`AppShell.svelte` is 2,244 lines holding 14 `$state` declarations and roughly 75 functions. About
700 of those lines are one coherent thing that has no name and no boundary: the registry of
projects and their workspaces — loading them, caching them, ordering them, expanding them, and
keeping their task listings fresh. Because it has no name, answering "how does a project's status
dot get its colour" takes seven stops in this one file, and the code twice admits the missing
abstraction in comments rather than in code. Give it a name, a narrow surface, and — for the first
time — tests that are not Playwright.

## Step 1 — Justify the extraction before making it

`AGENTS.md` says one-use code stays local, and that pulling code into a new file _just_ to unit-test
it is a violation. This extraction is not that, and the reason matters enough to keep straight while
you work:

- It has its own concept — the set of known projects and their cached workspaces — with a lifecycle
  independent of any view.
- It removes a **seven-hop scatter** (Step 2) that no reader can hold in their head.
- It collapses an options bag whose six booleans exist only because there is no boundary to put the
  policy behind (Step 4).

Unit-testability is a consequence, not the justification. `AppShell.svelte` cannot be rendered by
vitest at all today: `:102` reads `window.pidexDesktop` and `:185` calls `makePidexApiClient()`,
which touches `localStorage` — both at component-script scope. That is why `packages/e2e/projects.spec.ts` is
680 lines doing unit-test work.

**Done when:** you can state the concept in one sentence without using the word "test".

## Step 2 — Trace the seven-hop rollup

This is the friction the refactor exists to remove. One concept, seven stops:

1. `rollupProjectStatus` (`:52-60`) — the `error > running > idle` priority table, private to the
   module block
2. `resolveTaskStatus` / `statusFromLiveRunStatus` (`:22-43`) — live snapshot beats the last
   server report, for the open task only
3. `knownSessionStatuses` (`:215-229`) — merges the active workspace into the cache inline, then
   maps every session through step 2
4. `faviconHref` (`:234-239`) — aggregates step 3 through step 1
5. `refreshSessions` (`:803-818`) — refetches one workspace's listing behind a per-workspace
   sequence guard
6. the 12-second polling `$effect` (`:829-841`) — re-runs step 5 while a non-open task still reads
   running
7. the `run_status` branch in `applyEvent` (`:1143-1148`) and the inline
   `{@const projectRollup = …}` in the sidebar template (`:1724-1734`)

Steps 5 and 6 both carry a comment naming the real fix: _"A workspace-level event stream would make
this unnecessary; that's out of scope here"_ (`:826-827`) and _"this is a cheap mitigation, not the
proper fix (a workspace-level event stream)"_ (`:1023-1024`). The same mitigation is pasted at two
call sites because there is nowhere to put it once.

**Done when:** you can point at all seven and say which two comments describe the same missing
module.

## Step 3 — Inventory what moves

Move into the registry:

| State                                                                                       | Line     |
| ------------------------------------------------------------------------------------------- | -------- |
| `bootstrap`, `workspace`, `workspaceCache`                                                  | 127-130  |
| `expandedProjectIds`, `taskLimits`                                                          | 131-132  |
| `projectLoading`, `projectLoadingId`                                                        | 151-152  |
| `projectBatchLoading`, `projectBatchProgress`                                               | 153-154  |
| `projectOrderSaving`                                                                        | 155      |
| `sessionRefreshSequence`, `pollingSessionList` (bare non-reactive locals declared mid-file) | 802, 819 |

Leave in `AppShell`: `draggedProjectId`, `projectDropTargetId`, `projectDropTargetEdge`
(`:156-158`). Those are pointer-gesture state belonging to the sidebar markup; only the _commit_ of a
reorder belongs to the registry.

Also move the three status functions from the module block (`:22-60`). They are pure, they are the
registry's own priority table, and they currently have zero unit coverage because they are private.

**Done when:** the list is confirmed against current code and you have decided, for each of the ~75
functions, whether it moves.

## Step 4 — Design the surface, and collapse the options bag

Create `packages/web/src/routes/_components/WorkspaceRegistry.svelte.ts`. It stays in this directory
because both the sidebar (`AppShell`) and route components consume it.

Target surface — narrow, and stated in terms of what a caller wants, not how it is done:

- `open(path, { navigate })` — load, cache, remember, expand, activate
- `refreshSessions(workspaceId?)`
- `reorder(sourceId, targetId, edge)`
- `addAll(paths)`
- `statusFor(taskId)` and a derived `rollupFor(projectId)`
- `expand(projectId)` / `collapse(projectId)` / `showMoreTasks(projectId)`
- derived `projects`, `visibleProjects`, `activeWorkspace`, `faviconStatus`

`openProject` today takes six independent booleans — `activate`, `closeDrawer`, `expand`,
`remember`, `reconcileHistory`, `navigate` (`:627-637`) — because one function serves five callers
with different needs. Most of those are not caller preferences at all: `remember` and `expand` follow
from _why_ the project is being opened, and `closeDrawer` is view concern that belongs to the
sidebar. Fold them into the registry as policy and keep only what a caller genuinely varies.

Sequencing note: `refreshSessions`'s per-workspace sequence guard (`:802-812`) exists because a
slower earlier response can otherwise overwrite a fresher later one — the comment at `:797-801`
explains it. It is implementation, not interface; it moves inside and stays invisible to callers.

**Done when:** no exported registry method takes more than two arguments, and no boolean flag
survives that the registry could decide itself.

## Step 5 — Migrate in checkpoints

Land this in slices that each keep `pnpm check` and `pnpm test:e2e` green. Suggested order, each a
safe stopping point:

1. Move the three status functions plus `rollupProjectStatus` into the new module and export them.
   Add unit tests. Nothing else changes.
2. Move `workspaceCache`, `workspaceFor`, and the derived `projects`/`visibleProjects`; `AppShell`
   reads them through the registry.
3. Move `refreshSessions`, its sequence guard, and the polling `$effect`.
4. Move `open`/`addAll`/`reorder` and collapse the options bag.
5. Move `expandedProjectIds` and `taskLimits`.

Checkpoints 1 and 3 are the highest value: 1 gets the priority table under test, 3 removes the
duplicated mitigation.

**Done when:** each checkpoint is a commit whose verification step passes.

### Svelte 5 gotcha

Runes work in `.svelte.ts` modules, but `$state` at module top level is shared across every importer.
Export a `createWorkspaceRegistry()` factory and instantiate it once in `AppShell`, matching the
pattern `createTaskViewControllerRegistry` already uses (`AppShellContext.svelte.ts`). Returning an
object of getters keeps reactivity across the module boundary; returning destructured values does
not.

## Step 6 — Replace Playwright coverage with unit tests

The registry is injectable at its boundary — it needs only an API client — so its tests can use a
stub client and no DOM. Cover at minimum:

- the rollup priority table, including `error` beating `running` beating `idle`
- `resolveTaskStatus` preferring the live snapshot for the open task and the server report otherwise
- the refresh sequence guard: a slow first response must not overwrite a fast second one
- reorder rollback when persistence fails
- expansion and task-limit state surviving a workspace refresh

Leave `packages/e2e/projects.spec.ts` in place for now. Trimming it is a separate decision, and shrinking the
safety net during the move is the wrong order.

**Done when:** each bullet has a test that fails when its behaviour is removed.

## Step 7 — Verify

Run from the repo root, in order:

```sh
pnpm format
pnpm check
pnpm test
pnpm test:e2e
pnpm deadcode
```

Run every command from the repo root: the vitest root config globs `packages/**/*.test.ts` against the
root, so `pnpm --filter <pkg> test` reports "No test files found".

**Done when:** all five pass, `grep -n "workspaceCache" packages/web/src/routes/_components/AppShell.svelte`
returns zero hits, and `AppShell.svelte` is meaningfully shorter than 2,244 lines.

## Invariants

Observable behaviour that must survive the move:

- **Favicon aggregation.** The favicon reflects every session in every cached project, not just the
  open task, through the same priority table the sidebar dots use (`:212-215` documents this).
- **Live status wins for the open task**, and only for it.
- **Polling cadence and its stop condition.** 12 seconds, only while the active workspace's listing
  shows a running task that is not the open one, guarded against overlapping requests, and it stops
  itself once the listing catches up.
- **Refresh ordering.** The departing workspace's refresh fires _last_, after this navigation's own
  cache writes — the comment at `:1018-1024` explains that firing it earlier let a stale write revert
  a fresher status.
- **Drag reorder is optimistic with rollback**, and every project control is disabled while
  `projectOrderSaving` is true.
- **Expansion state and per-project task limits** persist across refreshes and navigation.
- **Batch add reports progress** (`Adding N…`) and blocks the dialog from closing while running
  (`:2050`).
