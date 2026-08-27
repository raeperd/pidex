# Give paged tool output one owner

Loading a tool call's full output is one concept spread across six files. `AppShell` holds the
chunk-accumulation state machine, `AppShellContext` re-shapes the API's chunk type by hand,
`TaskTranscript` merges the accumulated text with the preview and renders three button labels, and
`ToolCall` — the component that actually draws the output — is denied the two fields that drive it.
The tell is one line: `hasDetails = $derived(detailsAvailable ?? Boolean(normalizedOutput))`. That
`??` exists only because the parent knows about paging and the child does not. Move the boundary
down so the component that renders tool output also owns fetching it.

The accumulation state machine has no test at any level today. Step 5 fixes that, and it is the part
of this refactor worth the most.

## Step 1 — Read the six sites

- `packages/api/src/index.ts:282-290` — `toolOutputChunkSchema`: `resourceId`, `offset`,
  `nextOffset`, `total`, `text`, `complete`, `sourceTruncated`
- `apps/web/src/routes/_components/AppShellApiClient.ts:116-122` — the request, with `limit: 16_384`
- `apps/web/src/routes/_components/AppShellContext.svelte.ts:12-20` — `TaskToolOutput`
- `apps/web/src/routes/_components/AppShell.svelte:174, 1334-1375` — `toolOutputs` and `loadToolOutput`
- `apps/web/src/routes/tasks/[taskId]/_components/TaskTranscript.svelte:159-190` — the `toolCall` snippet
- `apps/web/src/routes/tasks/[taskId]/_components/ToolCall.svelte:156-183, 282-297` — props and `hasDetails`

### Reference: what the chunk fields mean

The names collide in a way that has already caused one hand-written re-shape, so hold them apart:

| Field              | On the API chunk                             | On `TaskToolOutput`                                            |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| `text`             | **this chunk only**                          | **everything accumulated so far**                              |
| `nextOffset`       | where the next request starts                | same, carried through                                          |
| `total`            | total size on the host                       | same, but seeded from `item.outputSize` before the first fetch |
| `complete`         | no more chunks                               | same                                                           |
| `sourceTruncated`  | the host bounded the output at its own limit | same                                                           |
| `loading`, `error` | —                                            | UI-only, added by the shell                                    |

`AppShell.svelte:1338-1364` restates all six fields twice — once to enter the loading state, once to
apply the chunk.

**Done when:** you can say which `text` is which without looking.

## Step 2 — Move the paging state into the tool-call component

Give `ToolCall` the whole `ToolItem` plus one narrow port:

```ts
fetchChunk(resourceId: string, offset: number): Promise<ToolOutputChunk>
```

`ToolCall` then owns: the accumulated text, `loading`, `error`, `complete`, `nextOffset`, `total`,
`sourceTruncated`, and the "are there details" decision. It already computes the last one — deleting
`detailsAvailable` lets `hasDetails` become `Boolean(normalizedOutput) || Boolean(item.resourceId)`
with no escape hatch.

Keep the existing scalar props that are **not** paging: `startedAt`, `endedAt`, and `now` come from
`toolTimings`, a separate concern the shell legitimately owns.

Thread `fetchChunk` the same way `loadToolOutput` travels today — context to `TaskTranscript`
(`:89-101`), then down as a prop. That path already exists; only the state moves.

**Done when:** `grep -rn "detailsAvailable" apps/web` returns zero hits.

## Step 3 — Fold the load-more UI into the component

The 20-line `children` snippet in `TaskTranscript.svelte:172-187` moves inside `ToolCall`, which now
has the state it needs. Preserve the four rendered states exactly:

| Condition                             | Rendering                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `loading`                             | button label `Loading bounded chunk…`, `disabled`                          |
| accumulated text exists, not complete | `Load more · {nextOffset} / {total}` — both `toLocaleString()`             |
| nothing fetched yet                   | `Load complete output · {item.outputSize ?? 0} chars` — `toLocaleString()` |
| `complete`                            | no button                                                                  |

