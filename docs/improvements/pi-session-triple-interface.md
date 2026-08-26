# Collapse the three Pi session surfaces into one

A Pi chat session is described three times: `makePiSession` returns a 14-member object, `AdapterSession`
restates 13 of those members in Promise form, and `EffectAdapterSession` restates them again in Effect
form — bridged by `toEffectAdapterSession`, a 28-line mapper whose entries are almost all
`attemptPromise("session.X", () => session.X(args))`. Only one implementation exists, so the Promise-shaped
middle layer is a seam that no second caller ever uses. Let `makePiSession` produce the Effect shape
directly, and narrow the lifecycle bridge to the three members it actually touches.

## Step 1 — Separate the real seams from the restatements

Two of the surfaces this refactor touches are load-bearing. Establish that before deleting anything.

**`EffectAdapterSession` stays.** `chat-manager.ts:44` stores it on every `ChatRecord`; it is the type
the rest of the server programs against.

**`PiSdkServiceApi` stays, but should be derived.** `app-runtime.ts:8` uses it as the Effect service tag
type (`Context.Service<PiSdkServiceApi>`), so the DI wiring needs a name for it. What it does _not_ need
is the hand-written 12-line interface at `pi-sdk.ts:42-53` restating what `makePiSdkService` already
returns. The repo has already made this exact move once: `metadata.ts:31` is
`export type MetadataService = ReturnType<typeof makeMetadataService>` (commit 09be1a5). Apply the same
one-liner here.

**`AdapterSession` is the restatement.** Its only implementations are `makePiSession`'s return value and
the 86-line `makeSessionFixture()` in `pi-sdk.test.ts:500`.

**Done when:** `pi-sdk.ts` declares `export type PiSdkServiceApi = ReturnType<typeof makePiSdkService>`,
the hand-written interface is gone, and `pnpm check` passes.

## Step 2 — Emit Effect-shaped members from `makePiSession`

`makePiSession` (`pi-sdk.ts:166-437`) currently returns Promise- and sync-shaped members that
`toEffectAdapterSession` immediately re-wraps. Move that wrapping to the source: build each member with
`attemptPromise` / `attemptSync` inside `makePiSession`, so its return value satisfies
`EffectAdapterSession` without a mapper.

Two details to carry across exactly:

- `prompt` keeps `.pipe(Effect.onInterrupt(() => abortForCleanup(session)))` — that is what makes fiber
  interruption abort the underlying Pi run, and `pi-sdk.test.ts:59-80` asserts the abort count.
- The `state` half of `EffectAdapterSession` is a live view, not a snapshot: `messages`, `model`,
  `contextUsage`, and `isIdle` are getters over mutable Pi state (`pi-sdk.ts:398-420`). Keep them
  getters; copying them into a plain object would freeze the transcript.

**Done when:** `grep -n "toEffectAdapterSession" apps/server/src` returns zero hits and the mapper is
deleted.

## Step 3 — Narrow the lifecycle contract

`acquireAdapterSession` (`adapter.ts:104-110`) exists for genuine reasons that survive: it pairs
`Effect.acquireRelease` with a release that aborts then disposes (`releaseAdapterSession`, `:151-162`),
and it bridges the callback-style `subscribe` into a `Stream` with matched unsubscribe
(`sessionEvents`, `:139-149`). Those two behaviours are non-obvious and worth a named home.

What they do _not_ need is a 13-member input type. The lifecycle code touches exactly three members:
`subscribe`, `abort`, and `dispose`. Replace `AdapterSession` with a contract naming only those, and let
`acquireAdapterSession` take "that contract plus the Effect-shaped members" so it can return an
`EffectAdapterSession` unchanged.

Delete `AdapterSession` once nothing references it. Note `chat-manager.ts:536` derives
`Parameters<AdapterSession["configure"]>[0]` — repoint it at the `EffectAdapterSession` equivalent.

**Done when:** `grep -rn "AdapterSession\b" apps/server/src` matches only `EffectAdapterSession` and
`AdapterSessionInfo`, and the contract `adapter.ts` declares for the lifecycle bridge has at most four
members.

## Step 4 — Move `bounded` and `boundedResource` to their callers

`adapter.ts:172-190` exports both, and every one of their nine call sites is in `pi-sdk.ts`
(`:102, 121, 122, 236, 251, 252, 258`). They format Pi transcript payloads; they are not part of any
boundary contract. Move them into `pi-sdk.ts`, unexported, per the repo's one-use-code rule.

**Done when:** `grep -n "bounded" apps/server/src/adapter.ts` returns zero hits.

## Step 5 — Reshape the test fixture

`makeSessionFixture()` (`pi-sdk.test.ts:500-586`) builds a Promise-shaped session. Rebuild it against
the new shape. The three behaviours it proves must keep their assertions:

- **Stream ordering and unsubscribe** (`:11-38`) — events arrive in order; `listenerCount` returns to 0
  when the stream ends.
- **Typed error mapping** (`:41-57`) — a rejected Pi call surfaces as `_tag: "AdapterSessionError"` with
  `operation: "session.prompt"` and the original message.
- **Abort on interrupt, dispose on scope close** (`:59-80`) — `abortCount` is 1 after interrupting the
  prompt fiber and 2 after the scope closes; `disposed` flips only at scope close.

**Done when:** all three tests pass without weakening an assertion, and the fixture is smaller than it is
today.

## Step 6 — Verify

Run from the repo root, in order:

```sh
pnpm format
pnpm check
pnpm test
pnpm test:e2e
pnpm deadcode
```

Run every command from the repo root: the vitest root config globs `apps/**/*.test.ts` against the root,
so `pnpm --filter <pkg> test` reports "No test files found".

`pnpm deadcode` matters here: `knip` will flag any adapter export left without a consumer, which is the
cheapest check that the collapse actually landed.

**Done when:** all five pass, and `adapter.ts` is materially shorter than its current 190 lines.

## Invariants

Observable behaviour that must survive:

- **Event mapping.** Every `AdapterEvent` variant (`adapter.ts:15-24`) is produced from the same Pi
  events, in the same order, with the same payloads. `pi-sdk.test.ts` covers the transcript-restore and
  tool-event paths.
- **Transcript restore.** `messages` and `toolOutputs` still read through to the restored transcript, so
  a resumed task shows its history.
- **Typed errors at the boundary.** Failures stay `TaggedOperationError` values —
  `AdapterSessionError` for session calls, `PiSdkError` for workspace calls — never raw rejections. The
  `operation` strings (`session.prompt`, `session.abort`, `workspace.inspect`, …) are asserted by tests
  and appear in logs; keep them byte-identical.
- **Abort on fiber interrupt**, and **abort-then-dispose on scope close**, in that order. Disposal also
  resolves every pending extension dialog with `null` (`pi-sdk.ts:391-396`).
