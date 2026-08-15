import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_RECENT_WORKSPACES, type ActionOutcome, type RunOutcome } from "@pidex/api";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { drizzle } from "drizzle-orm/node-sqlite";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Context, Effect, Layer, Schema } from "effect";
import { ActionProtocolError, failureMessage } from "./errors.js";

interface ActionInput {
  actionId: string;
  clientId: string;
  expectedRevision: number;
  requestDigest: string;
  sessionKey: string;
}

export const requestDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class MetadataError extends Schema.TaggedErrorClass<MetadataError>()("MetadataError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface MetadataService {
  readonly rememberWorkspace: (
    canonicalPath: string,
    sourceWorkspaceId?: string,
  ) => Effect.Effect<string, MetadataError>;
  readonly workspaceId: (canonicalPath: string) => Effect.Effect<string | undefined, MetadataError>;
  readonly recent: () => Effect.Effect<
    Array<{ id: string; path: string; sourceWorkspaceId?: string }>,
    MetadataError
  >;
  readonly workspaceProjectId: (workspaceId: string) => Effect.Effect<string, MetadataError>;
  readonly forgetWorkspace: (workspaceId: string) => Effect.Effect<void, MetadataError>;
  readonly reorderWorkspaces: (
    workspaceIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, MetadataError>;
  readonly rememberTask: (
    workspaceId: string,
    workspacePath: string,
    sessionKey: string,
  ) => Effect.Effect<string, MetadataError>;
  readonly task: (
    id: string,
  ) => Effect.Effect<
    { id: string; workspaceId: string; workspacePath: string; sessionKey: string } | undefined,
    MetadataError
  >;
  readonly sessionState: (
    sessionKey: string,
  ) => Effect.Effect<{ revision: number; run?: RunOutcome }, MetadataError>;
  readonly acceptPrompt: (
    input: ActionInput,
  ) => Effect.Effect<ActionOutcome, MetadataError | ActionProtocolError>;
  readonly acceptStop: (
    input: ActionInput & { runId: string },
  ) => Effect.Effect<ActionOutcome, MetadataError | ActionProtocolError>;
  readonly acceptRunMutation: (
    input: ActionInput & { runId: string; kind: "steer" | "follow-up" },
  ) => Effect.Effect<ActionOutcome, MetadataError | ActionProtocolError>;
  readonly acceptSessionMutation: (
    input: ActionInput & {
      kind: "clear-queue" | "compact" | "config" | "dialog" | "rename";
    },
  ) => Effect.Effect<ActionOutcome, MetadataError | ActionProtocolError>;
  readonly acknowledgeInterrupted: (
    input: ActionInput,
  ) => Effect.Effect<ActionOutcome, MetadataError | ActionProtocolError>;
  readonly markPromptStatus: (
    sessionKey: string,
    runId: string,
    status: ActionStatus,
  ) => Effect.Effect<void, MetadataError>;
  readonly markActionStatus: (
    actionId: string,
    status: ActionStatus,
  ) => Effect.Effect<void, MetadataError>;
}

export const Metadata = Context.Service<MetadataService>("@pidex/server/Metadata");

export function makeMetadataLayer(stateDir?: string) {
  return Layer.effect(
    Metadata,
    Effect.acquireRelease(
      attemptMetadata("initialize", () => makeMetadataStore(stateDir)),
      (store) => Effect.sync(() => store.close()),
    ).pipe(Effect.map(makeMetadataService)),
  );
}

/** Low-level synchronous SQLite boundary. Application code consumes it through `Metadata`. */
export function makeMetadataStore(stateDir?: string) {
  const dir = stateDir ?? process.env.PIDEX_STATE_DIR ?? path.join(os.homedir(), ".pidex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(path.join(dir, "pidex.sqlite"));
  let db: MetadataDatabase;
  try {
    sqlite.exec(METADATA_SCHEMA_SQL);
    ensureWorkspaceSortOrder();
    addWorkspaceColumn("listed", "listed INTEGER NOT NULL DEFAULT 1");
    addWorkspaceColumn("source_workspace_id", "source_workspace_id TEXT");
    pruneWorkspaceHistory();
    sqlite.exec(WORKSPACE_ORDER_INDEX_SQL);
    db = drizzle({ client: sqlite });

    // A process death cannot prove whether Pi completed after the last durable update.
    // Preserve that ambiguity and require an explicit acknowledgement before new work.
    db.transaction(
      (tx) => {
        tx.update(actions)
          .set({ status: "interrupted", updatedAt: sql`datetime('now')` })
          .where(and(eq(actions.kind, "prompt"), inArray(actions.status, ["accepted", "running"])))
          .run();
        tx.update(sessionState)
          .set({
            runStatus: "interrupted",
            requiresAcknowledgement: true,
            updatedAt: sql`datetime('now')`,
          })
          .where(inArray(sessionState.runStatus, ["accepted", "running", "stopping"]))
          .run();
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    sqlite.close();
    throw error;
  }

  function rememberWorkspace(canonicalPath: string, sourceWorkspaceId?: string): string {
    return db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.path, canonicalPath))
        .get();
      const existing = existingRow ? decodeWorkspaceRow(existingRow) : undefined;
      const openedAt = new Date().toISOString();
      if (existing?.listed) {
        tx.update(workspaces)
          .set({ openedAt, ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}) })
          .where(eq(workspaces.id, existing.id))
          .run();
        return existing.id;
      }
      const retained = tx
        .select({ count: count() })
        .from(workspaces)
        .where(eq(workspaces.listed, true))
        .get();
      if ((retained?.count ?? 0) >= MAX_RECENT_WORKSPACES) {
        const oldestRow = tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.listed, true))
          .orderBy(workspaces.openedAt, workspaces.id)
          .limit(1)
          .get();
        const oldest = oldestRow ? decodeWorkspaceRow(oldestRow) : undefined;
        if (oldest)
          tx.update(workspaces).set({ listed: false }).where(eq(workspaces.id, oldest.id)).run();
      }
      const lastRow = tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.listed, true))
        .orderBy(desc(workspaces.sortOrder))
        .limit(1)
        .get();
      const last = lastRow ? decodeWorkspaceRow(lastRow) : undefined;
      const sortOrder = (last?.sortOrder ?? -1) + 1;
      if (existing) {
        tx.update(workspaces)
          .set({
            listed: true,
            openedAt,
            sortOrder,
            ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
          })
          .where(eq(workspaces.id, existing.id))
          .run();
        return existing.id;
      }
      const persistedRow = tx
        .insert(workspaces)
        .values({
          id: randomUUID().replaceAll("-", ""),
          path: canonicalPath,
          openedAt,
          sortOrder,
          listed: true,
          ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
        })
        .returning()
        .get();
      if (!persistedRow) throw new Error(`Workspace ${canonicalPath} was not persisted`);
      return decodeWorkspaceRow(persistedRow).id;
    });
  }

  function findWorkspaceId(canonicalPath: string): string | undefined {
    const row = db.select().from(workspaces).where(eq(workspaces.path, canonicalPath)).get();
    return row ? decodeWorkspaceRow(row).id : undefined;
  }

  function recent(): Array<{ id: string; path: string; sourceWorkspaceId?: string }> {
    return db
      .select()
      .from(workspaces)
      .where(eq(workspaces.listed, true))
      .orderBy(workspaces.sortOrder, workspaces.id)
      .limit(MAX_RECENT_WORKSPACES)
      .all()
      .map((row) => {
        const { id, path: workspacePath, sourceWorkspaceId } = decodeWorkspaceRow(row);
        return {
          id,
          path: workspacePath,
          ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
        };
      });
  }

  function workspaceProjectId(workspaceId: string): string {
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    return row ? (decodeWorkspaceRow(row).sourceWorkspaceId ?? workspaceId) : workspaceId;
  }

  function forgetWorkspace(workspaceId: string): void {
    db.transaction((tx) => {
      const sessionKeys = tx
        .select({ sessionKey: tasks.sessionKey })
        .from(tasks)
        .where(eq(tasks.workspaceId, workspaceId))
        .all()
        .map(({ sessionKey }) => sessionKey);
      if (sessionKeys.length > 0) {
        tx.delete(actions).where(inArray(actions.sessionKey, sessionKeys)).run();
        tx.delete(sessionState).where(inArray(sessionState.sessionKey, sessionKeys)).run();
      }
      tx.delete(tasks).where(eq(tasks.workspaceId, workspaceId)).run();
      tx.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
    });
  }

  function reorderWorkspaces(workspaceIds: string[]): void {
    db.transaction((tx) => {
      const persistedIds = tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.listed, true))
        .all()
        .map((row) => decodeWorkspaceRow(row));
      const requestedIds = new Set(workspaceIds);
      if (
        workspaceIds.length !== persistedIds.length ||
        requestedIds.size !== persistedIds.length ||
        persistedIds.some(({ id }) => !requestedIds.has(id))
      )
        throw new Error("Workspace order must contain every persisted workspace exactly once");
      workspaceIds.forEach((id, sortOrder) => {
        tx.update(workspaces).set({ sortOrder }).where(eq(workspaces.id, id)).run();
      });
    });
  }

  function rememberTask(workspaceId: string, workspacePath: string, sessionKey: string): string {
    db.insert(tasks)
      .values({ id: randomUUID(), workspaceId, workspacePath, sessionKey })
      .onConflictDoNothing({ target: tasks.sessionKey })
      .run();
    const row = db.select().from(tasks).where(eq(tasks.sessionKey, sessionKey)).get();
    if (!row) throw new Error(`Task for ${sessionKey} was not persisted`);
    return decodeTaskRow(row).id;
  }

  function task(
    id: string,
  ): { id: string; workspaceId: string; workspacePath: string; sessionKey: string } | undefined {
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? decodeTaskRow(row) : undefined;
  }

  function acceptPrompt(input: ActionInput): ActionOutcome {
    return recordAction(input, "prompt", (state) => {
      if (state.run?.requiresAcknowledgement)
        throw ActionProtocolError.make({
          code: "interrupted_run",
          message: "A crash-interrupted run must be acknowledged before starting new work",
        });
      if (state.run && (state.run.status === "accepted" || state.run.status === "running"))
        throw ActionProtocolError.make({
          code: "session_busy",
          message: "A run is already active for this session",
        });
      const runId = randomUUID().replaceAll("-", "");
      return {
        runId,
        status: "accepted",
        sessionPatch: {
          runId,
          promptActionId: input.actionId,
          runStatus: "accepted",
          requiresAcknowledgement: false,
        },
      };
    });
  }

  function acceptStop(input: ActionInput & { runId: string }): ActionOutcome {
    return recordAction(input, "stop", (state) => {
      if (!state.run || state.run.runId !== input.runId)
        throw ActionProtocolError.make({
          code: "run_mismatch",
          message: "Stop no longer targets the active run",
        });
      if (state.run.status !== "accepted" && state.run.status !== "running")
        throw ActionProtocolError.make({
          code: "run_mismatch",
          message: "The targeted run is no longer active",
        });
      return { runId: input.runId, status: "accepted", sessionPatch: { runStatus: "running" } };
    });
  }

  function acceptRunMutation(
    input: ActionInput & { runId: string; kind: "steer" | "follow-up" },
  ): ActionOutcome {
    return recordAction(input, input.kind, (state) => {
      if (
        !state.run ||
        state.run.runId !== input.runId ||
        (state.run.status !== "accepted" && state.run.status !== "running")
      ) {
        throw ActionProtocolError.make({
          code: "run_mismatch",
          message: "The queued instruction no longer targets an active run",
        });
      }
      return { runId: input.runId, status: "accepted" };
    });
  }

  function acceptSessionMutation(
    input: ActionInput & { kind: "clear-queue" | "compact" | "config" | "dialog" | "rename" },
  ): ActionOutcome {
    return recordAction(input, input.kind, (state) => ({
      runId: state.run?.runId ?? randomUUID().replaceAll("-", ""),
      status: "accepted",
    }));
  }

  function acknowledgeInterrupted(input: ActionInput): ActionOutcome {
    return recordAction(input, "acknowledge", (state) => {
      if (!state.run || !state.run.requiresAcknowledgement || state.run.status !== "interrupted")
        throw ActionProtocolError.make({
          code: "run_mismatch",
          message: "There is no interrupted run awaiting acknowledgement",
        });
      return {
        runId: state.run.runId,
        status: "completed",
        sessionPatch: { requiresAcknowledgement: false },
      };
    });
  }

  function recordAction(
    input: ActionInput,
    kind: ActionKind,
    decide: (state: { revision: number; run?: RunOutcome }) => {
      runId: string;
      status: ActionStatus;
      sessionPatch?: Partial<typeof sessionState.$inferInsert>;
    },
  ): ActionOutcome {
    return db.transaction(
      (tx) => {
        const replay = findReplay(tx, input, kind);
        if (replay) return replay;
        const state = readSessionState(tx, input.sessionKey);
        assertCurrentRevision(state.revision, input.expectedRevision);
        const { runId, status, sessionPatch } = decide(state);
        const revision = state.revision + 1;
        const now = new Date().toISOString();
        tx.insert(actions)
          .values({
            actionId: input.actionId,
            clientId: input.clientId,
            sessionKey: input.sessionKey,
            kind,
            requestDigest: input.requestDigest,
            runId,
            status,
            revision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.update(sessionState)
          .set({ revision, updatedAt: now, ...sessionPatch })
          .where(eq(sessionState.sessionKey, input.sessionKey))
          .run();
        return {
          accepted: true,
          actionId: input.actionId,
          runId,
          status,
          revision,
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  }

  function markPromptStatus(sessionKey: string, runId: string, status: ActionStatus) {
    const now = new Date().toISOString();
    db.transaction(
      (tx) => {
        tx.update(actions)
          .set({ status, updatedAt: now })
          .where(
            and(
              eq(actions.sessionKey, sessionKey),
              eq(actions.runId, runId),
              eq(actions.kind, "prompt"),
              inArray(actions.status, ["accepted", "running"]),
            ),
          )
          .run();
        tx.update(sessionState)
          .set({
            runStatus: status,
            requiresAcknowledgement: status === "interrupted",
            updatedAt: now,
          })
          .where(
            and(
              eq(sessionState.sessionKey, sessionKey),
              eq(sessionState.runId, runId),
              inArray(sessionState.runStatus, ["accepted", "running", "stopping"]),
            ),
          )
          .run();
      },
      { behavior: "immediate" },
    );
  }

  function markActionStatus(actionId: string, status: ActionStatus) {
    db.update(actions)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(actions.actionId, actionId))
      .run();
  }

  function close() {
    sqlite.close();
  }

  function readSessionState(
    executor: MetadataExecutor,
    sessionKey: string,
  ): { revision: number; run?: RunOutcome } {
    ensureSession(executor, sessionKey);
    const persistedRow = executor
      .select()
      .from(sessionState)
      .where(eq(sessionState.sessionKey, sessionKey))
      .get();
    if (!persistedRow) throw new Error(`Session ${sessionKey} was not initialized`);
    const row = decodeSessionStateRow(persistedRow);
    if (!row.runId || !row.promptActionId || !row.runStatus) return { revision: row.revision };
    if (row.runStatus === "stopping")
      throw new Error(`Session ${sessionKey} retained an unrecovered stopping state`);
    return {
      revision: row.revision,
      run: {
        runId: row.runId,
        actionId: row.promptActionId,
        status: row.runStatus,
        requiresAcknowledgement: row.requiresAcknowledgement,
      },
    };
  }

  function ensureSession(executor: MetadataExecutor, sessionKey: string) {
    executor
      .insert(sessionState)
      .values({ sessionKey, revision: 0, updatedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  function hasWorkspaceColumn(name: string) {
    return (
      sqlite
        .prepare("SELECT name FROM pragma_table_info('workspaces') WHERE name = ?")
        .get(name) !== undefined
    );
  }

  function ensureWorkspaceSortOrder() {
    if (hasWorkspaceColumn("sort_order")) return;
    sqlite.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      UPDATE workspaces
      SET sort_order = (
        SELECT position
        FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY opened_at DESC, id) - 1 AS position
          FROM workspaces
        ) AS ranked
        WHERE ranked.id = workspaces.id
      );
      COMMIT;
    `);
  }

  function addWorkspaceColumn(name: string, ddl: string) {
    if (hasWorkspaceColumn(name)) return;
    sqlite.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE workspaces ADD COLUMN ${ddl};
      COMMIT;
    `);
  }

  function pruneWorkspaceHistory() {
    sqlite.exec(`
      UPDATE workspaces
      SET listed = 0
      WHERE listed = 1 AND id NOT IN (
        SELECT id
        FROM workspaces
        WHERE listed = 1
        ORDER BY opened_at DESC, id
        LIMIT ${MAX_RECENT_WORKSPACES}
      );
    `);
  }

  function findReplay(
    executor: MetadataExecutor,
    input: Pick<ActionInput, "actionId" | "clientId" | "sessionKey" | "requestDigest">,
    kind: ActionKind,
  ): ActionOutcome | undefined {
    const persistedRow = executor
      .select()
      .from(actions)
      .where(eq(actions.actionId, input.actionId))
      .get();
    if (!persistedRow) return undefined;
    const row = decodeActionRow(persistedRow);
    if (
      row.clientId !== input.clientId ||
      row.sessionKey !== input.sessionKey ||
      row.kind !== kind ||
      row.requestDigest !== input.requestDigest
    ) {
      throw ActionProtocolError.make({
        code: "action_conflict",
        message: "This action ID was already used for a different request",
      });
    }
    return {
      accepted: true,
      actionId: row.actionId,
      runId: row.runId,
      status: row.status,
      revision: row.revision,
      replayed: true,
    };
  }

  return {
    workspaceId: findWorkspaceId,
    sessionState: (sessionKey: string) => readSessionState(db, sessionKey),
    rememberWorkspace,
    recent,
    workspaceProjectId,
    forgetWorkspace,
    reorderWorkspaces,
    rememberTask,
    task,
    acceptPrompt,
    acceptStop,
    acceptRunMutation,
    acceptSessionMutation,
    acknowledgeInterrupted,
    markPromptStatus,
    markActionStatus,
    close,
  };
}

export type MetadataStore = ReturnType<typeof makeMetadataStore>;

function assertCurrentRevision(currentRevision: number, expectedRevision: number) {
  if (currentRevision !== expectedRevision)
    throw ActionProtocolError.make({
      code: "stale_revision",
      message: `Session changed (expected revision ${expectedRevision}, current revision ${currentRevision})`,
    });
}

function makeMetadataService(store: MetadataStore): MetadataService {
  const meta = <A extends unknown[], R>(op: string, f: (...a: A) => R) =>
    Effect.fn(`Metadata.${op}`)((...a: A) => attemptMetadata(op, () => f(...a)));
  const act = <A extends unknown[], R>(op: string, f: (...a: A) => R) =>
    Effect.fn(`Metadata.${op}`)((...a: A) => attemptAction(op, () => f(...a)));
  return {
    rememberWorkspace: meta("rememberWorkspace", store.rememberWorkspace),
    workspaceId: meta("workspaceId", store.workspaceId),
    recent: meta("recent", store.recent),
    workspaceProjectId: meta("workspaceProjectId", store.workspaceProjectId),
    forgetWorkspace: meta("forgetWorkspace", store.forgetWorkspace),
    reorderWorkspaces: meta("reorderWorkspaces", (workspaceIds: ReadonlyArray<string>) =>
      store.reorderWorkspaces([...workspaceIds]),
    ),
    rememberTask: meta("rememberTask", store.rememberTask),
    task: meta("task", store.task),
    sessionState: meta("sessionState", store.sessionState),
    acceptPrompt: act("acceptPrompt", store.acceptPrompt),
    acceptStop: act("acceptStop", store.acceptStop),
    acceptRunMutation: act("acceptRunMutation", store.acceptRunMutation),
    acceptSessionMutation: act("acceptSessionMutation", store.acceptSessionMutation),
    acknowledgeInterrupted: act("acknowledgeInterrupted", store.acknowledgeInterrupted),
    markPromptStatus: meta("markPromptStatus", store.markPromptStatus),
    markActionStatus: meta("markActionStatus", store.markActionStatus),
  };
}

function attemptMetadata<A>(operation: string, evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) => metadataError(operation, cause),
  });
}