Plus the two notices: `sourceTruncated` renders "The host bounded this output at its safety limit.";
`error` renders the caught message, or "Tool output could not be loaded" when the cause is not an
`Error`.

The re-entrancy guard moves with them: `if (current?.loading || current?.complete) return`
(`AppShell.svelte:1337`) is what keeps rapid clicks from interleaving chunks out of order.

After this, `TaskTranscript`'s `toolCall` snippet is a plain `<ToolCall {item} … />` with no
`{@const}` merge and no children.

**Done when:** `grep -rn "Load complete output" apps/web` matches only `ToolCall.svelte`.

## Step 4 — Delete the shell's copy and rehome the limit

Remove `toolOutputs` (`AppShell.svelte:174`), `loadToolOutput` (`:1334-1375`), their two context
members (`:448-449`), and the `TaskToolOutput` interface (`AppShellContext.svelte.ts:12-20`).
`AppShell` keeps only a `fetchChunk` that binds the current `chatId` to the RPC call.

Move the `16_384` request limit from `AppShellApiClient.ts:121` to the component that now decides how
much to ask for. **Keep the value.** It is not arbitrary: the contract declares
`text: boundedString(16_384)` (`packages/api/src/index.ts:287`), so a larger limit would fail response
validation.

### The one behavioural change, and why to accept it

Today `toolOutputs` lives on the shell, so accumulated chunks survive navigating to another task and
back. Once the state lives in `ToolCall`, leaving the route discards it and reopening the task shows
the preview again until the user clicks.

Accept this. The output is re-fetchable, the cache is unbounded and never cleared today
(`grep -n "toolOutputs" AppShell.svelte` shows no reset), and preserving it would mean keeping the
shell-level record this refactor exists to delete. Say so in the commit message rather than leaving
it for someone to discover.

**Done when:** `grep -rn "TaskToolOutput\|loadToolOutput" apps/web` returns zero hits.

## Step 5 — Test the state machine

`ToolCall.test.ts` covers only the pure helpers today — `toolCallHeader`, `toolCallPreview`,
`toolCallExpanded`, `formatToolDuration`. Nothing covers accumulation, at any level: grepping
`e2e/` for `Load more`, `Load complete output`, or `sourceTruncated` returns nothing.

Add a component test that drives a stub `fetchChunk` through the full sequence and asserts the
rendered state after each step:

1. before any fetch — preview visible, button reads `Load complete output · …`
2. mid-fetch — button disabled, reads `Loading bounded chunk…`
3. first chunk applied, `complete: false` — text appended, button reads `Load more · {nextOffset} / {total}`
4. second chunk, `complete: true` — full text, no button
5. a chunk with `sourceTruncated: true` — the safety-limit notice renders
6. a rejected `fetchChunk` — the error notice renders and the button is enabled again
7. two clicks with a slow first chunk — the second is ignored, and text is appended once

Case 7 is the guard from Step 3; it is the one a future refactor is most likely to drop.

**Done when:** removing the `loading`/`complete` guard makes case 7 fail.

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

**Done when:** all five pass, with `ToolCall.test.ts` the only test file changed.

## Invariants

Visible behaviour is unchanged apart from the cache lifetime noted in Step 4:

- **The preview shows before any fetch.** `item.preview` is what `ToolCall` renders until a chunk
  arrives; the merge `state?.text || item.preview` becomes an internal fallback.
- **Button labels, disabled states, and number formatting** match the table in Step 3, including
  `toLocaleString()` on both counts.
- **The truncation notice text is unchanged**, and it still depends on the host's flag rather than
  on `complete`.
- **Chunks accumulate in request order**, never interleaved, under rapid clicking.
- **Expansion behaviour is untouched**: `toolCallExpanded` still auto-expands errors and honours a
  user override (`ToolCall.test.ts:90-107`).

Related: `docs/improvements/narrow-the-api-client-adapter.md` also touches
`AppShellApiClient.ts:116-122`. If both land, this one owns the move of the `16_384` constant.
