import { oc, type RouterContractClient } from "@orpc/contract";
import * as v from "valibot";

export { safeParse } from "valibot";

export const PROTOCOL_VERSION = 10;
export const MAX_RECENT_WORKSPACES = 100;
const idSchema = v.pipe(v.string(), v.minLength(8), v.maxLength(128), v.regex(/^[A-Za-z0-9_-]+$/));
const thinkingLevelSchema = v.picklist(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const runStatusSchema = v.picklist(["idle", "running", "stopping", "compacting", "error"]);
const actionStatusSchema = v.picklist([
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
const runOutcomeSchema = v.object({
  runId: idSchema,
  actionId: idSchema,
  status: actionStatusSchema,
  requiresAcknowledgement: v.boolean(),
});
export const actionOutcomeSchema = v.object({
  accepted: v.literal(true),
  actionId: idSchema,
  runId: idSchema,
  status: actionStatusSchema,
  revision: nonnegativeInteger(),
  replayed: v.boolean(),
});
const modelSchema = v.object({
  id: boundedString(200),
  provider: boundedString(100),
  name: boundedString(200),
  reasoning: v.boolean(),
});
export const sessionStatusSchema = v.picklist(["running", "error", "idle"]);
export const sessionSummarySchema = v.object({
  id: idSchema,
  name: v.optional(boundedString(300)),
  firstMessage: boundedString(500),
  createdAt: v.string(),
  modifiedAt: v.string(),
  messageCount: nonnegativeInteger(),
  status: v.optional(sessionStatusSchema),
});
const workspaceSchema = v.object({
  id: idSchema,
  path: boundedString(4096),
  name: boundedString(300),
  trusted: v.nullable(v.boolean()),
  protectedResourcesSkipped: v.boolean(),
  resourceDiagnostics: v.pipe(
    v.array(v.object({ level: v.picklist(["warning", "error"]), message: boundedString(1000) })),
    v.maxLength(50),
  ),
  models: v.array(modelSchema),
  sessions: v.array(sessionSummarySchema),
  commands: v.array(v.object({ name: v.string(), description: v.optional(v.string()) })),
});
const recentWorkspaceSchema = v.object({
  id: idSchema,
  path: boundedString(4096),
  sourceWorkspaceId: v.optional(idSchema),
  worktree: v.optional(v.boolean()),
});
const projectCandidateSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  path: boundedString(4096),
});
export const healthSchema = v.object({
  ok: v.literal(true),
  protocolVersion: v.literal(PROTOCOL_VERSION),
});
const bootstrapSchema = v.object({
  protocolVersion: v.literal(PROTOCOL_VERSION),
  csrfToken: v.pipe(v.string(), v.minLength(32)),
  piVersion: boundedString(100),
  recentWorkspaces: v.pipe(v.array(recentWorkspaceSchema), v.maxLength(MAX_RECENT_WORKSPACES)),
  projectCandidates: v.pipe(v.array(projectCandidateSchema), v.maxLength(200)),
  warning: boundedString(1000),
});
const sessionsResponseSchema = v.object({ sessions: v.array(sessionSummarySchema) });
const okResponseSchema = v.object({ ok: v.literal(true) });
const textItemSchema = v.object({
  type: v.picklist(["user", "assistant"]),
  id: boundedString(200),
  text: boundedString(1_000_000),
  thinking: v.optional(boundedString(1_000_000)),
  complete: v.boolean(),
  timestamp: v.string(),
});
const skillItemSchema = v.object({
  type: v.literal("skill"),
  id: boundedString(200),
  name: boundedString(64),
  content: boundedString(1_000_000),
  timestamp: v.string(),
});
const toolItemSchema = v.object({
  type: v.literal("tool"),
  id: boundedString(200),
  name: boundedString(200),
  argumentSummary: boundedString(1000),
  state: v.picklist(["running", "success", "error"]),
  preview: boundedString(16_384),
  truncated: v.boolean(),
  resourceId: v.optional(idSchema),
  outputSize: v.optional(nonnegativeInteger()),
});
const noticeItemSchema = v.object({
  type: v.literal("notice"),
  id: boundedString(200),
  level: v.picklist(["info", "warning", "error"]),
  text: boundedString(4000),
});
const transcriptItemSchema = v.variant("type", [
  textItemSchema,
  skillItemSchema,
  toolItemSchema,
  noticeItemSchema,
]);
const extensionDialogSchema = v.object({
  id: idSchema,
  kind: v.picklist(["select", "confirm", "input", "editor"]),
  title: boundedString(500),
  message: v.optional(boundedString(4000)),
  options: v.optional(v.pipe(v.array(boundedString(500)), v.maxLength(100))),
  placeholder: v.optional(boundedString(500)),
  prefill: v.optional(boundedString(20_000)),
});
const statsSchema = v.object({
  messages: finiteNumber(),
  toolCalls: finiteNumber(),
  tokens: finiteNumber(),
  cost: finiteNumber(),
  subscription: v.boolean(),
});
export const contextUsageSchema = v.object({
  tokens: v.nullable(nonnegativeInteger()),
  contextWindow: positiveInteger(),
  percent: v.nullable(v.pipe(finiteNumber(), v.minValue(0))),
  totalProcessedTokens: nonnegativeInteger(),
  compactsAutomatically: v.boolean(),
});
const chatSnapshotSchema = v.object({
  chatId: idSchema,
  workspaceId: idSchema,
  taskId: idSchema,
  sessionName: v.optional(boundedString(300)),
  revision: nonnegativeInteger(),
  run: v.optional(runOutcomeSchema),
  runStatus: runStatusSchema,
  model: v.optional(boundedString(300)),
  thinkingLevel: thinkingLevelSchema,
  items: v.pipe(v.array(transcriptItemSchema), v.maxLength(200)),
  transcriptStart: nonnegativeInteger(),
  transcriptTotal: nonnegativeInteger(),
  steeringQueue: v.array(boundedString(20_000)),
  followUpQueue: v.array(boundedString(20_000)),
  stats: statsSchema,
  contextUsage: v.optional(contextUsageSchema),
  extensionDialog: v.optional(extensionDialogSchema),
});
const eventBase = v.object({ eventId: positiveInteger(), chatId: idSchema });
export const serverEventSchema = v.variant("type", [
  v.object({
    ...eventBase.entries,
    type: v.literal("snapshot"),
    snapshot: chatSnapshotSchema,
  }),
  v.object({
    ...eventBase.entries,
    type: v.literal("message"),
    item: v.union([textItemSchema, skillItemSchema]),
  }),
  v.object({
    ...eventBase.entries,
    type: v.literal("text_delta"),
    itemId: v.string(),
    delta: boundedString(32_768),
    channel: v.picklist(["text", "thinking"]),
  }),
  v.object({ ...eventBase.entries, type: v.literal("tool"), item: toolItemSchema }),
  v.object({
    ...eventBase.entries,
    type: v.literal("run_status"),
    status: runStatusSchema,
    revision: nonnegativeInteger(),
    run: v.optional(runOutcomeSchema),
  }),
  v.object({
    ...eventBase.entries,
    type: v.literal("queue"),
    steering: v.array(v.string()),
    followUp: v.array(v.string()),
  }),
  v.object({ ...eventBase.entries, type: v.literal("notice"), item: noticeItemSchema }),
  v.object({
    ...eventBase.entries,
    type: v.literal("session"),
    name: v.optional(v.string()),
    stats: statsSchema,
  }),
  v.object({
    ...eventBase.entries,
    type: v.literal("context_usage"),
    usage: contextUsageSchema,
  }),
  v.object({
    ...eventBase.entries,
    type: v.literal("extension_dialog"),
    dialog: v.optional(extensionDialogSchema),
  }),
]);
export const wsClientMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("hello"),
    protocolVersion: v.literal(PROTOCOL_VERSION),
    chatId: idSchema,
    lastEventId: v.optional(nonnegativeInteger()),
  }),
  v.object({ type: v.literal("ack"), eventId: positiveInteger() }),
  v.object({ type: v.literal("pong") }),
]);
export const terminalClientMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("hello"),
    chatId: idSchema,
    cols: v.pipe(v.number(), v.safeInteger(), v.minValue(2), v.maxValue(500)),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(300)),
  }),
  v.object({ type: v.literal("input"), data: boundedString(64 * 1024) }),
  v.object({
    type: v.literal("resize"),
    cols: v.pipe(v.number(), v.safeInteger(), v.minValue(2), v.maxValue(500)),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(300)),
  }),
  v.object({ type: v.literal("kill") }),
]);
export const terminalServerMessageSchema = v.variant("type", [
  v.object({ type: v.literal("ready"), shell: boundedString(4096), cwd: boundedString(4096) }),
  v.object({ type: v.literal("output"), data: boundedString(1024 * 1024) }),
  v.object({ type: v.literal("exit"), code: v.pipe(v.number(), v.safeInteger()) }),
  v.object({ type: v.literal("error"), message: boundedString(4096) }),
]);
const openWorkspaceSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  remember: v.optional(v.boolean()),
});
const reorderWorkspacesSchema = v.object({
  workspaceIds: v.pipe(v.array(idSchema), v.maxLength(MAX_RECENT_WORKSPACES)),
});
const recentWorkspacesResponseSchema = v.object({
  recentWorkspaces: v.pipe(v.array(recentWorkspaceSchema), v.maxLength(MAX_RECENT_WORKSPACES)),
});
const trustWorkspaceSchema = v.object({ trusted: v.boolean() });
const resumeChatSchema = v.object({ taskId: idSchema });
const actionRequestSchema = v.object({
  chatId: idSchema,
  clientId: idSchema,
  actionId: idSchema,
  expectedRevision: nonnegativeInteger(),
});
export const messageRequestSchema = v.object({
  ...actionRequestSchema.entries,
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(20_000),
    v.check((value) => value.trim().length > 0, "Prompt cannot be blank"),
  ),
  delivery: v.picklist(["normal", "steer", "follow-up"]),
  runId: v.optional(idSchema),
});
const abortRequestSchema = v.object({ ...actionRequestSchema.entries, runId: idSchema });
export const configRequestSchema = v.pipe(
  v.object({
    ...actionRequestSchema.entries,
    model: v.optional(boundedString(300)),
    thinkingLevel: v.optional(thinkingLevelSchema),
  }),
  v.check(
    (value) => value.model !== undefined || value.thinkingLevel !== undefined,
    "At least one configuration field is required",
  ),
);
export const renameRequestSchema = v.object({
  ...actionRequestSchema.entries,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});
