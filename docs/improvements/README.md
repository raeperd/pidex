# Architecture improvements

Each file is a self-contained refactor plan written for an agent to execute: ordered steps, each
ending on a checkable completion criterion, plus an invariants section naming the behaviour that must
survive. Reach for one when its friction is the thing blocking you; they are independent unless a
"Related" line says otherwise.

Line references were last verified against an earlier tree. Re-check them before editing. The
current branch keeps only plans that still describe unfinished work. Optional future-only cleanups
are in `../archive/future-cleanups/`.

## Server

| Doc                                                                         | Friction it removes                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [run-status-vocabulary-scatter](run-status-vocabulary-scatter.md)           | Four run-state vocabularies translated at eight sites; `"stopping"` is persisted-and-rejected but never written |
| [action-protocol-choreography-split](action-protocol-choreography-split.md) | The replay/revision guard restated at five sites; a replayed action's side-effect suppression is untested       |

## Web

| Doc                                                                                 | Friction it removes                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [extract-project-workspace-registry](extract-project-workspace-registry.md)         | ~700 lines of unnamed project registry inside a 2,244-line component; one concept, seven hops |
| [collapse-task-state-triple-restatement](collapse-task-state-triple-restatement.md) | One `ChatSnapshot` restated as 13 context members, ~90 getters, and 28 props                  |

## Suggested order

Start with **run-status-vocabulary-scatter** or **action-protocol-choreography-split** because both
clarify server correctness. Follow with **collapse-task-state-triple-restatement** and
**extract-project-workspace-registry** when the web state boundary is the main source of friction.

The smaller concerns that were removed from this active index are retained in
`../archive/future-cleanups/` if they become worth implementing.

## Verification

Every doc ends on the same gate, run from the repo root:

```sh
pnpm format && pnpm check && pnpm test && pnpm test:e2e && pnpm deadcode
```

Run from the root: the vitest root config globs `packages/**/*.test.ts`, so `pnpm --filter <pkg> test`
reports "No test files found".
