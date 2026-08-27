# Give the run lifecycle one owning module

"What state is this run in" is answered by four vocabularies — the live `runStatus` on a chat, the
durable `ActionStatus` on an action row, the `run_status` column's type, and the sidebar's
`SessionStatus` — translated at eight sites across `chat-manager.ts` and `metadata.ts`. No file states
the state machine, so its rules survive as convention. One rule has already rotted: `"stopping"` is a
value the persistence layer stores, filters, and fatally rejects, but that **no version of this server
has ever written to disk**. Move the enums, the legal transitions, and the two sidebar projections
into one module, and the convention becomes a checkable property.

## Step 1 — Read the four vocabularies and the eight translation sites

| Vocabulary             | Values                                                              | Declared at                       |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------- |
| live `runStatus`       | `idle` `running` `stopping` `compacting` `error`                    | `packages/api/src/index.ts:10`    |
| durable `ActionStatus` | `accepted` `running` `completed` `cancelled` `failed` `interrupted` | `packages/api/src/index.ts:11-18` |
| `PersistedRunStatus`   | `ActionStatus                                                       | "stopping"`                       | `apps/server/src/metadata.ts:618`, column schema at `:686` |
| `SessionStatus`        | `running` `error` `idle`                                            | `packages/api/src/index.ts:39`    |

The translation sites, which Step 3 consolidates:

- `chat-manager.ts:452-453` — prompt started: live `running` + durable `running`
- `chat-manager.ts:461-463` — prompt failed: live `error` + durable `failed`
- `chat-manager.ts:358-364` — run settled: live `idle` + durable `completed` or `cancelled`
- `chat-manager.ts:496` — stop requested: live `stopping`, no durable write
- `chat-manager.ts:557, 565` — compact start/end: live `compacting` then `idle`, no durable write
- `chat-manager.ts:201` — attach: persisted `accepted|running` becomes live `running`
- `chat-manager.ts:634-648` — `resolveSessionStatus`: live + persisted projected to the sidebar
- `metadata.ts:62-78` — crash recovery: `accepted|running` becomes `interrupted` +
  `requiresAcknowledgement`

**Done when:** you can name, for each of the first five sites, which of the two writes is live-only
and which is durable.

## Step 2 — Delete the `"stopping"` persistence handling

`"stopping"` is set on `chat.runStatus` at `chat-manager.ts:496` and nowhere else. The stop action's
own durable write is `runStatus: "running"` (`metadata.ts:276`), so the value never reaches SQLite.

Confirm this before deleting, then delete. The confirmation is one command, and it covers every
revision including the pre-Drizzle raw-SQL era:

```sh
git log --all --oneline -S'runStatus: "stopping"'
```

It returns nothing: no commit has ever written the value. That is what makes the five sites below
safe to remove rather than migrate.

- `metadata.ts:74` — drop `"stopping"` from the recovery `WHERE … IN` list
- `metadata.ts:396` — drop it from `markPromptStatus`'s guard list
- `metadata.ts:429-430` — delete the `throw new Error("… retained an unrecovered stopping state")`
- `metadata.ts:618` — `type PersistedRunStatus = ActionStatus`
- `metadata.ts:686` — column schema becomes `Schema.NullOr(Schema.Literals([...actionStatuses]))`

**Done when:** `grep -n "stopping" apps/server/src/metadata.ts` returns zero hits, and
`PersistedRunStatus` is an alias of `ActionStatus` — at which point deleting the alias entirely is
also reasonable.

## Step 3 — Add `run-state.ts` and name the transitions

Create `apps/server/src/run-state.ts` holding, in this order (callers before callees, per
`AGENTS.md`):