function attemptAction<A>(operation: string, evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof ActionProtocolError ? cause : metadataError(operation, cause),
  });
}

function metadataError(operation: string, cause: unknown) {
  return MetadataError.make({ operation, message: failureMessage(operation, cause), cause });
}

type MetadataDatabase = ReturnType<typeof drizzle>;
type MetadataTransaction = Parameters<Parameters<MetadataDatabase["transaction"]>[0]>[0];
type MetadataExecutor = MetadataDatabase | MetadataTransaction;

const actionStatuses = [
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
] as const satisfies ReadonlyArray<ActionOutcome["status"]>;
type ActionStatus = ActionOutcome["status"];
type PersistedRunStatus = ActionStatus | "stopping";

const actionKinds = [
  "prompt",
  "stop",
  "steer",
  "follow-up",
  "clear-queue",
  "compact",
  "config",
  "dialog",
  "rename",
  "acknowledge",
] as const;
type ActionKind = (typeof actionKinds)[number];

const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull().unique(),
    openedAt: text("opened_at").notNull(),
    sortOrder: integer("sort_order").notNull(),
    listed: integer("listed", { mode: "boolean" }).notNull().default(true),
    sourceWorkspaceId: text("source_workspace_id"),
  },
  (table) => [index("workspaces_order_idx").on(table.listed, table.sortOrder, table.id)],
);

