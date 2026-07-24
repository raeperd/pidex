import { z } from "zod";

export const PROTOCOL_VERSION = 2 as const;
export const idSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const toolModeSchema = z.enum(["read-only", "full"]);
export const runStatusSchema = z.enum(["idle", "running", "stopping", "compacting", "error"]);
export const actionStatusSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
export const runOutcomeSchema = z.object({
  runId: idSchema,
  actionId: idSchema,
  status: actionStatusSchema,
  requiresAcknowledgement: z.boolean(),
});
export const actionOutcomeSchema = z.object({
  accepted: z.literal(true),
  actionId: idSchema,
  runId: idSchema,
  status: actionStatusSchema,
  revision: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export const modelSchema = z.object({
  id: z.string().max(200),
  provider: z.string().max(100),
  name: z.string().max(200),
  reasoning: z.boolean(),
});
export const sessionSummarySchema = z.object({
  id: idSchema,
  name: z.string().max(300).optional(),
  firstMessage: z.string().max(500),
  createdAt: z.string(),
  modifiedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
});
export const workspaceSchema = z.object({
  id: idSchema,
  path: z.string().max(4096),
  name: z.string().max(300),
  trusted: z.boolean().nullable(),
  protectedResourcesSkipped: z.boolean(),
  resourceDiagnostics: z
    .array(z.object({ level: z.enum(["warning", "error"]), message: z.string().max(1000) }))
    .max(50),
  models: z.array(modelSchema),
  sessions: z.array(sessionSummarySchema),
  commands: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});
export const recentWorkspaceSchema = z.object({ id: idSchema, path: z.string().max(4096) });
export const projectCandidateSchema = z.object({
  name: z.string().min(1).max(300),
  path: z.string().max(4096),
});
export const healthSchema = z.object({
  ok: z.literal(true),
  adapter: z.literal("real"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export const bootstrapSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  csrfToken: z.string().min(32),
  adapter: z.literal("real"),
  piVersion: z.string().max(100),
  recentWorkspaces: z.array(recentWorkspaceSchema),
  projectCandidates: z.array(projectCandidateSchema).max(200),
  warning: z.string().max(1000),
});
export const sessionsResponseSchema = z.object({ sessions: z.array(sessionSummarySchema) });
export const okResponseSchema = z.object({ ok: z.literal(true) });
export const acceptedResponseSchema = z.object({ accepted: z.literal(true) });
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export const textItemSchema = z.object({
  type: z.enum(["user", "assistant"]),
  id: z.string().max(200),
  text: z.string().max(1_000_000),
  thinking: z.string().max(1_000_000).optional(),
  complete: z.boolean(),
  timestamp: z.string(),
});
export const toolItemSchema = z.object({
  type: z.literal("tool"),
  id: z.string().max(200),
  name: z.string().max(200),
  argumentSummary: z.string().max(1000),
  state: z.enum(["running", "success", "error"]),
  preview: z.string().max(16_384),
  truncated: z.boolean(),
  resourceId: idSchema.optional(),
  outputSize: z.number().int().nonnegative().optional(),
});
export const noticeItemSchema = z.object({
  type: z.literal("notice"),
  id: z.string().max(200),
  level: z.enum(["info", "warning", "error"]),
  text: z.string().max(4000),
});
export const transcriptItemSchema = z.discriminatedUnion("type", [
  textItemSchema,
  toolItemSchema,
  noticeItemSchema,
]);
export const extensionDialogSchema = z.object({
  id: idSchema,
  kind: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string().max(500),
  message: z.string().max(4000).optional(),
  options: z.array(z.string().max(500)).max(100).optional(),
  placeholder: z.string().max(500).optional(),
  prefill: z.string().max(20_000).optional(),
});
const statsSchema = z.object({
  messages: z.number(),
  toolCalls: z.number(),
  tokens: z.number(),
  cost: z.number(),
});
export const chatSnapshotSchema = z.object({
  chatId: idSchema,
  workspaceId: idSchema,
  sessionId: idSchema,
  sessionName: z.string().max(300).optional(),
  revision: z.number().int().nonnegative(),
  run: runOutcomeSchema.optional(),
  runStatus: runStatusSchema,
  model: z.string().max(300).optional(),
  thinkingLevel: thinkingLevelSchema,
  toolMode: toolModeSchema,
  activeTools: z.array(z.string().max(100)),
  items: z.array(transcriptItemSchema).max(200),
  transcriptStart: z.number().int().nonnegative(),
  transcriptTotal: z.number().int().nonnegative(),
  steeringQueue: z.array(z.string().max(20_000)),
  followUpQueue: z.array(z.string().max(20_000)),
  stats: statsSchema,
  extensionDialog: extensionDialogSchema.optional(),
});
const eventBase = z.object({ eventId: z.number().int().positive(), chatId: idSchema });
export const serverEventSchema = z.discriminatedUnion("type", [
  eventBase.extend({ type: z.literal("snapshot"), snapshot: chatSnapshotSchema }),
  eventBase.extend({ type: z.literal("message"), item: textItemSchema }),
  eventBase.extend({
    type: z.literal("text_delta"),
    itemId: z.string(),
    delta: z.string().max(32_768),
    channel: z.enum(["text", "thinking"]),
  }),
  eventBase.extend({ type: z.literal("tool"), item: toolItemSchema }),
  eventBase.extend({
    type: z.literal("run_status"),
    status: runStatusSchema,
    revision: z.number().int().nonnegative(),
    run: runOutcomeSchema.optional(),
  }),
  eventBase.extend({
    type: z.literal("queue"),
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  }),
  eventBase.extend({ type: z.literal("notice"), item: noticeItemSchema }),
  eventBase.extend({ type: z.literal("session"), name: z.string().optional(), stats: statsSchema }),
  eventBase.extend({
    type: z.literal("extension_dialog"),
    dialog: extensionDialogSchema.optional(),
  }),
]);
export const wsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    chatId: idSchema,
    lastEventId: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("ack"), eventId: z.number().int().positive() }),
  z.object({ type: z.literal("pong") }),
]);
export const openWorkspaceSchema = z.object({
  path: z.string().min(1).max(4096),
  remember: z.boolean().optional(),
});
export const trustWorkspaceSchema = z.object({ trusted: z.boolean() });
export const createChatSchema = z.object({ workspaceId: idSchema });
export const resumeChatSchema = z.object({ workspaceId: idSchema, sessionId: idSchema });
export const actionRequestSchema = z.object({
  clientId: idSchema,
  actionId: idSchema,
  expectedRevision: z.number().int().nonnegative(),
});
const actionRequestBase = actionRequestSchema;
export const messageRequestSchema = actionRequestBase.extend({
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0, "Prompt cannot be blank"),
  delivery: z.enum(["normal", "steer", "follow-up"]),
  runId: idSchema.optional(),
});
export const abortRequestSchema = actionRequestBase.extend({ runId: idSchema });
export const acknowledgeInterruptedRequestSchema = actionRequestBase.pick({
  clientId: true,
  actionId: true,
  expectedRevision: true,
});
export const configRequestSchema = actionRequestBase
  .extend({
    model: z.string().max(300).optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    toolMode: toolModeSchema.optional(),
  })
  .refine(
    (value) =>
      value.model !== undefined ||
      value.thinkingLevel !== undefined ||
      value.toolMode !== undefined,
    { message: "At least one configuration field is required" },
  );
