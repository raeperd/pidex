import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class MetadataStore {
  private db: DatabaseSync;
  constructor() {
    const dir = process.env.PIDEX_STATE_DIR ?? path.join(os.homedir(), ".pidex"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "pidex.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, opened_at TEXT NOT NULL)");
  }
  rememberWorkspace(canonicalPath: string): string {
    const row = this.db.prepare("SELECT id FROM workspaces WHERE path=?").get(canonicalPath) as { id: string } | undefined;
    const id = row?.id ?? randomUUID().replaceAll("-", "");
    this.db.prepare("INSERT INTO workspaces(id,path,opened_at) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET opened_at=excluded.opened_at").run(id, canonicalPath, new Date().toISOString()); return id;
  }
  recent(): Array<{ id: string; path: string }> { return this.db.prepare("SELECT id,path FROM workspaces ORDER BY opened_at DESC LIMIT 12").all() as Array<{ id: string; path: string }>; }
  close() { this.db.close(); }
}