const compactRequestSchema = v.object({
  ...actionRequestSchema.entries,
  instructions: v.optional(boundedString(4000)),
});
const dialogResponseSchema = v.object({
  ...actionRequestSchema.entries,
  requestId: idSchema,
  value: v.union([boundedString(20_000), v.boolean(), v.null()]),
});
const toolOutputChunkSchema = v.object({
  resourceId: idSchema,
  offset: nonnegativeInteger(),
  nextOffset: nonnegativeInteger(),
  total: nonnegativeInteger(),
  text: boundedString(16_384),
  complete: v.boolean(),
  sourceTruncated: v.boolean(),
});
const transcriptPageSchema = v.object({
  items: v.pipe(v.array(transcriptItemSchema), v.maxLength(100)),
  start: nonnegativeInteger(),
  total: nonnegativeInteger(),
});

const emptyInputSchema = v.object({});
const chatIdInputSchema = v.object({ chatId: idSchema });
const workspaceIdInputSchema = v.object({ workspaceId: idSchema });
const toolOutputInputSchema = v.object({
  chatId: idSchema,
  resourceId: idSchema,
  offset: v.optional(nonnegativeInteger(), 0),
  limit: v.optional(positiveInteger(), 16_384),
});
const transcriptInputSchema = v.object({
  chatId: idSchema,
  before: v.optional(nonnegativeInteger(), 0),
  limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)), 50),
});

