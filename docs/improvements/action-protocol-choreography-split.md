# Give the action protocol one owner

Every mutating endpoint runs the same three beats — accept the action durably, perform the effect,
record the outcome — but the beats live in three modules and none of them owns the protocol. The
at-most-once guarantee that holds it together is spelled out four extra times: `chat.revision =
Math.max(…)` followed by `if (outcome.replayed) return` appears in `startPrompt`, `deliverDuringRun`,
`abort`, and inside `settleAction` itself. A comment at `chat-manager.ts:520` names the concept
("Shared action protocol") without any module implementing it.

Scope this honestly before starting: **the guards do not move.** Each action's precondition
(`session_busy`, `run_mismatch`, `interrupted_run`) is enforced inside a SQLite transaction in
`metadata.ts`, which is where it belongs — a guard checked outside the transaction is a race. This
refactor concentrates the _replay and revision_ half and leaves the transactional half alone. That is
why it is rated moderate rather than strong: some complexity stays where it is, by design.

## Step 1 — Read the verified action inventory

Nine action kinds exist (`metadata.ts:620-631` lists ten literals; `steer` and `follow-up` share one
accept function). Five already route through the shared `performMutation` wrapper; four do not, and
those four are the duplication.

| Kind                 | Accept function                    | Guard it enforces                                                      | Effect                           | Handler               |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------- | --------------------- |
| `prompt`             | `acceptPrompt` (`metadata.ts:238`) | `interrupted_run` if unacknowledged, `session_busy` if a run is active | `manager.startPrompt`            | `http-api.ts:188-189` |
| `steer`, `follow-up` | `acceptRunMutation` (`:281`)       | `run_mismatch` unless the run matches and is active                    | `manager.deliverDuringRun`       | `http-api.ts:202-203` |
| `stop`               | `acceptStop` (`:263`)              | `run_mismatch` unless the run matches and is active                    | `manager.abort`                  | `http-api.ts:207-211` |
| `acknowledge`        | `acknowledgeInterrupted` (`:307`)  | `run_mismatch` unless an interrupted run awaits acknowledgement        | `manager.acknowledgeInterrupted` | `http-api.ts:215-218` |
| `clear-queue`        | `acceptSessionMutation` (`:320`)   | generic session guard                                                  | `manager.clear`                  | `http-api.ts:231-235` |
| `config`             | `acceptSessionMutation`            | generic                                                                | `manager.configure`              | `http-api.ts:255-259` |
| `rename`             | `acceptSessionMutation`            | generic                                                                | `manager.rename`                 | `http-api.ts:264-268` |
| `compact`            | `acceptSessionMutation`            | generic                                                                | `manager.compact`                | `http-api.ts:274-278` |
| `dialog`             | `acceptSessionMutation`            | generic, plus `validateDialogResponse` first                           | `chat.session.respondToDialog`   | `http-api.ts:286-291` |

**Done when:** you can point at the four rows that bypass `performMutation` and say what each does
instead.

## Step 2 — Extract the two beats every path shares

Both duplicated lines express one rule: _an action's revision always advances, and a replayed action
performs no effect._ Put them in one function in `chat-manager.ts`, above its callers:

```ts
/** Advances the chat to the action's revision. Returns false when the action was already applied. */
function beginAction(chat: ChatRecord, outcome: ActionOutcome): boolean {
  chat.revision = Math.max(chat.revision, outcome.revision);
  return !outcome.replayed;
}
```

Route all five current sites through it: `startPrompt` (`:439-441`), `deliverDuringRun` (`:479-481`),
`abort` (`:489-490`), `performMutation`'s broadcast tap (`:515`), and `settleAction` (`:527-528`).

Keep `settleAction`'s completion recording where it is. It calls
`markActionStatus(outcome.actionId, "completed" | "failed")`, which suits the eight synchronous
actions but not `prompt`: a prompt's durable status is driven by the run lifecycle through
`markPromptStatus`, not by the handler returning. Forcing `prompt` through `settleAction` would record
a completion the moment the run is _forked_.

**Done when:** `grep -n "outcome.replayed" packages/server/src/chat-manager.ts` returns exactly one hit,
and `grep -n "Math.max(chat.revision" packages/server/src/chat-manager.ts` returns exactly one hit.

## Step 3 — Derive the action-kind list

`actionKinds` (`metadata.ts:620-631`) is a hand-maintained list of ten literals that must stay in sync
with the `kind:` strings at the six `acceptSessionMutation` call sites and the four dedicated accept
functions. Nothing checks the two agree.

Narrow the `kind` parameter of `acceptSessionMutation` to the five kinds it legitimately accepts —
it already does this (`metadata.ts:320-321`) — and make `ActionKind` the union derived from the accept
functions' parameter types rather than a parallel list, so a new kind cannot be added to one without
the other.

**Done when:** adding a `kind` string that no accept function declares fails `pnpm check`.

## Step 4 — Test the replay short-circuit end to end

`metadata.test.ts:285-328` proves replay detection _at the store level_: a repeated `acceptPrompt`
returns `{ replayed: true, revision: 1 }`, and the same holds for `acceptRunMutation` and
`acceptStop`. Nothing proves the half that matters to a client: **a replayed action must perform no
side effect.**

Add that test at the `http-api.test.ts` level, where the existing action tests live and where the
real server, real SQLite, and real chat manager are already wired. Send the same mutating request
twice with the same `actionId` and `expectedRevision`, then assert the effect happened once —
`rename` is the easiest to observe, since the second call must return the recorded outcome without
re-broadcasting a session event.

**Done when:** a test fails if `beginAction`'s early return is removed.

## Step 5 — Verify

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

**Done when:** all five pass, with the only test addition being Step 4's.

## Invariants

The wire behaviour is unchanged:

- **Same rejection codes, from the same guards.** `stale_revision`, `run_mismatch`, `session_busy`,
  `interrupted_run`, and `action_conflict` are still raised inside `metadata`'s transactions.
  `http-api.test.ts`'s `expectRpcError` assertions cover them and must pass untouched.
- **At-most-once semantics.** An action is identified by its `actionId`; `recordAction`
  (`metadata.ts:322`) checks the revision and detects the replay in one immediate transaction. Neither
  the key nor the ordering changes.
- **Broadcast timing.** `performMutation` still broadcasts run state after a successful non-replayed
  action and after a failed one, and still suppresses the broadcast on replay (`:515`).
- **Prompt actions keep their separate status path** via `markPromptStatus`, not `markActionStatus`.

Related: `docs/improvements/http-error-status-double-table.md` also edits `http-api.ts`, but only its
error middleware and throw sites — the scopes are disjoint. If both land,
`docs/improvements/run-status-vocabulary-scatter.md` is the one that formalises the prompt-status path
this document leaves alone.
