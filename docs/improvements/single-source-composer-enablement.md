# Make the composer's blocking rule decide, not just narrate

`composerAffordances` carries a 32-line doc comment and sixteen tests defining a strict priority
order for _why_ the composer is blocked — and it produces only strings. The predicate that actually
blocks submission is re-derived in five places with five different term sets. One of them,
`AppShell.send()`, is the action layer, and it silently omits four of the seven conditions. Nothing
exploits that today because the view disables the button first, but the documented invariant is
enforced by the view rather than by the operation. Have the priority table return the decision, and
let both the binding and the guard consume it.

## Step 1 — Confirm the five sites and what each one checks

Every row is verified against current code. The table is the checklist for Step 3: no term may be
dropped.

| Site                                                   | draft | models | connection | ack   | creatingTask | configPending | compactPending | active | submitting |
| ------------------------------------------------------ | ----- | ------ | ---------- | ----- | ------------ | ------------- | -------------- | ------ | ---------- |
| `TaskComposer.svelte:320-328` `idleSubmissionDisabled` | ✓     | ✓      | ✓          | ✓     | ✓            | ✓             | ✓              |        |            |
| `TaskComposer.svelte:611-615` `modelDisabled`          |       | ✓      | ✓          |       | ✓            | ✓             |                | ✓      |            |
| `TaskComposer.svelte:616-619` `thinkingDisabled`       |       |        | ✓          |       | ✓            | ✓             |                | ✓      |            |
| `TaskComposer.svelte:404` `updateConfiguration`        |       |        | ✓          |       | ✓            | ✓             |                | ✓      |            |
| `AppShell.svelte:1190-1191` `send()`                   | ✓     | **✗**  | ✓          | **✗** | **✗**        | ✓             | **✗**          | ✓      |            |
| `+page.svelte:167-169` starter                         | ✓     | ✓      |            |       |              |               |                |        | ✓          |

The four ✗ marks are the latent defect: `send()` does not check `models.length`,
`requiresAcknowledgement`, `creatingTask`, or `compactPending`. Reaching it today requires the send
button (`:638`, bound to `idleSubmissionDisabled`) or the Enter handler (`:451`, which re-checks the
same value), so both entry points happen to filter first. A third — a keyboard shortcut, a retry, a
URL-driven submit — would not.

The starter row is deliberately different: the projectless home screen has no chat yet, so
`active`, `requiresAcknowledgement`, and the pending flags cannot exist. It stays separate; Step 4
covers it.

**Done when:** you have re-derived this table from the current code and corrected any drift.

## Step 2 — Return the decision alongside the labels

`composerAffordances` (`TaskComposer.svelte:154-175`) already receives every term it needs and
already computes the priority order via `composerBlockedReason` (`:177-202`). Widen its result:

```ts
{
  placeholder: string;
  sendLabel: string;
  blocked: boolean;
}
```

`blocked` is `true` when the connection is not `connected` or when `composerBlockedReason` returns a
reason — the two branches that already exist. Note it is **independent of `active`**: the doc comment
at `:145-152` is explicit that `reason` is evaluated regardless of `active`, because the stop button
has its own rule.

Leave the two string outputs and their priority order exactly as they are. Sixteen tests
(`TaskComposer.test.ts:78-199`) pin them, including six that assert the ordering pairwise and one
that asserts the stop button keeps the plain label "Stop".

Keep the input a plain record. A sibling refactor,
`docs/improvements/collapse-task-state-triple-restatement.md`, changes how `TaskComposer` receives
this state; a plain-record parameter works before and after.

**Done when:** all sixteen affordance tests pass against the widened return type, unmodified except
for the added `blocked` assertion in each.

## Step 3 — Consume the decision at all five sites

- `idleSubmissionDisabled` becomes `affordances.blocked || !draft.trim()`. The empty-draft check
  stays outside on purpose: an empty draft is not a _reason_, which is why the doc comment
  (`:150-152`) explains it gets no special-cased message.
- `modelDisabled`, `thinkingDisabled`, and `updateConfiguration` share a narrower rule — they gate
  configuration, not submission, and they include `active` while excluding `requiresAcknowledgement`
  and `compactPending`. Give the same function a second derived value for them rather than a fourth
  hand-written conjunction. Keep `modelDisabled`'s extra `!models.length` term.
- `AppShell.send()` guards on the shared decision. This is the behavioural change; Step 4 covers how
  it gets there.

**Done when:** no `$derived` or early return in `TaskComposer.svelte` or `AppShell.svelte` restates a
conjunction of these terms.

## Step 4 — Get the decision to the action layer

`send()` lives in `AppShell.svelte`; the decision lives in `TaskComposer`'s module block. Export it
from there and import it in `AppShell` — the module block is already the tested home, and
`AppShell.svelte:80-83` already imports across this boundary.

`AppShell` holds every term `send()` needs as local state, so it can call the function directly
rather than routing a computed value through context. That keeps the guard honest: it re-evaluates at
call time instead of trusting a value the view rendered earlier.

Add the regression tests the four ✗ marks deserve — one per omitted term, asserting `send()` performs
no RPC when that term blocks. These are the only genuinely new tests in this refactor.

**Done when:** a test fails if `requiresAcknowledgement` is removed from the shared decision, and
another fails for each of `compactPending`, `creatingTask`, and `models.length`.

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

**Done when:** all five pass, with `TaskComposer.test.ts` changed only by the added `blocked`
assertions and the four new `send()` guard tests.

## Invariants

Visible behaviour is unchanged. The one behavioural change is enforcement, not appearance:

- **Identical placeholders and button labels**, in the identical priority order:
  connection → `requiresAcknowledgement` → no models → `creatingTask` → `configurationPending` →
  `compactPending` → active/idle default.
- **The stop button keeps the label "Stop"** while a run is active and connected, never borrowing a
  disabled-reason string (`TaskComposer.test.ts:193`).
- **A pending compaction still explains itself through the placeholder while a run is active**
  (`:186`).
- **The stop button is disabled only by a lost connection** (`TaskComposer.svelte:630`) — the shared
  decision must not start disabling it for other reasons.
- **An empty draft still disables send with no explanatory message.**
- **The starter path keeps its own three-term rule.** Its terms cannot occur on the home screen.
- **New:** `send()` now refuses when acknowledgement is required, a compaction is pending, the task
  is still being created, or no models exist. No user-visible path reaches those states today with
  the button enabled, so no UI changes — the guard closes a hole rather than altering a flow.
