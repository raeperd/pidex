---
name: drizzle-orm-sqlite
description: Use Drizzle ORM with SQLite and node:sqlite; load when defining SQLite schemas, building typed queries, using transactions, or testing Drizzle persistence without Drizzle Kit.
---

Use the installed Drizzle ORM API without assuming a Drizzle Kit workflow.

## Process

1. Identify the installed boundary.
   - Read the package manifest and lockfile for the exact `drizzle-orm` version.
   - Identify the driver, connection owner, schema exports, and sync or async API style.
   - Prefer installed types when release-candidate APIs differ from current docs.
   - Completion: the ORM version, SQLite driver, and connection lifecycle are known.

2. Define the schema.
   - Use `sqliteTable` and SQLite column builders from `drizzle-orm/sqlite-core`.
   - Express keys, constraints, defaults, checks, and indexes explicitly.
   - Align TypeScript declarations with the schema applied to the database.
   - Treat declarations as metadata; they do not alter an existing database alone.
   - Completion: declarations match the database objects and constraints the code expects.

3. Build typed data access.
   - Prefer Drizzle select, insert, update, delete, and relational query builders.
   - Import operators such as `eq`, `and`, `or`, `inArray`, and `desc` from `drizzle-orm`.
   - Use `sql` fragments for dialect behavior the typed builders cannot express directly.
   - Bind external values through Drizzle instead of interpolating SQL strings.
   - Select only the columns needed when rows contain large or sensitive values.
   - Completion: inputs, results, ordering, and empty-result behavior are explicit.

4. Preserve transaction semantics.
   - Use `db.transaction` for writes that must commit or roll back together.
   - Keep all correlated reads and writes on the transaction handle.
   - Match synchronous `node:sqlite` behavior to the installed Drizzle API.
   - Make retry and idempotency decisions at the application boundary.
   - Completion: partial failure cannot leave the affected invariant half-applied.

5. Handle schema evolution deliberately.
   - Inspect installed tooling before choosing migration, push, or initialization SQL.
   - Keep Drizzle Kit commands outside the workflow when `drizzle-kit` is not installed.
   - Pair persisted schema changes with a compatible upgrade or rebuild strategy.
   - Completion: both new and existing databases have a defined schema path.

6. Verify through SQLite.
   - Exercise queries against a temporary real SQLite database.
   - Test constraints, transaction rollback, ordering, and restart behavior when relevant.
   - Close database handles and remove temporary state during cleanup.
   - Inspect `sqlite_master` or pragmas when database structure is part of the behavior.
   - Completion: tests observe behavior across the actual Drizzle and SQLite boundary.

## Official references

- [Node SQLite driver](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite)
- [SQLite schema declarations](https://orm.drizzle.team/docs/sql-schema-declaration)
- [Select queries](https://orm.drizzle.team/docs/select)
- [Transactions](https://orm.drizzle.team/docs/transactions)