export const pidexApiContract = {
  system: {
    health: oc.input(emptyInputSchema).output(healthSchema),
    bootstrap: oc.input(emptyInputSchema).output(bootstrapSchema),
  },
  workspaces: {
    open: oc.input(openWorkspaceSchema).output(workspaceSchema),
    createWorktree: oc.input(workspaceIdInputSchema).output(workspaceSchema),
    removeWorktree: oc.input(workspaceIdInputSchema).output(okResponseSchema),
    reorder: oc.input(reorderWorkspacesSchema).output(recentWorkspacesResponseSchema),
    sessions: oc.input(workspaceIdInputSchema).output(sessionsResponseSchema),
    trust: oc
      .input(v.object({ ...trustWorkspaceSchema.entries, workspaceId: idSchema }))
      .output(workspaceSchema),
  },
  chats: {
    create: oc.input(workspaceIdInputSchema).output(chatSnapshotSchema),
    resume: oc.input(resumeChatSchema).output(chatSnapshotSchema),
    get: oc.input(chatIdInputSchema).output(chatSnapshotSchema),
    dispose: oc.input(chatIdInputSchema).output(okResponseSchema),
    sendMessage: oc.input(messageRequestSchema).output(actionOutcomeSchema),
    abort: oc.input(abortRequestSchema).output(actionOutcomeSchema),
    acknowledgeInterrupted: oc.input(actionRequestSchema).output(actionOutcomeSchema),
    toolOutput: oc.input(toolOutputInputSchema).output(toolOutputChunkSchema),
    transcript: oc.input(transcriptInputSchema).output(transcriptPageSchema),
    clearQueue: oc.input(actionRequestSchema).output(chatSnapshotSchema),
    configure: oc.input(configRequestSchema).output(chatSnapshotSchema),
    rename: oc.input(renameRequestSchema).output(chatSnapshotSchema),
    compact: oc.input(compactRequestSchema).output(chatSnapshotSchema),
    answerDialog: oc.input(dialogResponseSchema).output(okResponseSchema),
  },
};

