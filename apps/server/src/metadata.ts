import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionOutcome, RunOutcome } from "@pidex/api";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import {
  actions,
  sessionState,
  workspaces,
  type ActionKind,
  type ActionStatus,
} from "./metadata-schema.js";

interface ActionInput {
  actionId: string;
  clientId: string;
  expectedRevision: number;
  requestDigest: string;
  sessionKey: string;
}

export class ActionProtocolError extends Error {
  readonly status = 409;
  constructor(
    readonly code:
      | "action_conflict"
      | "stale_revision"
      | "session_busy"
      | "run_mismatch"
      | "interrupted_run",
    message: string,
  ) {
    super(message);
  }
}

export const requestDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class MetadataStore {
  private readonly sqlite: DatabaseSync;
  private readonly db: ReturnType<typeof createMetadataDatabase>;

  constructor() {
    const dir = process.env.PIDEX_STATE_DIR ?? path.join(os.homedir(), ".pidex");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path.join(dir, "pidex.sqlite"));
    this.sqlite.exec(METADATA_SCHEMA_SQL);
    this.db = createMetadataDatabase(this.sqlite);

    // A process death cannot prove whether Pi completed after the last durable update.
    // Preserve that ambiguity and require an explicit acknowledgement before new work.
    this.db
      .update(actions)
      .set({ status: "interrupted", updatedAt: sql`datetime('now')` })
      .where(and(eq(actions.kind, "prompt"), inArray(actions.status, ["accepted", "running"])))
      .run();
    this.db
      .update(sessionState)
      .set({
        runStatus: "interrupted",
        requiresAcknowledgement: true,
        updatedAt: sql`datetime('now')`,
      })
      .where(inArray(sessionState.runStatus, ["accepted", "running", "stopping"]))
      .run();
  }

  rememberWorkspace(canonicalPath: string): string {
    const row = this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.path, canonicalPath))
      .get();
    const id = row?.id ?? randomUUID().replaceAll("-", "");
    const openedAt = new Date().toISOString();
    this.db
      .insert(workspaces)
      .values({ id, path: canonicalPath, openedAt })
      .onConflictDoUpdate({ target: workspaces.path, set: { openedAt } })
      .run();
    return id;
  }

  workspaceId(canonicalPath: string): string | undefined {
    return this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.path, canonicalPath))
      .get()?.id;
  }

  recent(): Array<{ id: string; path: string }> {
    return this.db
      .select({ id: workspaces.id, path: workspaces.path })
      .from(workspaces)
      .orderBy(desc(workspaces.openedAt))
      .limit(100)
      .all();
  }

  sessionState(sessionKey: string): { revision: number; run?: RunOutcome } {
    this.ensureSession(sessionKey);
    const row = this.db
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

  acceptPrompt(input: ActionInput): ActionOutcome {
    const replay = this.replay(input, "prompt");
    if (replay) return replay;
    const state = this.sessionState(input.sessionKey);
    this.assertCurrentRevision(state.revision, input.expectedRevision);
    if (state.run?.requiresAcknowledgement)
      throw new ActionProtocolError(
        "interrupted_run",
        "A crash-interrupted run must be acknowledged before starting new work",
      );
    if (state.run && (state.run.status === "accepted" || state.run.status === "running"))
      throw new ActionProtocolError("session_busy", "A run is already active for this session");

    const runId = randomUUID().replaceAll("-", "");
    const revision = state.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(
      (tx) => {
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
      },
      { behavior: "immediate" },
    );
    return {
      accepted: true,
      actionId: input.actionId,
      runId,
      status: "accepted",
      revision,
      replayed: false,
    };
  }

  acceptStop(input: ActionInput & { runId: string }): ActionOutcome {
    const replay = this.replay(input, "stop");
    if (replay) return replay;
    const state = this.sessionState(input.sessionKey);
    this.assertCurrentRevision(state.revision, input.expectedRevision);
    if (!state.run || state.run.runId !== input.runId)
      throw new ActionProtocolError("run_mismatch", "Stop no longer targets the active run");
    if (state.run.status !== "accepted" && state.run.status !== "running")
      throw new ActionProtocolError("run_mismatch", "The targeted run is no longer active");

    const revision = state.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(
      (tx) => {
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
      },
      { behavior: "immediate" },
    );
    return {
      accepted: true,
      actionId: input.actionId,
      runId: input.runId,
      status: "accepted",
      revision,
      replayed: false,
    };
  }

  acceptRunMutation(
    input: ActionInput & { runId: string; kind: "steer" | "follow-up" },
  ): ActionOutcome {
    const replay = this.replay(input, input.kind);
    if (replay) return replay;
    const state = this.sessionState(input.sessionKey);
    this.assertCurrentRevision(state.revision, input.expectedRevision);
    if (
      !state.run ||
      state.run.runId !== input.runId ||
      (state.run.status !== "accepted" && state.run.status !== "running")
    ) {
      throw new ActionProtocolError(
        "run_mismatch",
        "The queued instruction no longer targets an active run",
      );
    }
    const revision = state.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(
      (tx) => {
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
      },
      { behavior: "immediate" },
    );
    return {
      accepted: true,
      actionId: input.actionId,
      runId: input.runId,
      status: "accepted",
      revision,
      replayed: false,
    };
  }

  acceptSessionMutation(
    input: ActionInput & { kind: "clear-queue" | "compact" | "config" | "dialog" | "rename" },
  ): ActionOutcome {
    const replay = this.replay(input, input.kind);
    if (replay) return replay;
    const state = this.sessionState(input.sessionKey);
    this.assertCurrentRevision(state.revision, input.expectedRevision);
    const revision = state.revision + 1;
    const actionRunId = state.run?.runId ?? randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    this.db.transaction(
      (tx) => {
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
      },
      { behavior: "immediate" },
    );
    return {
      accepted: true,
      actionId: input.actionId,
      runId: actionRunId,
      status: "accepted",
      revision,
      replayed: false,
    };
  }

  acknowledgeInterrupted(input: ActionInput): ActionOutcome {
    const replay = this.replay(input, "acknowledge");
    if (replay) return replay;
    const state = this.sessionState(input.sessionKey);
    this.assertCurrentRevision(state.revision, input.expectedRevision);
    if (!state.run || !state.run.requiresAcknowledgement || state.run.status !== "interrupted")
      throw new ActionProtocolError(
        "run_mismatch",
        "There is no interrupted run awaiting acknowledgement",
      );

    const revision = state.revision + 1;
    const now = new Date().toISOString();
    this.db.transaction(
      (tx) => {
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
      },
      { behavior: "immediate" },
    );
    return {
      accepted: true,
      actionId: input.actionId,
      runId: state.run.runId,
      status: "completed",
      revision,
      replayed: false,
    };
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

  private ensureSession(sessionKey: string) {
    this.db
      .insert(sessionState)
      .values({ sessionKey, revision: 0, updatedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  private replay(
    input: Pick<ActionInput, "actionId" | "clientId" | "sessionKey" | "requestDigest">,
    kind: ActionKind,
  ): ActionOutcome | undefined {
    const row = this.db
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
      throw new ActionProtocolError(
        "action_conflict",
        "This action ID was already used for a different request",
      );
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
      throw new ActionProtocolError(
        "stale_revision",
        `Session changed (expected revision ${expectedRevision}, current revision ${currentRevision})`,
      );
  }
}

function createMetadataDatabase(sqlite: DatabaseSync) {
  return drizzle({ client: sqlite });
}

const METADATA_SCHEMA_SQL = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    opened_at TEXT NOT NULL
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
  CREATE INDEX IF NOT EXISTS actions_session_idx ON actions(session_key, created_at DESC);
`;
