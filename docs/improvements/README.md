# Architecture improvements

Each file is a self-contained refactor plan written for an agent to execute: ordered steps, each
ending on a checkable completion criterion, plus an invariants section naming the behaviour that must
survive. Reach for one when its friction is the thing blocking you; they are independent unless a
"Related" line says otherwise.

Line references were verified against the tree at commit `9d2d37f`. Re-check them before editing —
every doc says so, and `AppShell.svelte` in particular moves.

## Server

| Doc                                                                         | Friction it removes                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [run-status-vocabulary-scatter](run-status-vocabulary-scatter.md)           | Four run-state vocabularies translated at eight sites; `"stopping"` is persisted-and-rejected but never written |
| [pi-session-triple-interface](pi-session-triple-interface.md)               | One Pi session described by three hand-written surfaces plus a 28-line mechanical mapper                        |
| [http-error-status-double-table](http-error-status-double-table.md)         | Each API error's HTTP status declared at the throw site and again in the handler's status map                   |
| [action-protocol-choreography-split](action-protocol-choreography-split.md) | The replay/revision guard restated at five sites; a replayed action's side-effect suppression is untested       |

## Web

| Doc                                                                                 | Friction it removes                                                                                                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [extract-project-workspace-registry](extract-project-workspace-registry.md)         | ~700 lines of unnamed project registry inside a 2,244-line component; one concept, seven hops                                       |
| [collapse-task-state-triple-restatement](collapse-task-state-triple-restatement.md) | One `ChatSnapshot` restated as 13 context members, ~90 getters, and 28 props                                                        |
| [single-source-composer-enablement](single-source-composer-enablement.md)           | A tested priority table that only produces labels, while five sites re-derive the predicate — and the action layer omits four terms |
| [transcript-follow-ownership-inversion](transcript-follow-ownership-inversion.md)   | Autoscroll pushed from four data-layer sites instead of owned by the transcript                                                     |
| [tool-output-paging-split](tool-output-paging-split.md)                             | Paged tool output spread across six files, with an untested accumulation state machine                                              |
| [narrow-the-api-client-adapter](narrow-the-api-client-adapter.md)                   | Ten pass-through methods presenting a transport layer that does not exist                                                           |
| [copy-affordance-at-wrong-altitude](copy-affordance-at-wrong-altitude.md)           | Copy-button markup pasted three times, already drifted three ways                                                                   |

## Suggested order

Start with **copy-affordance** or **narrow-the-api-client-adapter** — both are mechanical, and they
confirm the verification loop works before anything risky.

Then **run-status-vocabulary-scatter** (deletes dead code and makes a cross-module invariant local)
or the pair **collapse-task-state-triple-restatement** + **single-source-composer-enablement**, which
share files and compound.

**extract-project-workspace-registry** is the largest and lands in seven checkpoints; it is worth
doing after at least one web refactor above has settled.

## Verification

Every doc ends on the same gate, run from the repo root:

```sh
pnpm format && pnpm check && pnpm test && pnpm test:e2e && pnpm deadcode
```

Run from the root: the vitest root config globs `packages/**/*.test.ts`, so `pnpm --filter <pkg> test`
reports "No test files found".
