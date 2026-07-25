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
      { name: "workspaces" },
    ]);
    expect(existsSync(path.join(stateDir, "pidex.sqlite.pre-continuity-v1.backup"))).toBe(false);
  });
});

const sqliteMaster = sqliteTable("sqlite_master", {
  type: text("type").notNull(),
  name: text("name").notNull(),
});
