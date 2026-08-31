# Stop restating the task snapshot three times

The state of one task is written out three times in three shapes. `AppShellContext` declares a
13-member `task` object; `AppShell` implements most of those as pass-through getters that return a
local of the same name; then `tasks/[taskId]/+page.svelte` re-explodes the context into 28 individual
props, eight of which are transcriptions of fields on the `ChatSnapshot` the context already carries;
and `TaskComposer` restates all 28 as a props type. That is roughly 230 lines of interface for one
snapshot plus a handful of pending flags — an interface as wide as its implementation. Pass the
snapshot through instead of transcribing it.

## Step 1 — Classify the 13 `task` members

Read `AppShellContext.svelte.ts:46-61` alongside the getters at `AppShell.svelte:387-477`, and sort
each member into one of three buckets. The verified starting point:

| Member                                                                                                                                           | Bucket                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                                                                                                                                       | the real thing                                                                                                                |
| `selectedModel`                                                                                                                                  | **derivable** — `$derived(snapshot?.model ?? "")` (`AppShell.svelte:284`)                                                     |
| `selectedThinkingLevel`                                                                                                                          | **derivable** — `$derived(snapshot?.thinkingLevel ?? "medium")` (`:285`)                                                      |
| `active`                                                                                                                                         | **derivable** — `$derived(Boolean(snapshot && snapshot.runStatus !== "idle" && snapshot.runStatus !== "error"))` (`:208-210`) |
| `startModeEditable`                                                                                                                              | derived from the snapshot _and_ local flags (`:286-292`) — keep, it is not a pure transcription                               |
| `compactPending`, `configurationPending`, `creatingTask`, `draft`, `loadingEarlier`, `startMode`, `toolElapsedNow`, `toolOutputs`, `toolTimings` | genuine shell state with no snapshot equivalent                                                                               |

**Done when:** each member is in a bucket and you can name the three that the composer can compute
for itself.

## Step 2 — Give `TaskComposer` the snapshot

Nine of its 28 props are computable from `context.task.snapshot`. Six are transcribed straight off it
at `tasks/[taskId]/+page.svelte:42-69` — `contextUsage`, `followUpCount` (`followUpQueue.length`),
`requiresAcknowledgement` (`Boolean(run?.requiresAcknowledgement)`), `runStatus`, `steeringCount`
(`steeringQueue.length`), and `taskId` — and three more are the derivable members from Step 1:
`active`, `selectedModel`, `selectedThinkingLevel`.

Replace all nine with a single `snapshot: ChatSnapshot` prop and compute them inside the component.
`+page.svelte` only renders `TaskComposer` when `context.task.snapshot` is defined
(`:41`), so the prop is non-optional — which also removes the `Boolean(…)` and `?? ""` defensiveness
at the call site.

Keep the comment on `taskId` (`TaskComposer.svelte:313`) — it explains that switching between two
already-active tasks restarts the elapsed clock — and move it to whatever now reads
`snapshot.taskId`.

**Done when:** `tasks/[taskId]/+page.svelte` passes at most 20 props to `TaskComposer`, and none of
them is a field access on `context.task.snapshot`.

### The reactivity gotcha

`context.task` is an object of getters, and `snapshot` in `AppShell` is `$state`. Reading
`context.task.snapshot` inside a `$derived` in `TaskComposer` keeps the dependency, because the getter
runs during the derivation. Destructuring it once into a plain `const` at component setup would not.

Verify this concretely rather than trusting it: with the refactor in place, stream a run and confirm
the queue counts and the run-status row update live. `packages/e2e/conversation.spec.ts` exercises exactly that
path.

## Step 3 — Group the actions

Seven props are functions that already travel together: `clearQueue`, `compact`, `configure`,
`persistDraft`, `send`, `setStartMode`, `stop`. They all come from `context.taskActions`, which
already exists as a coherent group.

Pass that group as one `actions` prop. Leave `taskActions` itself untouched — it is a genuine seam
of thirteen operations, not a restatement.

`draft` keeps its two-way binding (`bind:draft={() => context.task.draft, context.taskActions.setDraft}`)
and stays a separate prop.

**Done when:** `TaskComposer`'s props type has one `actions` member instead of seven function
members.

## Step 4 — Trim the context

With the composer deriving them, `active`, `selectedModel`, and `selectedThinkingLevel` leave
`AppShellContext.task` and their getters leave `AppShell`. Check for other consumers first —
`grep -rn "selectedModel\|context.task.active" packages/web` — because the projectless home screen has
its own staged configuration, and `AppShell`'s own markup may read `active` for the header row. Keep
the local `$derived`; only the context member goes.

Leave the rest of the context alone. `shell`, the remaining `task` members, `taskActions`, and
`projectActions` are all still consumed.

**Done when:** `grep -n "selectedThinkingLevel" packages/web/src/routes/_components/AppShellContext.svelte.ts`
returns zero hits.

## Step 5 — Migrate the composer tests

`TaskComposer.test.ts` is 456 lines. Its module-block tests (`runStatusLabel`, queue summaries,
duration formatting, `composerAffordances`) are unaffected — they call exported functions directly
and never touch props.

The rendering tests construct prop objects; they now construct a `ChatSnapshot` fixture instead. Add
one fixture factory with sensible defaults and per-test overrides, rather than a full snapshot literal
in each test.

**Done when:** every rendering test in `TaskComposer.test.ts` builds its snapshot through the shared
factory, and no test constructs `runStatus`, `followUpCount`, or `steeringCount` as standalone props.

## Step 6 — Verify

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

**Done when:** all five pass.

## Invariants

- **Reactivity survives.** The composer re-renders when the snapshot mutates: queue counts, run
  status, context usage, and acknowledgement state all track live updates. See the gotcha in Step 2.
- **`taskActions` is unchanged** — same thirteen operations, same signatures.
- **`TaskViewControllerRegistry` is untouched.** Its deferred-attach race guard is real behaviour
  tested in `AppShellContext.test.ts`; this refactor does not go near it.
- **Draft binding still round-trips** through `setDraft`, and drafts still persist per task.
- **The projectless home screen is unaffected** — it imports module-block exports from
  `TaskComposer.svelte` (`routes/+page.svelte:16`) but never renders the component.

Related: `docs/archive/future-cleanups/single-source-composer-enablement.md` reworks `composerAffordances` in the
same file. It takes a plain input record, so the two compose in either order.
