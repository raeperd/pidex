---
name: pidex-drizzle-sqlite
description: Maintain Pidex's Drizzle ORM metadata store over node:sqlite; use when editing metadata schema, queries, transactions, indexes, initialization SQL, or persistence tests.
url: https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/skills/drizzle/SKILL.md
---

Maintain the Pidex metadata store without importing a migration workflow it does not use.

## Process

1. Inspect the persistence boundary.
   - Read `apps/server/src/metadata-schema.ts` and `apps/server/src/metadata.ts`.
   - Read persistence tests and the relevant architecture documentation.
   - Confirm the installed Drizzle version and current schema initialization strategy.
   - Completion: the affected tables, queries, invariants, and tests are identified.

2. Protect schema parity and compatibility.
   - Compare typed declarations with `METADATA_SCHEMA_SQL` before changing either.
   - Match names, types, nullability, defaults, uniqueness, and index column order.
   - Treat changes to existing tables as persisted-data compatibility changes.
   - Remember that `CREATE TABLE IF NOT EXISTS` does not upgrade an existing table.
   - Stop for an architecture decision when an existing database needs migration.
   - Completion: typed schema, initialization SQL, and compatibility behavior agree.

3. Implement the data-access change.
   - Prefer typed Drizzle builders for reads and writes.
   - Use `sql` fragments only for SQLite behavior unavailable through typed builders.
   - Group correlated action and session-state writes in an immediate transaction.
   - Preserve revision checks, action replay, run identity, and crash recovery.
   - Keep connection ownership and persistence wiring inside `MetadataStore`.
   - Completion: the smallest coherent change preserves every affected invariant.

4. Verify with real SQLite.
   - Use an isolated temporary `PIDEX_STATE_DIR` and a real `DatabaseSync` database.
   - Close every store and database handle during cleanup.
   - Cover restart persistence when a change affects durable state.
   - Cover replay and transaction behavior when a change affects action processing.
   - Inspect `sqlite_master` when a change affects tables or indexes.
   - Completion: integration tests observe behavior through the real database boundary.

5. Validate the server workspace.
   - Run `pnpm --filter @pidex/server test`.
   - Run `pnpm --filter @pidex/server typecheck`.
   - Run `pnpm --filter @pidex/server build` for production-code changes.
   - Run the repository check when the change crosses workspace boundaries.
   - Completion: relevant checks pass and failures are reported with their cause.

## Repository rules

- Use Drizzle for typed queries and transactions over Node's built-in SQLite client.
- Keep transcripts and credentials out of the metadata database.
- Preserve `WAL` journal mode and foreign-key enforcement during initialization.
- Add indexes only for demonstrated query shapes and verify their column ordering.
- Keep timestamps sortable and consistent with existing persisted values.
- Keep application wiring in the existing server composition root.
- Add `drizzle-kit` or migrations only after an explicit architecture decision.
- Pair every persisted schema change with an existing-database compatibility plan.

## Upstream references

- [Drizzle root skill](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/skills/drizzle/SKILL.md)
- [Drizzle migration skill](https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-kit/skills/drizzle-migrations/SKILL.md)

These upstream skills describe Drizzle Kit. Load them only after the repository adopts it.