export type PidexApiContractClient = RouterContractClient<typeof pidexApiContract>;

export type ModelInfo = v.InferOutput<typeof modelSchema>;
export type SessionStatus = v.InferOutput<typeof sessionStatusSchema>;
export type SessionSummary = v.InferOutput<typeof sessionSummarySchema>;
export type Workspace = v.InferOutput<typeof workspaceSchema>;
export type RecentWorkspace = v.InferOutput<typeof recentWorkspaceSchema>;
export type ProjectCandidate = v.InferOutput<typeof projectCandidateSchema>;
export type Bootstrap = v.InferOutput<typeof bootstrapSchema>;
export type TranscriptItem = v.InferOutput<typeof transcriptItemSchema>;
export type TextItem = v.InferOutput<typeof textItemSchema>;
export type SkillItem = v.InferOutput<typeof skillItemSchema>;
export type ToolItem = v.InferOutput<typeof toolItemSchema>;
export type ExtensionDialog = v.InferOutput<typeof extensionDialogSchema>;
export type ChatSnapshot = v.InferOutput<typeof chatSnapshotSchema>;
export type ContextUsage = v.InferOutput<typeof contextUsageSchema>;
export type ActionOutcome = v.InferOutput<typeof actionOutcomeSchema>;
export type RunOutcome = v.InferOutput<typeof runOutcomeSchema>;
export type ToolOutputChunk = v.InferOutput<typeof toolOutputChunkSchema>;
export type TranscriptPage = v.InferOutput<typeof transcriptPageSchema>;
export type ServerEvent = v.InferOutput<typeof serverEventSchema>;
export type TerminalClientMessage = v.InferOutput<typeof terminalClientMessageSchema>;
export type TerminalServerMessage = v.InferOutput<typeof terminalServerMessageSchema>;

function boundedString(maximum: number) {
  return v.pipe(v.string(), v.maxLength(maximum));
}

function nonnegativeInteger() {
  return v.pipe(v.number(), v.safeInteger(), v.minValue(0));
}

function positiveInteger() {
  return v.pipe(v.number(), v.safeInteger(), v.minValue(1));
}

function finiteNumber() {
  return v.pipe(v.number(), v.finite());
}
