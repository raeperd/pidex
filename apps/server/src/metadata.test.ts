import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, eq, notLike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionProtocolError, MetadataStore, requestDigest } from "./metadata.js";

describe("metadata store", () => {
  let store: MetadataStore | undefined;
  afterEach(() => {
    store?.close();
    vi.useRealTimers();
  });

  it("marks an accepted run interrupted after restart and requires acknowledgement", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-metadata-"));
    store = new MetadataStore();
    const request = {
      actionId: "actioncrash0001",
      clientId: "clientcrash001",
      expectedRevision: 0,
      requestDigest: requestDigest({ text: "work" }),
      sessionKey: "session-crash",
    };
    const accepted = store.acceptPrompt(request);
    store.markPromptStatus(request.sessionKey, accepted.runId, "running");
    store.close();
    store = new MetadataStore();

    expect(store.sessionState(request.sessionKey)).toEqual({
      revision: 1,
      run: {
        runId: accepted.runId,
        actionId: request.actionId,
        status: "interrupted",
        requiresAcknowledgement: true,
      },
    });
    expect(() =>
      store!.acceptPrompt({ ...request, actionId: "actionblocked01", expectedRevision: 1 }),
    ).toThrowError(ActionProtocolError);
    const acknowledged = store.acknowledgeInterrupted({
      ...request,
      actionId: "actionacknow001",
      expectedRevision: 1,
      requestDigest: requestDigest({ acknowledge: accepted.runId }),
    });
    expect(acknowledged).toMatchObject({ status: "completed", revision: 2 });
    expect(store.sessionState(request.sessionKey).run?.requiresAcknowledgement).toBe(false);
  });

  it("looks up a known workspace without changing its recent-order metadata", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-workspace-"));
    store = new MetadataStore();
    expect(store.workspaceId("/tmp/example-project")).toBeUndefined();
    const id = store.rememberWorkspace("/tmp/example-project");
    expect(store.rememberWorkspace("/tmp/example-project")).toBe(id);
    expect(store.workspaceId("/tmp/example-project")).toBe(id);
    expect(store.recent()).toEqual([{ id, path: "/tmp/example-project" }]);
  });

  it("persists a manually reordered workspace list across restarts", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-workspace-order-"));
    store = new MetadataStore();
    const first = store.rememberWorkspace("/tmp/first-project");
    const second = store.rememberWorkspace("/tmp/second-project");
    const third = store.rememberWorkspace("/tmp/third-project");

    store.reorderWorkspaces([third, first, second]);
    store.close();
    store = new MetadataStore();

    expect(store.recent()).toEqual([
      { id: third, path: "/tmp/third-project" },
      { id: first, path: "/tmp/first-project" },
      { id: second, path: "/tmp/second-project" },
    ]);
  });

  it("keeps a newly remembered workspace inside the 100-project ordering boundary", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-workspace-limit-"));
    store = new MetadataStore();
    for (let index = 0; index < 100; index += 1) store.rememberWorkspace(`/tmp/project-${index}`);

    const newestId = store.rememberWorkspace("/tmp/project-100");
    const recent = store.recent();

    expect(recent).toHaveLength(100);
    expect(recent.at(-1)).toEqual({ id: newestId, path: "/tmp/project-100" });
    expect(() => store!.reorderWorkspaces(recent.map(({ id }) => id).toReversed())).not.toThrow();
  });

  it("refreshes recency without changing manual order when reopening a workspace", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-workspace-recency-"));
    vi.useFakeTimers();
    const metadata = new MetadataStore();
    store = metadata;
    const remembered = Array.from({ length: 100 }, (_, index) => {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
      const workspacePath = `/tmp/recency-project-${index}`;
      return { id: metadata.rememberWorkspace(workspacePath), path: workspacePath };
    });
    const first = remembered[0];
    const second = remembered[1];
    if (!first || !second) throw new Error("Expected at least two remembered workspaces");
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 1)));

    expect(metadata.rememberWorkspace(first.path)).toBe(first.id);
    expect(metadata.recent()[0]).toEqual(first);
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 2)));
    metadata.rememberWorkspace("/tmp/recency-project-100");

    expect(metadata.recent()).toContainEqual(first);
    expect(metadata.recent()).not.toContainEqual(second);
  });

  it("preserves the durable ID of a project evicted from the sidebar", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-workspace-id-"));
    const metadata = new MetadataStore();
    store = metadata;
    const remembered = Array.from({ length: 100 }, (_, index) => {
      const workspacePath = `/tmp/durable-project-${index}`;
      return { id: metadata.rememberWorkspace(workspacePath), path: workspacePath };
    });
    metadata.rememberWorkspace("/tmp/durable-project-100");
    const recentPaths = new Set(metadata.recent().map(({ path: workspacePath }) => workspacePath));
    const evicted = remembered.find(({ path: workspacePath }) => !recentPaths.has(workspacePath));
    if (!evicted) throw new Error("Expected one workspace to leave the sidebar history");
    metadata.close();
    const reopened = new MetadataStore();
    store = reopened;

    expect(reopened.workspaceId(evicted.path)).toBe(evicted.id);
    expect(reopened.rememberWorkspace(evicted.path)).toBe(evicted.id);
    expect(reopened.recent()).toContainEqual(evicted);
  });

  it("rolls back a failed legacy workspace-order migration", async () => {
    store = undefined;
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pidex-workspace-migration-"));
    process.env.PIDEX_STATE_DIR = stateDir;
    const databasePath = path.join(stateDir, "pidex.sqlite");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        opened_at TEXT NOT NULL
      );
      INSERT INTO workspaces VALUES ('workspace_legacy', '/tmp/legacy', '2026-01-01T00:00:00Z');
      CREATE TRIGGER block_workspace_order
      BEFORE UPDATE ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace order migration blocked');
      END;
    `);
    legacyDatabase.close();

    expect(() => new MetadataStore()).toThrow(/workspace order migration blocked/);

    const inspection = new DatabaseSync(databasePath);
    const sortOrderColumn = inspection
      .prepare("SELECT name FROM pragma_table_info('workspaces') WHERE name = 'sort_order'")
      .get();
    inspection.close();
    expect(sortOrderColumn).toBeUndefined();
  });

  it("assigns one durable task ID to a native Pi session", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-task-"));
    store = new MetadataStore();

    const workspaceId = store.rememberWorkspace("/tmp/task-project");
    const taskId = store.rememberTask(workspaceId, "/tmp/task-project", "/sessions/task.jsonl");
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.rememberTask(workspaceId, "/tmp/task-project", "/sessions/task.jsonl")).toBe(
      taskId,
    );
    expect(store.task(taskId)).toEqual({
      id: taskId,
      workspaceId,
      workspacePath: "/tmp/task-project",
      sessionKey: "/sessions/task.jsonl",
    });

    store.close();
    store = new MetadataStore();
    expect(store.rememberTask(workspaceId, "/tmp/task-project", "/sessions/task.jsonl")).toBe(
      taskId,
    );
  });

  it("persists action transitions and replays through Drizzle transactions", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-actions-"));
    store = new MetadataStore();
    const promptRequest = {
      actionId: "actionprompt001",
      clientId: "clientactions01",
      expectedRevision: 0,
      requestDigest: requestDigest({ text: "work" }),
      sessionKey: "session-actions",
    };
    const prompt = store.acceptPrompt(promptRequest);
    expect(store.acceptPrompt(promptRequest)).toMatchObject({ replayed: true, revision: 1 });

    const steerRequest = {
      ...promptRequest,
      actionId: "actionsteer0001",
      expectedRevision: 1,
      requestDigest: requestDigest({ text: "adjust" }),
      runId: prompt.runId,
      kind: "steer" as const,
    };
    expect(store.acceptRunMutation(steerRequest)).toMatchObject({ revision: 2, replayed: false });
    store.markActionStatus(steerRequest.actionId, "completed");
    expect(store.acceptRunMutation(steerRequest)).toMatchObject({
      status: "completed",
      revision: 2,
      replayed: true,
    });

    const stop = store.acceptStop({
      ...promptRequest,
      actionId: "actionstop00001",
      expectedRevision: 2,
      requestDigest: requestDigest({ runId: prompt.runId }),
      runId: prompt.runId,
    });
    expect(stop).toMatchObject({ revision: 3, replayed: false });
    expect(store.sessionState(promptRequest.sessionKey).run?.status).toBe("running");

    store.markPromptStatus(promptRequest.sessionKey, prompt.runId, "completed");
    expect(store.sessionState(promptRequest.sessionKey).run?.status).toBe("completed");
    expect(
      store.acceptSessionMutation({
        ...promptRequest,
        actionId: "actionrename001",
        expectedRevision: 3,
        requestDigest: requestDigest({ name: "renamed" }),
        kind: "rename",
      }),
    ).toMatchObject({ revision: 4, replayed: false });
  });

  it("rejects conflicting actions without consuming a revision", async () => {
    process.env.PIDEX_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "pidex-conflicts-"));
    store = new MetadataStore();
    const request = {
      actionId: "actionconflict01",
      clientId: "clientconflict1",
      expectedRevision: 0,
      requestDigest: requestDigest({ text: "original" }),
      sessionKey: "session-conflicts",
    };
    store.acceptPrompt(request);

    expect(() =>
      store!.acceptPrompt({ ...request, requestDigest: requestDigest({ text: "changed" }) }),
    ).toThrowError(expect.objectContaining({ code: "action_conflict" }));
    expect(() =>
      store!.acceptSessionMutation({
        ...request,
        actionId: "actionstale0001",
        kind: "rename",
        requestDigest: requestDigest({ name: "stale" }),
      }),
    ).toThrowError(expect.objectContaining({ code: "stale_revision" }));
    expect(store.sessionState(request.sessionKey).revision).toBe(1);
  });

  it("initializes only the product tables without a migration backup", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pidex-schema-"));
    process.env.PIDEX_STATE_DIR = stateDir;
    store = new MetadataStore();
    store.close();
    store = new MetadataStore();

    const database = new DatabaseSync(path.join(stateDir, "pidex.sqlite"), { readOnly: true });
    const tables = drizzle({ client: database })
      .select({ name: sqliteMaster.name })
      .from(sqliteMaster)
      .where(and(eq(sqliteMaster.type, "table"), notLike(sqliteMaster.name, "sqlite_%")))
      .orderBy(sqliteMaster.name)
      .all();
    database.close();

    expect(tables).toEqual([
      { name: "actions" },
      { name: "session_state" },
      { name: "tasks" },
      { name: "workspaces" },
    ]);
    expect(existsSync(path.join(stateDir, "pidex.sqlite.pre-continuity-v1.backup"))).toBe(false);
  });

  it("rolls back crash recovery when either durable update fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pidex-recovery-"));
    process.env.PIDEX_STATE_DIR = stateDir;
    store = new MetadataStore();
    const request = {
      actionId: "actionrecovery01",
      clientId: "clientrecovery1",
      expectedRevision: 0,
      requestDigest: requestDigest({ text: "recover" }),
      sessionKey: "session-recovery",
    };
    const accepted = store.acceptPrompt(request);
    store.markPromptStatus(request.sessionKey, accepted.runId, "running");
    store.close();
    store = undefined;

    const databasePath = path.join(stateDir, "pidex.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER block_session_recovery
      BEFORE UPDATE OF run_status ON session_state
      WHEN NEW.run_status = 'interrupted'
      BEGIN
        SELECT RAISE(ABORT, 'recovery blocked');
      END;
    `);
    database.close();

    expect(() => new MetadataStore()).toThrow(/Failed query: update "session_state"/);

    const inspection = new DatabaseSync(databasePath);
    const action = inspection
      .prepare("SELECT status FROM actions WHERE action_id = ?")
      .get(request.actionId) as { status: string };
    const session = inspection
      .prepare("SELECT run_status FROM session_state WHERE session_key = ?")
      .get(request.sessionKey) as { run_status: string };
    expect(action.status).toBe("running");
    expect(session.run_status).toBe("running");
    inspection.exec("DROP TRIGGER block_session_recovery");
    inspection.close();

    store = new MetadataStore();
    expect(store.sessionState(request.sessionKey).run).toMatchObject({
      status: "interrupted",
      requiresAcknowledgement: true,
    });
  });
});

const sqliteMaster = sqliteTable("sqlite_master", {
  type: text("type").notNull(),
  name: text("name").notNull(),
});
