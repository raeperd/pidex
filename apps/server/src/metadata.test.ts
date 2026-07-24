import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("initializes only the product tables without a migration backup", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pidex-schema-"));
    process.env.PIDEX_STATE_DIR = stateDir;
    store = new MetadataStore();
    store.close();
    store = new MetadataStore();

    const database = new DatabaseSync(path.join(stateDir, "pidex.sqlite"), { readOnly: true });
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
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
