import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_RECENT_WORKSPACES, type ActionOutcome, type RunOutcome } from "@pidex/api";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ActionProtocolError } from "./errors.js";

export { ActionProtocolError } from "./errors.js";

interface ActionInput {
  actionId: string;
  clientId: string;
  expectedRevision: number;
  requestDigest: string;
  sessionKey: string;
}

export const requestDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class MetadataStore {
  private readonly sqlite: DatabaseSync;
  private readonly db: MetadataDatabase;

  constructor() {
    const dir = process.env.PIDEX_STATE_DIR ?? path.join(os.homedir(), ".pidex");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path.join(dir, "pidex.sqlite"));
    try {
      this.sqlite.exec(METADATA_SCHEMA_SQL);
      this.ensureWorkspaceSortOrder();
      this.ensureWorkspaceListed();
      this.ensureWorkspaceSource();
      this.pruneWorkspaceHistory();
      this.sqlite.exec(WORKSPACE_ORDER_INDEX_SQL);
      this.db = createMetadataDatabase(this.sqlite);

      // A process death cannot prove whether Pi completed after the last durable update.
      // Preserve that ambiguity and require an explicit acknowledgement before new work.
      this.db.transaction(
        (tx) => {
          tx.update(actions)
            .set({ status: "interrupted", updatedAt: sql`datetime('now')` })
            .where(
              and(eq(actions.kind, "prompt"), inArray(actions.status, ["accepted", "running"])),
            )
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
      this.sqlite.close();
      throw error;
    }
  }

  rememberWorkspace(canonicalPath: string, sourceWorkspaceId?: string): string {
    return this.db.transaction((tx) => {
      const existing = tx
        .select({ id: workspaces.id, listed: workspaces.listed })
        .from(workspaces)
        .where(eq(workspaces.path, canonicalPath))
        .get();
      const openedAt = new Date().toISOString();
      if (existing?.listed) {
        tx.update(workspaces)
          .set({ openedAt, ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}) })
          .where(eq(workspaces.id, existing.id))
          .run();
        return existing.id;
      }
      const retained = tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.listed, true))
        .limit(MAX_RECENT_WORKSPACES)
        .all();
      if (retained.length === MAX_RECENT_WORKSPACES) {
        const oldest = tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.listed, true))
          .orderBy(workspaces.openedAt, workspaces.id)
          .limit(1)
          .get();
        if (oldest)
          tx.update(workspaces).set({ listed: false }).where(eq(workspaces.id, oldest.id)).run();
      }
      const last = tx
        .select({ sortOrder: workspaces.sortOrder })
        .from(workspaces)
        .where(eq(workspaces.listed, true))
        .orderBy(desc(workspaces.sortOrder))
        .limit(1)
        .get();
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
      const row = tx
        .insert(workspaces)
        .values({
          id: randomUUID().replaceAll("-", ""),
          path: canonicalPath,
          openedAt,
          sortOrder,
          listed: true,
          ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
        })
        .returning({ id: workspaces.id })
        .get();
      if (!row) throw new Error(`Workspace ${canonicalPath} was not persisted`);
      return row.id;
    });
  }

  workspaceId(canonicalPath: string): string | undefined {
    return this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.path, canonicalPath))
      .get()?.id;
  }

  recent(): Array<{ id: string; path: string; sourceWorkspaceId?: string }> {
    return this.db
      .select({
        id: workspaces.id,
        path: workspaces.path,
        sourceWorkspaceId: workspaces.sourceWorkspaceId,
      })
      .from(workspaces)
      .where(eq(workspaces.listed, true))
      .orderBy(workspaces.sortOrder, workspaces.id)
      .limit(MAX_RECENT_WORKSPACES)
      .all()
      .map(({ id, path: workspacePath, sourceWorkspaceId }) => ({
        id,
        path: workspacePath,
        ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
      }));
  }

  workspaceProjectId(workspaceId: string): string {
    const row = this.db
      .select({ sourceWorkspaceId: workspaces.sourceWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    return row?.sourceWorkspaceId ?? workspaceId;
  }

  reorderWorkspaces(workspaceIds: string[]): void {
    this.db.transaction((tx) => {
      const persistedIds = tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.listed, true))
        .all();
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

  rememberTask(workspaceId: string, workspacePath: string, sessionKey: string): string {
    this.db
      .insert(tasks)
      .values({ id: randomUUID(), workspaceId, workspacePath, sessionKey })
      .onConflictDoNothing({ target: tasks.sessionKey })
      .run();
    const row = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.sessionKey, sessionKey))
      .get();
    if (!row) throw new Error(`Task for ${sessionKey} was not persisted`);
    return row.id;
  }

  task(
    id: string,
  ): { id: string; workspaceId: string; workspacePath: string; sessionKey: string } | undefined {
    return this.db
      .select({
        id: tasks.id,
        workspaceId: tasks.workspaceId,
        workspacePath: tasks.workspacePath,
        sessionKey: tasks.sessionKey,
      })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
  }

  sessionState(sessionKey: string): { revision: number; run?: RunOutcome } {
    return this.readSessionState(this.db, sessionKey);
  }

  acceptPrompt(input: ActionInput): ActionOutcome {
    return this.db.transaction(
      (tx) => {
        const replay = this.replay(tx, input, "prompt");
        if (replay) return replay;
        const state = this.readSessionState(tx, input.sessionKey);
        this.assertCurrentRevision(state.revision, input.expectedRevision);
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
        const revision = state.revision + 1;
        const now = new Date().toISOString();
        tx.insert(actions)
          .values({
            actionId: input.actionId,
            clientId: input.clientId,
            sessionKey: input.sessionKey,
            kind: "prompt",
            requestDigest: input.requestDigest,
            runId,
            status: "accepted",
            revision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.update(sessionState)
          .set({
            revision,
            runId,
            promptActionId: input.actionId,
            runStatus: "accepted",
            requiresAcknowledgement: false,
            updatedAt: now,
          })
          .where(eq(sessionState.sessionKey, input.sessionKey))
          .run();
        return {
          accepted: true,
          actionId: input.actionId,
          runId,
          status: "accepted",
          revision,
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  }

  acceptStop(input: ActionInput & { runId: string }): ActionOutcome {
    return this.db.transaction(
      (tx) => {
        const replay = this.replay(tx, input, "stop");
        if (replay) return replay;
        const state = this.readSessionState(tx, input.sessionKey);
        this.assertCurrentRevision(state.revision, input.expectedRevision);
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

        const revision = state.revision + 1;
        const now = new Date().toISOString();
        tx.insert(actions)
          .values({
            actionId: input.actionId,
            clientId: input.clientId,
            sessionKey: input.sessionKey,
            kind: "stop",
            requestDigest: input.requestDigest,
            runId: input.runId,
            status: "accepted",
            revision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.update(sessionState)
          .set({ revision, runStatus: "running", updatedAt: now })
          .where(eq(sessionState.sessionKey, input.sessionKey))
          .run();
        return {
          accepted: true,
          actionId: input.actionId,
          runId: input.runId,
          status: "accepted",
          revision,
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  }

  acceptRunMutation(
    input: ActionInput & { runId: string; kind: "steer" | "follow-up" },
  ): ActionOutcome {
    return this.db.transaction(
      (tx) => {
        const replay = this.replay(tx, input, input.kind);
        if (replay) return replay;
        const state = this.readSessionState(tx, input.sessionKey);
        this.assertCurrentRevision(state.revision, input.expectedRevision);
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
        const revision = state.revision + 1;
        const now = new Date().toISOString();
        tx.insert(actions)
          .values({
            actionId: input.actionId,
            clientId: input.clientId,
            sessionKey: input.sessionKey,
            kind: input.kind,
            requestDigest: input.requestDigest,
            runId: input.runId,
            status: "accepted",
            revision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.update(sessionState)
          .set({ revision, updatedAt: now })
          .where(eq(sessionState.sessionKey, input.sessionKey))
          .run();
        return {
          accepted: true,
          actionId: input.actionId,
          runId: input.runId,
          status: "accepted",
          revision,
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  }

  acceptSessionMutation(
    input: ActionInput & { kind: "clear-queue" | "compact" | "config" | "dialog" | "rename" },
  ): ActionOutcome {
    return this.db.transaction(
      (tx) => {
        const replay = this.replay(tx, input, input.kind);
        if (replay) return replay;
        const state = this.readSessionState(tx, input.sessionKey);
        this.assertCurrentRevision(state.revision, input.expectedRevision);
        const revision = state.revision + 1;
        const actionRunId = state.run?.runId ?? randomUUID().replaceAll("-", "");
        const now = new Date().toISOString();
        tx.insert(actions)
          .values({
            actionId: input.actionId,
            clientId: input.clientId,
            sessionKey: input.sessionKey,
            kind: input.kind,
            requestDigest: input.requestDigest,
            runId: actionRunId,
            status: "accepted",
            revision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.update(sessionState)
          .set({ revision, updatedAt: now })
          .where(eq(sessionState.sessionKey, input.sessionKey))
          .run();
        return {
          accepted: true,
          actionId: input.actionId,
          runId: actionRunId,
          status: "accepted",
          revision,
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  }

  acknowledgeInterrupted(input: ActionInput): ActionOutcome {
    return this.db.transaction(
      (tx) => {
        const replay = this.replay(tx, input, "acknowledge");
        if (replay) return replay;
        const state = this.readSessionState(tx, input.sessionKey);
        this.assertCurrentRevision(state.revision, input.expectedRevision);
        if (!state.run || !state.run.requiresAcknowledgement || state.run.status !== "interrupted")
          throw ActionProtocolError.make({
            code: "run_mismatch",
            message: "There is no interrupted run awaiting acknowledgement",
          });

        const revision = state.revision + 1;
        const now = new Date().toISOString();
        tx.insert(actions)
          .values({
            actionId: input.actionId,
            clientId: input.clientId,
            sessionKey: input.sessionKey,
            kind: "acknowledge",
            requestDigest: input.requestDigest,
            runId: state.run!.runId,
            status: "completed",
            revision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.update(sessionState)
          .set({ revision, requiresAcknowledgement: false, updatedAt: now })
          .where(eq(sessionState.sessionKey, input.sessionKey))
          .run();
        return {
          accepted: true,
          actionId: input.actionId,
          runId: state.run.runId,
          status: "completed",
          revision,
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  }

  markPromptStatus(sessionKey: string, runId: string, status: ActionStatus) {
    const now = new Date().toISOString();
    this.db.transaction(
      (tx) => {
        tx.update(actions)
          .set({ status, updatedAt: now })
          .where(
            and(
              eq(actions.sessionKey, sessionKey),
              eq(actions.runId, runId),
              eq(actions.kind, "prompt"),
            ),
          )
          .run();
        tx.update(sessionState)
          .set({
            runStatus: status,
            requiresAcknowledgement: status === "interrupted",
            updatedAt: now,
          })
          .where(and(eq(sessionState.sessionKey, sessionKey), eq(sessionState.runId, runId)))
          .run();
      },
      { behavior: "immediate" },
    );
  }

  markActionStatus(actionId: string, status: ActionStatus) {
    this.db
      .update(actions)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(actions.actionId, actionId))
      .run();
  }

  close() {
    this.sqlite.close();
  }

  private readSessionState(
    db: MetadataExecutor,
    sessionKey: string,
  ): { revision: number; run?: RunOutcome } {
    this.ensureSession(db, sessionKey);
    const row = db
      .select({
        revision: sessionState.revision,
        runId: sessionState.runId,
        promptActionId: sessionState.promptActionId,
        runStatus: sessionState.runStatus,
        requiresAcknowledgement: sessionState.requiresAcknowledgement,
      })
      .from(sessionState)
      .where(eq(sessionState.sessionKey, sessionKey))
      .get();
    if (!row) throw new Error(`Session ${sessionKey} was not initialized`);
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

  private ensureSession(db: MetadataExecutor, sessionKey: string) {
    db.insert(sessionState)
      .values({ sessionKey, revision: 0, updatedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  private ensureWorkspaceSortOrder() {
    const column = this.sqlite
      .prepare("SELECT name FROM pragma_table_info('workspaces') WHERE name = 'sort_order'")
      .get();
    if (column) return;
    this.sqlite.exec(`
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

  private ensureWorkspaceListed() {
    const column = this.sqlite
      .prepare("SELECT name FROM pragma_table_info('workspaces') WHERE name = 'listed'")
      .get();
    if (column) return;
    this.sqlite.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE workspaces ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
      COMMIT;
    `);
  }

  private ensureWorkspaceSource() {
    const column = this.sqlite
      .prepare(
        "SELECT name FROM pragma_table_info('workspaces') WHERE name = 'source_workspace_id'",
      )
      .get();
    if (column) return;
    this.sqlite.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE workspaces ADD COLUMN source_workspace_id TEXT;
      COMMIT;
    `);
  }

  private pruneWorkspaceHistory() {
    this.sqlite.exec(`
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

  private replay(
    db: MetadataExecutor,
    input: Pick<ActionInput, "actionId" | "clientId" | "sessionKey" | "requestDigest">,
    kind: ActionKind,
  ): ActionOutcome | undefined {
    const row = db
      .select({
        actionId: actions.actionId,
        clientId: actions.clientId,
        sessionKey: actions.sessionKey,
        kind: actions.kind,
        requestDigest: actions.requestDigest,
        runId: actions.runId,
        status: actions.status,
        revision: actions.revision,
      })
      .from(actions)
      .where(eq(actions.actionId, input.actionId))
      .get();
    if (!row) return undefined;
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

  private assertCurrentRevision(currentRevision: number, expectedRevision: number) {
    if (currentRevision !== expectedRevision)
      throw ActionProtocolError.make({
        code: "stale_revision",
        message: `Session changed (expected revision ${expectedRevision}, current revision ${currentRevision})`,
      });
  }
}

function createMetadataDatabase(sqlite: DatabaseSync) {
  return drizzle({ client: sqlite });
}

type MetadataDatabase = ReturnType<typeof createMetadataDatabase>;
type MetadataTransaction = Parameters<Parameters<MetadataDatabase["transaction"]>[0]>[0];
type MetadataExecutor = MetadataDatabase | MetadataTransaction;

type ActionStatus = ActionOutcome["status"];
type PersistedRunStatus = ActionStatus | "stopping";

type ActionKind =
  | "prompt"
  | "stop"
  | "steer"
  | "follow-up"
  | "clear-queue"
  | "compact"
  | "config"
  | "dialog"
  | "rename"
  | "acknowledge";

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