const sessionState = sqliteTable("session_state", {
  sessionKey: text("session_key").primaryKey(),
  revision: integer("revision").notNull().default(0),
  runId: text("run_id"),
  promptActionId: text("prompt_action_id"),
  runStatus: text("run_status").$type<PersistedRunStatus>(),
  requiresAcknowledgement: integer("requires_acknowledgement", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: text("updated_at").notNull(),
});

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  workspacePath: text("workspace_path").notNull(),
  sessionKey: text("session_key").notNull().unique(),
});

const actions = sqliteTable(
  "actions",
  {
    actionId: text("action_id").primaryKey(),
    clientId: text("client_id").notNull(),
    sessionKey: text("session_key").notNull(),
    kind: text("kind").$type<ActionKind>().notNull(),
    requestDigest: text("request_digest").notNull(),
    runId: text("run_id").notNull(),
    status: text("status").$type<ActionStatus>().notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("actions_prompt_idx").on(table.sessionKey, table.runId, table.kind)],
);

const workspaceRowSchema = createSelectSchema(workspaces);
const taskRowSchema = createSelectSchema(tasks);
const sessionStateRowSchema = createSelectSchema(sessionState, {
  runStatus: Schema.NullOr(Schema.Literals([...actionStatuses, "stopping"])),
});
const actionRowSchema = createSelectSchema(actions, {
  kind: Schema.Literals([...actionKinds]),
  status: Schema.Literals([...actionStatuses]),
});

const decodeWorkspaceRow = Schema.decodeUnknownSync(workspaceRowSchema);
const decodeTaskRow = Schema.decodeUnknownSync(taskRowSchema);
const decodeSessionStateRow = Schema.decodeUnknownSync(sessionStateRowSchema);
const decodeActionRow = Schema.decodeUnknownSync(actionRowSchema);

const METADATA_SCHEMA_SQL = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    opened_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    listed INTEGER NOT NULL DEFAULT 1,
    source_workspace_id TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    session_key TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS session_state (
    session_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    prompt_action_id TEXT,
    run_status TEXT,
    requires_acknowledgement INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  DROP INDEX IF EXISTS actions_session_idx;
  CREATE INDEX IF NOT EXISTS actions_prompt_idx ON actions(session_key, run_id, kind);
`;

const WORKSPACE_ORDER_INDEX_SQL = `
  DROP INDEX IF EXISTS workspaces_recent_idx;
  DROP INDEX IF EXISTS workspaces_order_idx;
  CREATE INDEX workspaces_order_idx ON workspaces(listed, sort_order, id);
`;
