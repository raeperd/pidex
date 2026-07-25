import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, eq, notLike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { ActionProtocolError, MetadataStore, requestDigest } from "./metadata.js";

describe("metadata store", () => {
  let store: MetadataStore | undefined;
  afterEach(() => store?.close());

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

  it("initializes the optimized product schema without a migration backup", async () => {
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
    const indexes = drizzle({ client: database })
      .select({ name: sqliteMaster.name })
      .from(sqliteMaster)
      .where(and(eq(sqliteMaster.type, "index"), notLike(sqliteMaster.name, "sqlite_%")))
      .orderBy(sqliteMaster.name)
      .all();
    database.close();

    expect(tables).toEqual([
      { name: "actions" },
      { name: "session_state" },
      { name: "workspaces" },
    ]);
    expect(indexes).toEqual([{ name: "actions_prompt_idx" }, { name: "workspaces_recent_idx" }]);
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
