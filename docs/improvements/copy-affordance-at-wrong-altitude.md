# Consolidate the copy affordance into one component

The transcript has three copy buttons — user message, agent response, code block. The 23-line
`createCopyState` helper is shared; the markup around it is not. Button, tooltip, icon swap, and
both aria strings are pasted at all three sites, and have already drifted three ways. The aria
strings are e2e selectors, so drift is pinned by tests in three places. Move the boundary up: one
`CopyButton` owns the markup and folds the copy state inside as a private detail.

## Step 1 — Read the three call sites and the state helper

Read these five files before editing:

- `apps/web/src/routes/tasks/[taskId]/_components/copyState.svelte.ts` — the whole helper (23 lines)
- `apps/web/src/routes/tasks/[taskId]/_components/UserMessage.svelte:20-33`
- `apps/web/src/routes/tasks/[taskId]/_components/AgentMessage.svelte:59-72`
- `apps/web/src/routes/tasks/[taskId]/_components/AgentMessageCodeBlock.svelte:196-211`
- `apps/web/src/routes/_components/Icon.svelte:34-63` — confirms `check` and `copy` map to lucide
  `Check` and `Copy`, the same icons `AgentMessageCodeBlock` imports directly

### Reference: the verified three-site divergence

Every column below is real current behaviour and must survive the refactor. It is also the prop
list: each row is one call site's arguments.

|                   | UserMessage                                                                                                                                        | AgentMessage          | AgentMessageCodeBlock                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| aria-label idle   | `Copy message`                                                                                                                                     | `Copy response`       | `Copy code`                                                                       |
| aria-label copied | `Message copied`                                                                                                                                   | `Response copied`     | `Copied`                                                                          |
| tooltip idle      | `Copy`                                                                                                                                             | `Copy`                | `Copy code`                                                                       |
| tooltip copied    | `Copied`                                                                                                                                           | `Copied`              | `Copied`                                                                          |
| tooltip classes   | `icon-tooltip-bubble`                                                                                                                              | `icon-tooltip-bubble` | `icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-right` |
| button class      | `grid size-6 place-items-center rounded text-faint hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary` | same as UserMessage   | `markdown-codeblock__action`                                                      |
| icon source       | `Icon.svelte`                                                                                                                                      | `Icon.svelte`         | `@lucide/svelte` direct                                                           |

Note the two divergences that are easy to flatten by accident: the copied aria-label is _not_
uniform (`Copied` only in the code block), and the tooltip text differs from the aria-label at every
site.

**Done when:** you can state, without re-reading, which of the seven rows differ per site.

## Step 2 — Add `CopyButton.svelte`

Create `apps/web/src/routes/tasks/[taskId]/_components/CopyButton.svelte`. All three consumers live
in this directory, so the component belongs here — the routes-level `_components/` directory is for
multi-route consumers only.

Props, with defaults covering the two common sites:

- `text: string` — what to copy
- `label: string` — idle aria-label
- `copiedLabel: string` — copied aria-label
- `tooltip: string` — idle tooltip text
- `copiedTooltip?: string` — defaults to `"Copied"`
- `placement?: "above" | "below-right"` — defaults to `"above"`; `"below-right"` adds
  `icon-tooltip-bubble--below icon-tooltip-bubble--align-right`
- `class?: string` — button classes, defaulting to the `grid size-6 …` string from the table

Move the body of `createCopyState` into this component's instance script as plain runes — `let copied
= $state(false)`, the 1500ms timer, and the `onDestroy` cleanup. Render `Icon` with
`name={copied ? "check" : "copy"} size={13}` for every site: `Icon.svelte:60-63` maps those names to
the same lucide components the code block imports today, so the rendered icon is unchanged.

**Done when:** `CopyButton.svelte` renders the button, the tooltip span with `role="tooltip"`, and
the icon, and holds the only `navigator.clipboard.writeText` call under
`apps/web/src/routes/tasks/`.

## Step 3 — Replace the three call sites

Each call site drops its `createCopyState` import, its `const copyState = …`, and its 12-line markup
block, keeping the wrapping `<span class="icon-tooltip relative inline-flex">` only if the layout
needs it — `CopyButton` should own that span. Pass the row from the table in Step 1.

`AgentMessageCodeBlock` additionally drops `Check` and `Copy` from its `@lucide/svelte` import,
keeping `WrapText`.

**Done when:** each of the three call sites renders `CopyButton` in at most two lines, and
`grep -rn "createCopyState" apps/web` returns only the definition.

## Step 4 — Delete the helper

Delete `apps/web/src/routes/tasks/[taskId]/_components/copyState.svelte.ts`.

**Done when:** the file is gone and `grep -rn "createCopyState\|copyState" apps/web` returns zero
hits.

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

**Done when:** all five pass with no edits to any test file. Test edits mean behaviour changed —
compare against the invariants below and fix the component instead.

## Invariants

These are the observable behaviours the refactor preserves. Each has an existing proof:

- **Aria labels per site are unchanged.** `UserMessage.test.ts` asserts `aria-label="Copy message"`
  is present for non-empty text and absent for blank text; `e2e/conversation.spec.ts:119` clicks
  `getByRole("button", { name: "Copy response" })` and polls the clipboard.
- **The code block keeps its below/right tooltip placement** and its `markdown-codeblock__action`
  button class — it sits in a dense header row where the default above-placement would clip.
- **Copied feedback resets after 1500ms**, and a pending timer is cleared on destroy.
- **A failed clipboard write leaves `copied` false** rather than showing success.
- **The blank-message case still renders no copy footer** — that condition lives in `UserMessage`,
  not in `CopyButton`.