1. `LiveRunStatus` and `DurableRunStatus` type aliases over the API schemas.
2. A transition table — one entry per row of Step 1's first five bullets — where each entry carries
   the live status and, **only when the transition is durable**, the status to record:

   ```ts
   const runTransitions = {
     promptStarted: { live: "running", durable: "running" },
     promptFailed: { live: "error", durable: "failed" },
     runCompleted: { live: "idle", durable: "completed" },
     runCancelled: { live: "idle", durable: "cancelled" },
     stopRequested: { live: "stopping" },
     compactStarted: { live: "compacting" },
     compactEnded: { live: "idle" },
   } as const;
   ```

   The absent `durable` key is the whole point: it is where "a stop is live-only and never reaches
   disk" stops being a convention defended by a throw in another module and becomes a fact you can
   read.

3. `resolveSessionStatus`, moved verbatim from `chat-manager.ts:634-648` with its doc comment. It is
   the live-plus-persisted projection to the sidebar and belongs beside the enums it projects.
   `chat-manager.test.ts:3` imports it; update that import.

Then give `chat-manager` one effect that applies a transition: set `chat.runStatus`, and call
`metadata.markPromptStatus` when the entry has a `durable` status. Replace the seven paired
assignments with calls to it.

**Keep `broadcastRun` at the call sites.** Its position varies — `compact` broadcasts from inside
`Effect.ensuring` (`:562-566`) while `startPrompt` broadcasts after persisting (`:454`) — and moving
it into the transition helper would reorder WebSocket events.

**Done when:** `grep -n "chat.runStatus = " apps/server/src/chat-manager.ts` returns zero hits, and
every `markPromptStatus` call site is either the transition helper or crash recovery.

## Step 4 — Resolve the attach branch

`chat-manager.ts:186-187, 201` maps a persisted `accepted|running` run to a live `running`, while
crash recovery rewrites exactly those statuses to `interrupted` when the database opens
(`metadata.ts:62-78`). Recovery runs first and normalizes the rows, and a session with a live run in
this process short-circuits earlier at the `owners.get(sessionKey)` check (`:181`) — so establish
whether `runIsActive` can ever be true.

Do this by adding a test rather than by reasoning: open metadata, start a prompt, attach a second
chat for the same session key, and assert the resulting `runStatus`. Then either keep the branch with
a comment naming the reachable case, or delete it.

**Done when:** a test in `chat-manager.test.ts` or `http-api.test.ts` pins the attach behaviour, and
the branch is either exercised by it or gone.

## Step 5 — Verify

Run from the repo root, in order:

```sh
pnpm format
pnpm check
pnpm test
pnpm test:e2e
pnpm deadcode
```

Run every command from the repo root: the vitest root config globs `apps/**/*.test.ts` against the
root, so `pnpm --filter <pkg> test` reports "No test files found".

**Done when:** all five pass, with the only test edits being the `resolveSessionStatus` import path
and the new attach test.

## Invariants

Observable behaviour that must survive:

- **Crash-recovery acknowledgement flow.** Opening the database still rewrites in-flight prompt
  actions and session rows to `interrupted` with `requiresAcknowledgement: true`, and
  `acceptPrompt` still rejects new work with `interrupted_run` until acknowledged
  (`metadata.ts:240-245`). The comment at `metadata.ts:60-61` explains why the ambiguity is
  preserved — carry it over.
- **Sidebar status semantics.** `resolveSessionStatus` keeps its exact precedence: a live chat wins
  over persisted state; `stopping` and `compacting` read as `running`; with no live chat, only a
  persisted `failed` or an unacknowledged `interrupted` reads as `error`.
  `chat-manager.test.ts:15` asserts the `stopping → running` mapping, which is why `"stopping"`
  stays a _live_ status even as its persisted twin is deleted.
- **WebSocket payloads and ordering.** `broadcastRun` and `broadcastSession` fire at the same points,
  in the same order, carrying the same `runStatus` values. `runStatusSchema` in `packages/api` is
  unchanged — the web client keeps rendering `stopping` (`TaskComposer.svelte:208`,
  `TaskComposer.test.ts:20-21`).
- **`markPromptStatus` remains guarded** by the run id and an active-status list, so a settle for a
  superseded run still updates nothing.
