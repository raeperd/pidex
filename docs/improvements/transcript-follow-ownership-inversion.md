# Let the transcript own whether it is following

Autoscroll is pushed from the data layer. Four sites in `AppShell.svelte` must remember to poke the
transcript after mutating a snapshot, and two of them overlap: the streaming-delta flush schedules a
scroll inside its own animation frame, and `applyEvent` calls the same method again unconditionally
for every event. A fifth mutation site added tomorrow would silently stop scrolling, with no type and
no test to catch it. Invert to pull: the transcript observes its own content and decides.

## Step 1 — Read the push path end to end

- `AppShell.svelte:997` — `scrollLatest()` after `await tick()` when a task route activates
- `AppShell.svelte:1056` — `scrollLatest()` in `afterChat`
- `AppShell.svelte:1094` — `scrollIfNearBottom()` inside the rAF that flushes pending text deltas
- `AppShell.svelte:1171` — `scrollIfNearBottom()` at the tail of `applyEvent`, for every event
- `AppShellContext.svelte.ts:32-35, 114, 125-126` — `TaskTranscriptController` and the registry's
  two forwarding methods
- `tasks/[taskId]/+page.svelte:14-17, 24-27, 32` — the `bind:this` getter/setter pair, carrying a
  comment that exists only to explain the workaround
- `TaskTranscript.svelte:106-156` — `nearBottom`, `following`, `scrollLatest`,
  `scrollIfNearBottom`, `jumpToLatest`, `onScroll`

**Done when:** you can name which two of the four poke sites are redundant with each other.

## Step 2 — Keep two facts, but derive one of them

`nearBottom` and `following` look like duplicates — same 96px threshold, both start `true` — and the
obvious move is to collapse them into one boolean. **That would change behaviour.** They diverge on a
real case:

> The user wheels up a few pixels while still within 96px of the bottom. `following` goes false
> immediately (upward wheel detaches by direction, `TaskTranscript.svelte:67`), but `nearBottom` stays
> true because the resulting position is still inside the threshold. Autoscroll detaches; the "Jump to
> latest" button stays hidden.

That asymmetry is deliberate: autoscroll yields to any upward gesture, while the chrome only appears
once you are genuinely away from the bottom.

Preserve it by making the two facts share one source instead of merging them:

- store the scroll `position` (`scrollTop`, `scrollHeight`, `clientHeight`) as state, updated on
  scroll events
- derive `nearBottom = isNearBottom(position)` — it stops being independently assigned
- keep `following` as the only stored boolean, still driven by `resolveFollowing`

This deletes the `if (kind === "scroll") nearBottom = …` line (`:154`) — the untested glue where the
two rules can disagree — without touching either rule.

**Done when:** `nearBottom` is a `$derived`, and the ten `resolveFollowing` tests
(`TaskTranscript.test.ts:135-177`) pass unchanged.

## Step 3 — Observe content growth instead of being told about it

Give the transcript a `ResizeObserver` on the **inner content element** (not the scroll container,
whose size is fixed by layout) plus an `$effect` on `items`. When content grows and `following` is
true, scroll to the bottom.

A `ResizeObserver` covers both ways the transcript grows: new items appended, and an existing item's
text growing during streaming. Its callback runs after layout and before paint, so scrolling from it
does not flash.

### The gotcha that will break this if you miss it

`prependEarlierMessages` (`TaskTranscript.svelte:125-133`) grows `scrollHeight` from the **top** and
then deliberately restores the visual position:

```js
transcript.scrollTop = previousScrollTop + transcript.scrollHeight - previousScrollHeight;
```

A naive observer sees that growth and, if `following` is true, yanks the user to the bottom — the
exact opposite of what loading earlier messages should do. Today this cannot happen because nothing
pokes the transcript on `loadEarlier`.

Suppress the observer for the duration of the prepend, and re-enable it after the `tick()` that
restores `scrollTop`. Verify by loading earlier messages while pinned to the bottom: the viewport must
stay where it was.

**Done when:** loading earlier messages leaves the scroll position visually unchanged, whether or not
`following` is true.

## Step 4 — Handle route entry on the pull side

`AppShell.svelte:997` scrolls instantly when a task opens — no smooth animation, no threshold check —
and `:1056` repeats it after `afterChat`. Replace both with an initial-mount scroll inside the
transcript: on first render with items present, jump to the bottom and set `following` true.

`jumpToLatest` (`:135-143`) keeps its smooth behaviour and its `prefers-reduced-motion` check; that
is the user-initiated path and is unrelated.

**Done when:** opening a task with a long transcript lands at the bottom with no visible animation.

## Step 5 — Delete the push plumbing

Remove, in this order:

1. the four calls at `AppShell.svelte:997, 1056, 1094, 1171` — `resizeComposer` and `focusComposer`
   on the neighbouring lines stay
2. `scrollIfNearBottom` and `scrollLatest` from `TaskTranscript`'s exports
3. `scrollIfNearBottom`/`scrollLatest` from the registry (`AppShellContext.svelte.ts:125-126`) and
   from both interfaces (`:33-34, 90-91`)
4. `TaskTranscriptController` (`:32-35`), `attachTranscript` (`:65, 86, 114`), and
   `context.taskActions.attachTranscript` (`AppShell.svelte:457`)
5. `transcriptController`, `attachTranscript`, and the `bind:this` on `TaskTranscript` in
   `+page.svelte` — along with the comment at `:14-15`, which describes a workaround that no longer
   exists

**Keep the registry.** Its composer half is not ceremony: `focusComposer` has a genuine
deferred-attach race guard, tested in `AppShellContext.test.ts`, and `resizeComposer` has seven call
sites. Only the transcript half goes.

**Done when:** `grep -rn "scrollIfNearBottom\|scrollLatest\|TaskTranscriptController\|attachTranscript" apps/web`
returns zero hits.

## Step 6 — Verify

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

Automated coverage is thin here — `e2e/conversation.spec.ts` streams deltas and asserts rendered
content but never asserts scroll position, and `TaskTranscript.test.ts:113` only checks that the
container renders without `scroll-smooth`. So verify the invariants below by hand in a browser
before calling this done, and add the missing assertion in Step 7.

**Done when:** all five pass and every invariant below has been exercised manually.

## Step 7 — Add the assertion the suite is missing

Extend `e2e/conversation.spec.ts` around its existing delta-streaming section: emit enough content to
overflow the viewport, assert the container is scrolled to the bottom, scroll up, emit more, and
assert the position held. That is the regression this whole refactor is about, and nothing currently
covers it.

**Done when:** reverting Step 3's observer makes the new e2e assertion fail.

## Invariants

- **Pinned during streaming.** With the transcript at the bottom, streamed deltas keep it at the
  bottom, in animation-frame batches, with no visible stutter.
- **Detach on upward gesture.** An upward wheel detaches by direction alone, even when the pre-scroll
  position still reads as at-the-bottom — the reason is documented at `TaskTranscript.svelte:64-66`
  and asserted by `TaskTranscript.test.ts:140`.
- **Re-attach at the threshold.** Scrolling back to within 96px re-attaches; exactly 96px stays
  detached. Six tests pin the boundary (`TaskTranscript.test.ts:158-177`).
- **Programmatic scrolls never detach** while following (`:154`).
- **"Jump to latest" appears at the same threshold** as today and scrolls smoothly, honouring
  `prefers-reduced-motion`.
- **Task open scrolls instantly**, not smoothly.
- **Loading earlier messages preserves the viewport** — see Step 3.
