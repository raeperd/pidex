# Effect Source Setup

This setup task is required when the shared Effect explorer checkout is missing.

## Prompt

The read-only Effect source checkout was not found in the shared repo-explorer store.

Use the `repo-explorer-clone` skill to add the GitHub repository `Effect-TS/effect-smol`, then resume Effect work after that workflow has cloned, verified, and locked the checkout.

## Expected Location

Resolve the storage root once, require it to be absolute, and derive the canonical checkout path:

```sh
EXPLORER_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/repo-explorer"
EFFECT_REPO="$EXPLORER_ROOT/Effect-TS/effect-smol"
```

The expected canonical path is `$EFFECT_REPO`. Do not use sibling revision worktrees such as `effect-smol@<ref>` for the default source prerequisite.

## Verification

The `repo-explorer-clone` workflow must verify that the checkout:

- is a clean Git worktree with a materialized default branch
- uses `https://github.com/Effect-TS/effect-smol.git` as its canonical origin URL
- records `origin` as a promisor remote with the `blob:none` partial clone filter
- is locked read-only together with the explorer cache after setup

## Rules

- Treat the checkout and its Git metadata as read-only.
- Do not vendor Effect source into the user repository.
- Do not add repository-local Effect source setup.
- Continue only after the explorer checkout exists and passes verification.
