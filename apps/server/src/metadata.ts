import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionOutcome, RunOutcome } from "@pidex/api";

type ActionStatus = ActionOutcome["status"];

interface ActionInput {
  actionId: string;
  clientId: string;
  expectedRevision: number;
  requestDigest: string;
  sessionKey: string;
}

interface ActionRow {
  action_id: string;
  client_id: string;
  session_key: string;
  kind: string;
  request_digest: string;
  run_id: string;
  status: ActionStatus;
  revision: number;
}

interface SessionRow {
  revision: number;
  run_id: string | null;
  prompt_action_id: string | null;
  run_status: ActionStatus | null;
  requires_acknowledgement: number;
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
  private db: DatabaseSync;

  constructor() {
    const dir = process.env.PIDEX_STATE_DIR ?? path.join(os.homedir(), ".pidex");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const databasePath = path.join(dir, "pidex.sqlite");
    const migrationBackup = path.join(dir, "pidex.sqlite.pre-continuity-v1.backup");
    if (existsSync(databasePath) && !existsSync(migrationBackup))
      copyFileSync(databasePath, migrationBackup, 0);
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
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
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, datetime('now'));
    `);

    // A process death cannot prove whether Pi completed after the last durable update.
    // Preserve that ambiguity and require an explicit acknowledgement before new work.
    this.db.exec(`
      UPDATE actions
      SET status='interrupted', updated_at=datetime('now')
      WHERE kind='prompt' AND status IN ('accepted', 'running');
      UPDATE session_state
      SET run_status='interrupted', requires_acknowledgement=1, updated_at=datetime('now')
      WHERE run_status IN ('accepted', 'running', 'stopping');
    `);
  }

  rememberWorkspace(canonicalPath: string): string {
    const row = this.db.prepare("SELECT id FROM workspaces WHERE path=?").get(canonicalPath) as
      | { id: string }
      | undefined;
    const id = row?.id ?? randomUUID().replaceAll("-", "");
    this.db
      .prepare(
        "INSERT INTO workspaces(id,path,opened_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET opened_at=excluded.opened_at",
      )
      .run(id, canonicalPath, new Date().toISOString());
    return id;
  }

  workspaceId(canonicalPath: string): string | undefined {
    return (
      this.db.prepare("SELECT id FROM workspaces WHERE path=?").get(canonicalPath) as
        | { id: string }
        | undefined
    )?.id;
  }

  recent(): Array<{ id: string; path: string }> {
    return this.db
      .prepare("SELECT id,path FROM workspaces ORDER BY opened_at DESC LIMIT 100")
      .all() as Array<{ id: string; path: string }>;
  }

  sessionState(sessionKey: string): { revision: number; run?: RunOutcome } {
    this.ensureSession(sessionKey);
    const row = this.db
      .prepare(
        "SELECT revision,run_id,prompt_action_id,run_status,requires_acknowledgement FROM session_state WHERE session_key=?",
      )
      .get(sessionKey) as unknown as SessionRow;
    if (!row.run_id || !row.prompt_action_id || !row.run_status) return { revision: row.revision };
    return {
      revision: row.revision,
      run: {
        runId: row.run_id,
        actionId: row.prompt_action_id,
        status: row.run_status,
        requiresAcknowledgement: Boolean(row.requires_acknowledgement),
      },
    };
  }

  acceptPrompt(input: ActionInput): ActionOutcome {
    const replay = this.replay(input, "prompt");
    if (replay) return replay;
    const state = this.sessionState(input.sessionKey);
    if (state.revision !== input.expectedRevision)
      throw new ActionProtocolError(
        "stale_revision",
        `Session changed (expected revision ${input.expectedRevision}, current revision ${state.revision})`,
      );
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
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO actions(action_id,client_id,session_key,kind,request_digest,run_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.actionId,
          input.clientId,
          input.sessionKey,
          "prompt",
          input.requestDigest,
          runId,
          "accepted",
          revision,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE session_state SET revision=?,run_id=?,prompt_action_id=?,run_status='accepted',requires_acknowledgement=0,updated_at=? WHERE session_key=?",
        )
        .run(revision, runId, input.actionId, now, input.sessionKey);
    });
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
    if (state.revision !== input.expectedRevision)
      throw new ActionProtocolError(
        "stale_revision",
        `Session changed (expected revision ${input.expectedRevision}, current revision ${state.revision})`,
      );
    if (!state.run || state.run.runId !== input.runId)
      throw new ActionProtocolError("run_mismatch", "Stop no longer targets the active run");
    if (state.run.status !== "accepted" && state.run.status !== "running")
      throw new ActionProtocolError("run_mismatch", "The targeted run is no longer active");

    const revision = state.revision + 1;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO actions(action_id,client_id,session_key,kind,request_digest,run_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.actionId,
          input.clientId,
          input.sessionKey,
          "stop",
          input.requestDigest,
          input.runId,
          "accepted",
          revision,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE session_state SET revision=?,run_status='running',updated_at=? WHERE session_key=?",
        )
        .run(revision, now, input.sessionKey);
    });
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
    if (state.revision !== input.expectedRevision)
      throw new ActionProtocolError(
        "stale_revision",
        `Session changed (expected revision ${input.expectedRevision}, current revision ${state.revision})`,
      );
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
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO actions(action_id,client_id,session_key,kind,request_digest,run_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.actionId,
          input.clientId,
          input.sessionKey,
          input.kind,
          input.requestDigest,
          input.runId,
          "accepted",
          revision,
          now,
          now,
        );
      this.db
        .prepare("UPDATE session_state SET revision=?,updated_at=? WHERE session_key=?")
        .run(revision, now, input.sessionKey);
    });
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
    if (state.revision !== input.expectedRevision)
      throw new ActionProtocolError(
        "stale_revision",
        `Session changed (expected revision ${input.expectedRevision}, current revision ${state.revision})`,
      );
    const revision = state.revision + 1;
    const actionRunId = state.run?.runId ?? randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO actions(action_id,client_id,session_key,kind,request_digest,run_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.actionId,
          input.clientId,
          input.sessionKey,
          input.kind,
          input.requestDigest,
          actionRunId,
          "accepted",
          revision,
          now,
          now,
        );
      this.db
        .prepare("UPDATE session_state SET revision=?,updated_at=? WHERE session_key=?")
        .run(revision, now, input.sessionKey);
    });
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
    if (state.revision !== input.expectedRevision)
      throw new ActionProtocolError(
        "stale_revision",
        `Session changed (expected revision ${input.expectedRevision}, current revision ${state.revision})`,
      );
    if (!state.run || !state.run.requiresAcknowledgement || state.run.status !== "interrupted")
      throw new ActionProtocolError(
        "run_mismatch",
        "There is no interrupted run awaiting acknowledgement",
      );

    const revision = state.revision + 1;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO actions(action_id,client_id,session_key,kind,request_digest,run_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.actionId,
          input.clientId,
          input.sessionKey,
          "acknowledge",
          input.requestDigest,
          state.run!.runId,
          "completed",
          revision,
          now,
          now,
        );
      this.db
        .prepare(
          "UPDATE session_state SET revision=?,requires_acknowledgement=0,updated_at=? WHERE session_key=?",
        )
        .run(revision, now, input.sessionKey);
    });
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
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE actions SET status=?,updated_at=? WHERE session_key=? AND run_id=? AND kind='prompt'",
        )
        .run(status, now, sessionKey, runId);
      this.db
        .prepare(
          "UPDATE session_state SET run_status=?,requires_acknowledgement=?,updated_at=? WHERE session_key=? AND run_id=?",
        )
        .run(status, status === "interrupted" ? 1 : 0, now, sessionKey, runId);
    });
  }

  markActionStatus(actionId: string, status: ActionStatus) {
    this.db
      .prepare("UPDATE actions SET status=?,updated_at=? WHERE action_id=?")
      .run(status, new Date().toISOString(), actionId);
  }

  close() {
    this.db.close();
  }

  private ensureSession(sessionKey: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO session_state(session_key,revision,updated_at) VALUES(?,0,?)")
      .run(sessionKey, new Date().toISOString());
  }

  private replay(
    input: Pick<ActionInput, "actionId" | "clientId" | "sessionKey" | "requestDigest">,
    kind: string,
  ): ActionOutcome | undefined {
    const row = this.db
      .prepare(
        "SELECT action_id,client_id,session_key,kind,request_digest,run_id,status,revision FROM actions WHERE action_id=?",
      )
      .get(input.actionId) as ActionRow | undefined;
    if (!row) return undefined;
    if (
      row.client_id !== input.clientId ||
      row.session_key !== input.sessionKey ||
      row.kind !== kind ||
      row.request_digest !== input.requestDigest
    ) {
      throw new ActionProtocolError(
        "action_conflict",
        "This action ID was already used for a different request",
      );
    }
    return {
      accepted: true,
      actionId: row.action_id,
      runId: row.run_id,
      status: row.status,
      revision: row.revision,
      replayed: true,
    };
  }

  private transaction(work: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
