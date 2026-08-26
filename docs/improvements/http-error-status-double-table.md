# Declare each API error's HTTP status once

An API error's HTTP status is written twice: once at the throw site, in
`HttpError.make({ status: 403, code: "workspace_forbidden", … })`, and once in the `errorStatusMap`
that `main.ts` hands to `RPCHandler`. Twenty-one of the map's twenty-three rows restate a status that
already exists at a throw site. Adding an endpoint error therefore means editing the feature file and
the composition root — and nothing detects the two drifting apart. Give each code one declaration
that both the oRPC path and the raw-Node path read.

## Step 1 — Understand which mechanism the framework sanctions

This repo runs **oRPC 2.0.0-beta.21** (`pnpm-lock.yaml`; note `docs/architecture.md:64` still says
"oRPC 1" and should be corrected while you are here). That version matters more than anything else in
this document:

- In oRPC v1, `ORPCError` carried a `status` option, so an error could name its own status.
- **In v2, `status` was removed from `ORPCError` and from error definitions.** HTTP status is
  resolved by the handler through `errorStatusMap`, keyed by error code.

So the fix is not "make the status travel with the error" — that fights the framework. The fix is to
stop hand-writing the map: derive it from one table that the throw sites also read.

Read `apps/server/src/http-api.ts:299-310` (the `protocolErrors` middleware, which converts a typed
error into `new ORPCError(code, { message })` and by design carries no status) and
`apps/server/src/main.ts:56-79` (the map) before continuing.

**Done when:** you can state why the throw site's `status` field is ignored on the oRPC path but
honoured on the raw-Node path (`main.ts:99-100`).

## Step 2 — Add the status table to `errors.ts`

In `apps/server/src/errors.ts`, add one table and one constructor:

```ts
export const apiErrorStatus = {/* code: status, from the table below */} as const;
export type ApiErrorCode = keyof typeof apiErrorStatus;

export function apiError(code: ApiErrorCode, message: string) {
  return HttpError.make({ status: apiErrorStatus[code], code, message });
}
```

`HttpError` keeps its `status` field. Step 4 explains the case that requires it.

### Reference: the verified status table

Every row is a code that crosses the oRPC boundary. The status column is what the throw site declares
today and what the map declares today — they agree, and this table is where they merge.

| Code                             | Status | Declared at                                       |
| -------------------------------- | ------ | ------------------------------------------------- |
| `action_conflict`                | 409    | `ActionProtocolError`, thrown in `metadata.ts`    |
| `stale_revision`                 | 409    | `ActionProtocolError`, `metadata.ts`              |
| `session_busy`                   | 409    | `ActionProtocolError`, `http-api.ts:344`          |
| `run_mismatch`                   | 409    | `ActionProtocolError`, `metadata.ts`              |
| `interrupted_run`                | 409    | `ActionProtocolError`, `metadata.ts`              |
| `dialog_mismatch`                | 409    | `http-api.ts:354`                                 |
| `dialog_value_invalid`           | 400    | `http-api.ts:367`                                 |
| `model_unavailable`              | 400    | `http-api.ts:245`                                 |
| `validation`                     | 400    | `http-api.ts:196`                                 |
| `worktree_has_tasks`             | 409    | `http-api.ts:135`                                 |
| `workspace_not_managed_worktree` | 400    | `http-api.ts:125` **and** `project-catalog.ts:93` |
| `workspace_forbidden`            | 403    | `security.ts:62` **and** `http-api.ts:72`         |
| `workspace_missing`              | 404    | `security.ts:42`                                  |
| `workspace_not_directory`        | 400    | `security.ts:54`                                  |
| `project_outside_repository`     | 400    | `project-catalog.ts:21`                           |
| `project_missing_from_worktree`  | 400    | `project-catalog.ts:61`                           |
| `project_not_git`                | 400    | `project-catalog.ts:181`                          |
| `worktree_create_failed`         | 400    | `project-catalog.ts:48` via `runGit` (`:190-196`) |
| `worktree_branch_read_failed`    | 400    | `project-catalog.ts:82` via `runGit`              |
| `worktree_remove_failed`         | 400    | `project-catalog.ts:103` via `runGit`             |
| `worktree_branch_remove_failed`  | 400    | `project-catalog.ts:109` via `runGit`             |

Two map rows stay outside the table because no `HttpError` declares them: `csrf: 403` (thrown as
`new ORPCError("csrf", …)` at `http-api.ts:36`) and `internal_error: 500` (the middleware's fallback).

**Done when:** `apiErrorStatus` has exactly the 21 rows above, and `ApiErrorCode` typechecks.

## Step 3 — Route the throw sites and the map through the table

Replace each `HttpError.make({ status, code, message })` in the table with
`apiError(code, message)`. `runGit` (`project-catalog.ts:190`) takes its code as a parameter — widen
that parameter to `ApiErrorCode` so its four call sites stay checked.

For `ActionProtocolError`, delete the dead `readonly status = 409` (`errors.ts:29`) — nothing reads
it — and let its five codes take their status from the table. Keep the `actionProtocolCodes` schema
literal union; it constrains the code at construction, which the table does not.

In `main.ts`, the map becomes:

```ts
errorStatusMap: { ...COMMON_ERROR_STATUS_MAP, ...apiErrorStatus, csrf: 403, internal_error: 500 },
```

**Done when:** `grep -nE "workspace_forbidden|worktree_has_tasks|stale_revision" apps/server/src/main.ts`
returns nothing, and no `HttpError.make` in `http-api.ts`, `project-catalog.ts`, or the table's
`security.ts` sites passes a numeric `status` literal.

## Step 4 — Leave the raw-Node-only codes alone

Five codes never reach oRPC — `validateRequest` runs before the handler, and `main.ts` throws the
other two directly. They keep calling `HttpError.make` with an explicit status:

`bad_host`, `bad_origin`, `cross_site` (`security.ts:70-110, 145-163`), `not_found` (`main.ts:95`),
`web_build_missing` (`main.ts:177`).

The gotcha that forces this split: **`bad_host` is thrown with two different statuses** — 400 for a
missing or malformed `Host` header (`security.ts:76, 153`) and 403 for a host that is not allowed
(`security.ts:82`). Status is therefore not a function of code across the whole server, only across
the codes that cross oRPC. Adding `bad_host` to the table would silently flatten a
malformed-request case into a forbidden one.

**Done when:** those five codes still construct `HttpError` with an explicit status, and both
`bad_host` statuses survive.

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

**Done when:** all five pass with **no test file edited**. Any test change means a status moved.

## Invariants

Every endpoint returns the identical HTTP status and error body before and after. The existing tests
are the proof, and they are unusually good here:

- `http-api.test.ts:655` — `expectRpcError(operation, code, status)` asserts the code _and_ the real
  wire status; it is called at thirteen sites covering 400, 403, 404, 409, 413, and 500.
- `http-api.test.ts:154-203` — raw-path statuses: unknown API route 404, forbidden host 403,
  malformed body 400, missing CSRF 403, oversized body 413.
- `security.test.ts:26,30` — asserts `HttpError.status === 403` directly on `canonicalWorkspace`
  failures, which is why `HttpError` keeps its `status` field.

The error body shape (`{ error: { code, message } }`) is unchanged: `main.ts:101-106` builds it from
`code`, never from `status`.

Related: `docs/improvements/action-protocol-choreography-split.md` also touches `http-api.ts`, but
only the handler bodies — the scopes are disjoint.
