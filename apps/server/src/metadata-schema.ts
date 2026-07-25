import type { ActionOutcome } from "@pidex/api";
import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type ActionStatus = ActionOutcome["status"];
type PersistedRunStatus = ActionStatus | "stopping";

export type ActionKind =
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

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  path: text("path").notNull().unique(),
  openedAt: text("opened_at").notNull(),
});

export const sessionState = sqliteTable("session_state", {
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

export const actions = sqliteTable(
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
  (table) => [index("actions_session_idx").on(table.sessionKey, desc(table.createdAt))],
);