export const renameRequestSchema = actionRequestBase.extend({
  name: z.string().trim().min(1).max(200),
});
export const compactRequestSchema = actionRequestBase.extend({
  instructions: z.string().max(4000).optional(),
});
export const dialogResponseSchema = actionRequestBase.extend({
  requestId: idSchema,
  value: z.union([z.string().max(20_000), z.boolean(), z.null()]),
});
export const toolOutputChunkSchema = z.object({
  resourceId: idSchema,
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  text: z.string().max(16_384),
  complete: z.boolean(),
  sourceTruncated: z.boolean(),
});
export const transcriptPageSchema = z.object({
  items: z.array(transcriptItemSchema).max(100),
  start: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type ModelInfo = z.infer<typeof modelSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type RecentWorkspace = z.infer<typeof recentWorkspaceSchema>;
export type ProjectCandidate = z.infer<typeof projectCandidateSchema>;
export type Health = z.infer<typeof healthSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;
export type TextItem = z.infer<typeof textItemSchema>;
export type ToolItem = z.infer<typeof toolItemSchema>;
export type NoticeItem = z.infer<typeof noticeItemSchema>;
export type ExtensionDialog = z.infer<typeof extensionDialogSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type ToolOutputChunk = z.infer<typeof toolOutputChunkSchema>;
export type TranscriptPage = z.infer<typeof transcriptPageSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
