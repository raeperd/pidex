# Narrow the app-shell API client to what it actually hides

`AppShellApiClient.ts` presents 22 methods over `PidexApiContractClient` — an oRPC contract client
that is already fully typed. Ten of those methods only rename a call. The interface advertises a
substitutable transport layer; what the module actually hides is four cross-cutting concerns (CSRF
capture, client identity, optimistic-concurrency fields, per-request paging limits). Shrink the
surface to those, and let call sites use the contract client directly for the rest.

This is scope hygiene, not pain relief: the file is not a churn hot spot and the change is
mechanical. Leave `AppShellConnection.ts` alone — four methods over socket-identity guards, resume,
and backoff is a deep module and the model to keep.

## Step 1 — Confirm the typing story before deleting anything

The deletions in Step 3 only hold if calling the contract client inline stays as well typed as the
wrapper. Verify once, cheaply: pick `getChat`, replace its single call site
(`packages/web/src/routes/_components/AppShell.svelte:1404`) with
`api.client.chats.get({ chatId: snapshot.chatId })`, and run `pnpm check` from the repo root.

Reference: `makePidexApiClient` builds `const client: PidexApiContractClient = createORPCClient(link)`
(`AppShellApiClient.ts:31`). Returning that `client` from the factory is what makes inline calls
possible — add it to the returned object in this step.

Note the one typing dependency to preserve: `AppShell.svelte:118` derives
`type ChatConfiguration = Parameters<PidexApiClient["configure"]>[1]`, so `configure` must survive
with its current signature.

**Done when:** `pnpm check` passes with `getChat` inlined and `client` exposed on the returned
object.

## Step 2 — Keep the members that carry a concern

These twelve stay, because each injects something the call site should not repeat:

| Member                                                                                            | What it hides                                                                             |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `bootstrap`                                                                                       | captures `csrfToken` into the link's header closure (`:34-38`)                            |
| `createActionId`                                                                                  | the id format; used directly at `AppShell.svelte:1207`                                    |
| `sendMessage`                                                                                     | `clientId` + `delivery: "normal"`                                                         |
| `abort`, `acknowledgeInterrupted`, `clearQueue`, `configure`, `rename`, `compact`, `answerDialog` | `actionFields(expectedRevision)` — `clientId`, a fresh `actionId`, and `expectedRevision` |
| `toolOutput`                                                                                      | the per-request `limit: 16_384`                                                           |
| `transcript`                                                                                      | the per-request `limit: 50`                                                               |

`dialogValue` is a module-level pure function, not part of the client surface; leave it exported as
is.

One inconsistency to leave alone here: `sendMessage` takes `actionId` as a parameter while the other
mutating calls generate one inside `actionFields`. That is deliberate — `AppShell.svelte:1207`
reuses a pending prompt's id across retries. Changing it belongs to a different refactor.

**Done when:** you can name, for each of the twelve, the injected value that would otherwise be
duplicated at the call site.

## Step 3 — Delete the ten pass-throughs and inline their call sites

Each row is one deletion plus its verified call sites. The right column is what the call site
becomes.

| Deleted member      | Call sites in `AppShell.svelte` | Inline replacement                                                                                                              |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `openWorkspace`     | 647, 1036                       | `client.workspaces.open({ path, remember })` — both sites already pass `remember` explicitly, so the `= true` default is unused |
| `createWorktree`    | 917                             | `client.workspaces.createWorktree({ workspaceId })`                                                                             |
| `removeWorktree`    | 962                             | `await client.workspaces.removeWorktree({ workspaceId })`                                                                       |
| `reorderWorkspaces` | 614                             | `(await client.workspaces.reorder({ workspaceIds })).recentWorkspaces`                                                          |
| `setWorkspaceTrust` | 773                             | `client.workspaces.trust({ workspaceId, trusted })`                                                                             |
| `listSessions`      | 810                             | `(await client.workspaces.sessions({ workspaceId })).sessions`                                                                  |
| `createChat`        | 860, 919                        | `client.chats.create({ workspaceId })`                                                                                          |
| `resumeTask`        | 1002                            | `client.chats.resume({ taskId })`                                                                                               |
| `getChat`           | 1404                            | `client.chats.get({ chatId })` — already done in Step 1                                                                         |
| `disposeChat`       | 897                             | `await client.chats.dispose({ chatId })`                                                                                        |

**Done when:** `AppShellApiClient.ts` returns exactly thirteen members (the twelve from Step 2 plus
`client`), and `grep -n "api\." packages/web/src/routes/_components/AppShell.svelte` shows no call to any
deleted name.

## Step 4 — Verify

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

`pnpm check` is the real proof here — the whole refactor is a typing claim, and typecheck settles
it. `pnpm deadcode` catches any now-unused import left behind in `AppShellApiClient.ts`.

**Done when:** all five pass with no test file edited.

## Invariants

The wire traffic is identical before and after:

- **CSRF**: `bootstrap` still captures `csrfToken`, and every subsequent request still carries the
  `X-Pidex-CSRF` header from the link's `headers()` closure.
- **Client identity**: `clientId` is still read from (or seeded into) `localStorage` under
  `pidex:client-id`, and still accompanies every mutating call.
- **Optimistic concurrency**: every call that sends `actionId` + `expectedRevision` today still
  sends both, with a fresh `actionId` per call except the `sendMessage` retry path.
- **Paging limits**: tool output still requests 16384 bytes per chunk and transcript pages still
  request 50 items.

Related: `docs/improvements/tool-output-paging-split.md` relocates the `16_384` constant to the
component that owns paging. Land that one after this if you do both.
