<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { MediaQuery } from "svelte/reactivity";
  import type {
    Bootstrap,
    ChatSnapshot,
    ExtensionDialog,
    ProjectCandidate,
    RecentWorkspace,
    ServerEvent,
    ToolItem,
    Workspace,
  } from "@pidex/api";
  import { dialogValue as resolveDialogValue, PidexApiClient } from "./api-client";
  import { ChatConnection, type ConnectionState } from "./chat-connection";
  import ContextWindowMeter from "./ContextWindowMeter.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import { taskPath, TaskSnapshotCache } from "./task-navigation";
  import {
    appendPendingTextDelta,
    applyPendingTextDeltas,
    type PendingTextDeltas,
  } from "./text-deltas";

  const TASK_PREVIEW_COUNT = 6;
  const CONFIGURATION_DRAFT_PREFIX = "pidex:configuration-draft:";
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  type ChatConfiguration = Parameters<PidexApiClient["configure"]>[1];

  let bootstrap = $state.raw<Bootstrap>();
  let workspace = $state.raw<Workspace>();
  let snapshot = $state.raw<ChatSnapshot>();
  let workspaceCache = $state.raw<Record<string, Workspace>>({});
  let expandedProjectIds = $state.raw<string[]>([]);
  let taskLimits = $state.raw<Record<string, number>>({});
  let projectPath = $state("");
  let projectQuery = $state("");
  let draft = $state("");
  let search = $state("");
  let searchOpen = $state(false);
  let connection = $state<ConnectionState>("disconnected");
  let error = $state("");
  let bootstrapError = $state("");
  let drawerOpen = $state(false);
  let projectLoading = $state(false);
  let projectLoadingId = $state("");
  let projectBatchLoading = $state(false);
  let projectBatchProgress = $state(0);
  let chatLoading = $state(false);
  let routeLoading = $state(false);
  let routeReady = $state(false);
  let appliedRoute = $state("");
  let routeSequence = 0;
  let retryingConnection = $state(false);
  let loadingEarlier = $state(false);
  let delivery = $state<"steer" | "follow-up">("steer");
  let pendingPrompt = $state.raw<
    { actionId: string; text: string; delivery: "normal" | "steer" | "follow-up" } | undefined
  >();
  let configurationDrafts = $state.raw<Record<string, ChatConfiguration>>({});
  let copyState = $state.raw<Record<string, "copied" | "failed">>({});
  let toolOutputs = $state.raw<
    Record<
      string,
      {
        text: string;
        nextOffset: number;
        total: number;
        complete: boolean;
        loading: boolean;
        sourceTruncated: boolean;
        error?: string;
      }
    >
  >({});
  let transcript = $state<HTMLElement>();
  let searchInput = $state<HTMLInputElement>();
  let promptInput = $state<HTMLTextAreaElement>();
  let nearBottom = $state(true);
  let relativeNow = $state(Date.now());
  let dialogValue = $state<string | boolean>("");
  let dialogElement = $state<HTMLDialogElement>();
  let projectDialogElement = $state<HTMLDialogElement>();
  let renameDialogElement = $state<HTMLDialogElement>();
  let renameValue = $state("");
  let compactDialogElement = $state<HTMLDialogElement>();
  const mobileViewport = new MediaQuery("max-width: 900px");
  const api = new PidexApiClient();
  const snapshotCache = new TaskSnapshotCache();
  const chatConnection = new ChatConnection({
    onEvent: applyEvent,
    onInvalidChat: () => void recoverInvalidChat(),
    onStateChange: (state) => (connection = state),
  });
  let pendingTextDeltas: PendingTextDeltas = new Map();
  let pendingTextDeltaFrame: number | undefined;
  let pendingTextDeltaChatId = "";

  let routePath = $derived(page.url.pathname);
  let routeTaskId = $derived(page.params.taskId ?? "");
  $effect(() => {
    if (routeReady && routePath !== untrack(() => appliedRoute))
      void activateRoute(routePath, routeTaskId);
  });
  $effect(() => {
    if (snapshot) snapshotCache.set(snapshot);
  });
  let active = $derived(
    Boolean(snapshot && snapshot.runStatus !== "idle" && snapshot.runStatus !== "error"),
  );
  let configurationDraft = $derived(snapshot ? (configurationDrafts[snapshot.taskId] ?? {}) : {});
  let selectedModel = $derived(configurationDraft.model ?? snapshot?.model ?? "");
  let selectedThinkingLevel = $derived(
    configurationDraft.thinkingLevel ?? snapshot?.thinkingLevel ?? "medium",
  );
  let hasConfigurationDraft = $derived(
    configurationDraft.model !== undefined || configurationDraft.thinkingLevel !== undefined,
  );
  const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  function projectLabel(project: RecentWorkspace) {
    const name = projectName(project.path);
    const duplicates = (bootstrap?.recentWorkspaces ?? []).filter(
      (entry) => projectName(entry.path) === name,
    );
    if (duplicates.length < 2) return name;
    return project.path.includes("/.codex/worktrees/") ? `${name} · worktree` : `${name} · local`;
  }
  const workspaceFor = (id: string) =>
    workspaceCache[id] ?? (workspace?.id === id ? workspace : undefined);
  const projectExpanded = (id: string) => expandedProjectIds.includes(id);
  function tasksFor(project: RecentWorkspace) {
    const loaded = workspaceFor(project.id);
    if (!loaded) return [];
    const query = search.trim().toLowerCase();
    if (!query || loaded.name.toLowerCase().includes(query)) return loaded.sessions;
    return loaded.sessions.filter((session) =>
      `${session.name ?? ""} ${session.firstMessage}`.toLowerCase().includes(query),
    );
  }
  let visibleProjects = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return (bootstrap?.recentWorkspaces ?? []).filter(
      (project) =>
        !query ||
        projectName(project.path).toLowerCase().includes(query) ||
        tasksFor(project).length > 0,
    );
  });
  let availableProjects = $derived.by(() => {
    const query = projectQuery.trim().toLowerCase();
    return (bootstrap?.projectCandidates ?? []).filter(
      (candidate) => !query || candidate.name.toLowerCase().includes(query),
    );
  });
  function projectAdded(candidate: ProjectCandidate) {
    return Boolean(bootstrap?.recentWorkspaces.some((project) => project.path === candidate.path));
  }
  let currentTitle = $derived.by(() => {
    if (!snapshot) return workspace ? "No active task" : "Pidex";
    if (snapshot?.sessionName) return snapshot.sessionName;
    const firstUser = snapshot?.items.find((item) => item.type === "user");
    if (firstUser?.type === "user")
      return firstUser.text.split("\n")[0]?.slice(0, 64) || workspace?.name || "Pidex";
    return workspace?.name ?? "Pidex";
  });
  const relativeTime = (value: string) => {
    const seconds = Math.round((new Date(value).getTime() - relativeNow) / 1000);
    const absolute = Math.abs(seconds);
    const [amount, unit] =
      absolute < 60
        ? [seconds, "second"]
        : absolute < 3600
          ? [Math.round(seconds / 60), "minute"]
          : absolute < 86_400
            ? [Math.round(seconds / 3600), "hour"]
            : [Math.round(seconds / 86_400), "day"];
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" }).format(
      amount,
      unit as Intl.RelativeTimeFormatUnit,
    );
  };
  async function loadBootstrap() {
    try {
      bootstrapError = "";
      const loaded = await api.bootstrap();
      bootstrap = loaded;
      const savedPath =
        projectPath ||
        localStorage.getItem("pidex:last-project") ||
        loaded.recentWorkspaces[0]?.path ||
        "";
      projectPath = savedPath;
      if (savedPath) await openProject(savedPath, { closeDrawer: false, navigate: false });
      return true;
    } catch (cause) {
      bootstrapError = cause instanceof Error ? cause.message : "The Pidex host is unavailable";
      return false;
    }
  }
  async function recoverInvalidChat() {
    persistDraft();
    snapshot = undefined;
    workspaceCache = {};
    expandedProjectIds = [];
    routeReady = false;
    if (!(await loadBootstrap())) return;
    appliedRoute = "";
    routeReady = true;
    error = "Pidex restarted. Reconnecting this task…";
  }
  function rememberWorkspace(loaded: Workspace, moveToTop = true, expand = true) {
    workspaceCache = { ...workspaceCache, [loaded.id]: loaded };
    if (expand && !expandedProjectIds.includes(loaded.id))
      expandedProjectIds = [...expandedProjectIds, loaded.id];
    if (bootstrap) {
      const entry = { id: loaded.id, path: loaded.path };
      const currentIndex = bootstrap.recentWorkspaces.findIndex(
        (project) => project.id === loaded.id || project.path === loaded.path,
      );
      const existing = bootstrap.recentWorkspaces.filter(
        (project) => project.id !== loaded.id && project.path !== loaded.path,
      );
      const recentWorkspaces = moveToTop
        ? [entry, ...existing]
        : currentIndex < 0
          ? [...existing, entry]
          : bootstrap.recentWorkspaces.map((project, index) =>
              index === currentIndex ? entry : project,
            );
      bootstrap = { ...bootstrap, recentWorkspaces };
    }
  }
  async function openProject(
    path = projectPath,
    options: {
      activate?: boolean;
      closeDrawer?: boolean;
      moveToTop?: boolean;
      expand?: boolean;
      remember?: boolean;
      navigate?: boolean;
    } = {},
  ) {
    const activate = options.activate ?? true;
    const knownId =
      bootstrap?.recentWorkspaces.find((project) => project.path === path)?.id ?? projectName(path);
    try {
      error = "";
      if (activate) projectLoading = true;
      projectLoadingId = knownId;
      const loaded = await api.openWorkspace(path, options.remember ?? true);
      rememberWorkspace(loaded, options.moveToTop ?? activate, options.expand ?? activate);
      if (activate) {
        chatConnection.close();
        workspace = loaded;
        projectPath = loaded.path;
        localStorage.setItem("pidex:last-project", loaded.path);
        snapshot = undefined;
        draft = "";
        if (options.closeDrawer ?? true) drawerOpen = false;
        if (routeReady && (options.navigate ?? true)) {
          appliedRoute = "/";
          routeSequence += 1;
          if (page.url.pathname !== "/") await goto("/");
        }
      }
      return loaded;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not open project";
      return undefined;
    } finally {
      if (activate) projectLoading = false;
      projectLoadingId = "";
    }
  }
  function openProjectPicker() {
    projectQuery = "";
    void tick().then(() => projectDialogElement?.showModal());
  }
  async function addProject(candidate: ProjectCandidate) {
    const loaded = await openProject(candidate.path);
    if (loaded) projectDialogElement?.close();
  }
  async function addAllProjects() {
    const pending = (bootstrap?.projectCandidates ?? []).filter(
      (candidate) => !projectAdded(candidate),
    );
    if (!pending.length || projectBatchLoading) return;
    projectBatchLoading = true;
    projectBatchProgress = 0;
    let first: Workspace | undefined;
    for (const candidate of pending) {
      const loaded = await openProject(candidate.path, {
        activate: false,
        moveToTop: false,
        expand: false,
      });
      first ??= loaded;
      projectBatchProgress += 1;
    }
    if (!workspace && first) {
      workspace = first;
      projectPath = first.path;
      rememberWorkspace(first, true, true);
      localStorage.setItem("pidex:last-project", first.path);
    }
    projectBatchLoading = false;
    projectDialogElement?.close();
  }
  async function browseProject() {
    try {
      const selected = await window.pidexDesktop?.pickProject();
      if (selected) {
        projectPath = selected;
        const loaded = await openProject(selected);
        if (loaded) projectDialogElement?.close();
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not open the folder picker";
    }
  }
  async function approveProjectTrust() {
    if (
      !workspace ||
      !window.pidexDesktop ||
      !window.confirm(
        `Trust project resources in ${workspace.path}?\n\nTrust controls Pi resource loading; it is not an OS sandbox.`,
      )
    )
      return;
    try {
      const loaded = await api.setWorkspaceTrust(workspace.id, true);
      workspace = loaded;
      rememberWorkspace(loaded, false);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Project trust could not be saved";
    }
  }
  async function toggleProject(project: RecentWorkspace) {
    if (projectExpanded(project.id)) {
      expandedProjectIds = expandedProjectIds.filter((id) => id !== project.id);
      return;
    }
    expandedProjectIds = [...expandedProjectIds, project.id];
    if (!workspaceFor(project.id))
      await openProject(project.path, {
        activate: false,
        moveToTop: false,
        expand: false,
        remember: false,
      });
  }
  async function refreshSessions(workspaceId = workspace?.id) {
    if (!workspaceId) return;
    try {
      const current = workspaceFor(workspaceId);
      if (!current) return;
      const sessions = await api.listSessions(workspaceId);
      const loaded = { ...current, sessions };
      workspaceCache = { ...workspaceCache, [workspaceId]: loaded };
      if (workspace?.id === workspaceId) workspace = loaded;
    } catch {
      /* The live chat remains usable if metadata refresh fails. */
    }
  }
  async function newTask(target = workspace) {
    if (!target || chatLoading) return;
    const sequence = ++routeSequence;
    let created: ChatSnapshot | undefined;
    try {
      error = "";
      chatLoading = true;
      created = await api.createChat(target.id);
      if (sequence !== routeSequence) {
        await disposeCreatedTask(created);
        return;
      }
      persistDraft();
      chatConnection.close();
      workspace = target;
      projectPath = target.path;
      rememberWorkspace(target);
      localStorage.setItem("pidex:last-project", target.path);
      snapshot = created;
      draft = "";
      await afterChat("", true);
      if (sequence !== routeSequence) {
        await disposeCreatedTask(created);
        return;
      }
      const path = taskPath(created.taskId);
      appliedRoute = path;
      await goto(path);
    } catch (cause) {
      if (sequence !== routeSequence) {
        if (created) await disposeCreatedTask(created);
        return;
      }
      error = cause instanceof Error ? cause.message : "Could not create task";
    } finally {
      if (sequence === routeSequence) chatLoading = false;
    }
  }
  async function disposeCreatedTask(created: ChatSnapshot) {
    try {
      await api.disposeChat(created.chatId);
    } catch {
      /* Route cancellation remains authoritative if best-effort cleanup fails. */
    }
  }
  async function newTaskInProject(project: RecentWorkspace) {
    const target =
      workspaceFor(project.id) ??
      (await openProject(project.path, { activate: false, moveToTop: false }));
    if (target) await newTask(target);
  }
  function navigateToTask(taskId: string) {
    if (!chatLoading) void goto(taskPath(taskId));
  }
  async function activateRoute(path: string, taskId: string) {
    appliedRoute = path;
    const sequence = ++routeSequence;
    persistDraft();
    chatConnection.close();

    if (!taskId) {
      snapshot = undefined;
      draft = "";
      routeLoading = false;
      chatLoading = false;
      return;
    }

    routeLoading = true;
    chatLoading = true;
    snapshot = snapshotCache.get(taskId);
    workspace = snapshot ? workspaceFor(snapshot.workspaceId) : undefined;
    if (snapshot) {
      draft = localStorage.getItem(`pidex:draft:${snapshot.taskId}`) ?? "";
      drawerOpen = false;
      await tick();
      scrollLatest();
    }

    try {
      error = "";
      const resumed = await api.resumeTask(taskId);
      if (sequence !== routeSequence) return;
      const target = await workspaceById(resumed.workspaceId);
      if (sequence !== routeSequence) return;
      if (!target) throw new Error("The project for this task is no longer available");
      workspace = target;
      projectPath = target.path;
      rememberWorkspace(target);
      localStorage.setItem("pidex:last-project", target.path);
      snapshot = resumed;
      await afterChat();
    } catch (cause) {
      if (sequence === routeSequence)
        error = cause instanceof Error ? cause.message : "Task could not be opened";
    } finally {
      if (sequence === routeSequence) {
        routeLoading = false;
        chatLoading = false;
      }
    }
  }
  async function workspaceById(workspaceId: string) {
    const cached = workspaceFor(workspaceId);
    if (cached) return cached;
    const recent = bootstrap?.recentWorkspaces.find((project) => project.id === workspaceId);
    if (!recent) return undefined;
    return openProject(recent.path, {
      activate: false,
      moveToTop: false,
      expand: true,
      remember: false,
    });
  }
  function initializeDialogValue(dialog: ExtensionDialog) {
    dialogValue = dialog.kind === "confirm" ? false : (dialog.prefill ?? "");
  }
  async function afterChat(initialDraft = "", focusComposer = false) {
    drawerOpen = false;
    draft = initialDraft || localStorage.getItem(`pidex:draft:${snapshot?.taskId}`) || "";
    if (initialDraft) persistDraft();
    restorePendingPrompt();
    restoreConfigurationDraft();
    if (snapshot) chatConnection.connect(snapshot.chatId);
    await tick();
    if (snapshot?.extensionDialog) {
      initializeDialogValue(snapshot.extensionDialog);
      if (dialogElement && !dialogElement.open) dialogElement.showModal();
    }
    resizePrompt();
    scrollLatest();
    if (focusComposer) promptInput?.focus();
  }
  function replaceItem(item: ChatSnapshot["items"][number]) {
    if (!snapshot) return;
    const items = [...snapshot.items];
    const index = items.findIndex((old) => old.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    snapshot = { ...snapshot, items };
  }
  function queueTextDelta(event: Extract<ServerEvent, { type: "text_delta" }>) {
    if (pendingTextDeltaChatId && pendingTextDeltaChatId !== event.chatId)
      flushScheduledTextDeltas();
    pendingTextDeltaChatId = event.chatId;
    appendPendingTextDelta(pendingTextDeltas, event);
    if (pendingTextDeltaFrame !== undefined) return;
    pendingTextDeltaFrame = requestAnimationFrame(() => {
      pendingTextDeltaFrame = undefined;
      flushPendingTextDeltas();
      if (nearBottom) requestAnimationFrame(scrollLatest);
    });
  }
  function flushScheduledTextDeltas() {
    if (pendingTextDeltaFrame !== undefined) cancelAnimationFrame(pendingTextDeltaFrame);
    pendingTextDeltaFrame = undefined;
    flushPendingTextDeltas();
  }
  function flushPendingTextDeltas() {
    if (snapshot && snapshot.chatId === pendingTextDeltaChatId)
      snapshot = applyPendingTextDeltas(snapshot, pendingTextDeltas);
    pendingTextDeltas = new Map();
    pendingTextDeltaChatId = "";
  }
  function applyEvent(event: ServerEvent) {
    if (!snapshot) return;
    if (event.type === "text_delta") {
      queueTextDelta(event);
      return;
    }
    flushScheduledTextDeltas();
    if (event.type === "snapshot") {
      snapshot = event.snapshot;
      if (pendingPrompt && event.snapshot.run?.actionId === pendingPrompt.actionId)
        clearPendingPrompt();
    } else if (event.type === "message" || event.type === "tool" || event.type === "notice")
      replaceItem(event.item);
    else if (event.type === "run_status") {
      snapshot = {
        ...snapshot,
        runStatus: event.status,
        revision: event.revision,
        ...(event.run ? { run: event.run } : {}),
      };
      if (pendingPrompt && event.run?.actionId === pendingPrompt.actionId) clearPendingPrompt();
      if (event.status === "idle") void refreshSessions();
    } else if (event.type === "queue")
      snapshot = { ...snapshot, steeringQueue: event.steering, followUpQueue: event.followUp };
    else if (event.type === "context_usage") snapshot = { ...snapshot, contextUsage: event.usage };
    else if (event.type === "session") {
      snapshot = {
        ...snapshot,
        ...(event.name ? { sessionName: event.name } : {}),
        stats: event.stats,
      };
      void refreshSessions();
    } else if (event.type === "extension_dialog") {
      if (event.dialog) {
        snapshot = { ...snapshot, extensionDialog: event.dialog };
        initializeDialogValue(event.dialog);
        void tick().then(() => dialogElement?.showModal());
      } else {
        const nextSnapshot = { ...snapshot };
        delete nextSnapshot.extensionDialog;
        snapshot = nextSnapshot;
        dialogElement?.close();
      }
    }
    if (nearBottom) requestAnimationFrame(scrollLatest);
  }
  function pendingKey() {
    return snapshot ? `pidex:pending:${snapshot.taskId}` : "";
  }
  function clearPendingPrompt() {
    if (snapshot) localStorage.removeItem(pendingKey());
    pendingPrompt = undefined;
  }
  function restorePendingPrompt() {
    if (!snapshot) return;
    try {
      const value = localStorage.getItem(pendingKey());
      pendingPrompt = value ? (JSON.parse(value) as typeof pendingPrompt) : undefined;
    } catch {
      clearPendingPrompt();
    }
  }
  async function send() {
    if (!snapshot || !draft.trim() || connection !== "connected") return;
    const chatId = snapshot.chatId;
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    const mode = active ? delivery : "normal";
    if (mode === "normal" && !(await applyConfigurationDraft())) return;
    if (snapshot?.chatId !== chatId) return;
    await submitPrompt(text, submittedDraft, mode);
  }
  async function submitPrompt(
    text: string,
    submittedDraft: string,
    mode: "normal" | "steer" | "follow-up",
  ) {
    if (!snapshot) return;
    const matching =
      pendingPrompt?.text === text && pendingPrompt.delivery === mode ? pendingPrompt : undefined;
    pendingPrompt = matching ?? { actionId: api.createActionId(), text, delivery: mode };
    localStorage.setItem(pendingKey(), JSON.stringify(pendingPrompt));
    const clearedSubmittedDraft = draft === submittedDraft;
    if (clearedSubmittedDraft) {
      draft = "";
      persistDraft();
      void tick().then(resizePrompt);
    }
    try {
      const outcome = await api.sendMessage(
        snapshot.chatId,
        text,
        mode,
        snapshot.revision,
        active ? snapshot.run?.runId : undefined,
        pendingPrompt.actionId,
      );
      snapshot = { ...snapshot, revision: Math.max(snapshot.revision, outcome.revision) };
      clearPendingPrompt();
    } catch (cause) {
      if (clearedSubmittedDraft && !draft) {
        draft = text;
        persistDraft();
        void tick().then(resizePrompt);
      }
      error = cause instanceof Error ? cause.message : "Prompt rejected";
    }
  }
  async function stop() {
    if (!snapshot?.run || connection !== "connected") return;
    try {
      const outcome = await api.abort(snapshot.chatId, snapshot.run.runId, snapshot.revision);
      snapshot = { ...snapshot, revision: Math.max(snapshot.revision, outcome.revision) };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Stop failed";
    }
  }
  async function clearQueue() {
    if (!snapshot) return;
    try {
      snapshot = await api.clearQueue(snapshot.chatId, snapshot.revision);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not clear queued instructions";
    }
  }
  async function configure(patch: ChatConfiguration) {
    if (!snapshot) return false;
    const chatId = snapshot.chatId;
    try {
      const configured = await api.configure(chatId, patch, snapshot.revision);
      if (snapshot?.chatId === chatId) snapshot = configured;
      return true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Configuration failed";
      return false;
    }
  }
  function stageConfiguration(patch: ChatConfiguration) {
    if (!snapshot) return;
    const next = { ...configurationDraft };
    if (patch.model !== undefined) {
      if (patch.model === snapshot.model) delete next.model;
      else next.model = patch.model;
    }
    if (patch.thinkingLevel !== undefined) {
      if (patch.thinkingLevel === snapshot.thinkingLevel) delete next.thinkingLevel;
      else next.thinkingLevel = patch.thinkingLevel;
    }
    setConfigurationDraft(snapshot.taskId, next);
  }
  async function applyConfigurationDraft() {
    if (!snapshot || !hasConfigurationDraft) return true;
    const taskId = snapshot.taskId;
    const applied = { ...configurationDraft };
    if (!(await configure(applied))) return false;

    const remaining = { ...configurationDrafts[taskId] };
    if (remaining.model === applied.model) delete remaining.model;
    if (remaining.thinkingLevel === applied.thinkingLevel) delete remaining.thinkingLevel;
    setConfigurationDraft(taskId, remaining);
    return true;
  }
  function restoreConfigurationDraft() {
    if (!snapshot) return;
    try {
      const stored = localStorage.getItem(configurationDraftKey(snapshot.taskId));
      if (!stored) return;
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      const restored: ChatConfiguration = {};
      if (
        typeof parsed.model === "string" &&
        workspace?.models.some((model) => model.id === parsed.model) &&
        parsed.model !== snapshot.model
      )
        restored.model = parsed.model;
      if (
        typeof parsed.thinkingLevel === "string" &&
        THINKING_LEVELS.includes(parsed.thinkingLevel as ChatSnapshot["thinkingLevel"]) &&
        parsed.thinkingLevel !== snapshot.thinkingLevel
      )
        restored.thinkingLevel = parsed.thinkingLevel as ChatSnapshot["thinkingLevel"];
      setConfigurationDraft(snapshot.taskId, restored);
    } catch {
      setConfigurationDraft(snapshot.taskId, {});
    }
  }
  function setConfigurationDraft(taskId: string, value: ChatConfiguration) {
    const next = { ...configurationDrafts };
    const hasValue = value.model !== undefined || value.thinkingLevel !== undefined;
    if (hasValue) {
      next[taskId] = value;
      localStorage.setItem(configurationDraftKey(taskId), JSON.stringify(value));
    } else {
      delete next[taskId];
      localStorage.removeItem(configurationDraftKey(taskId));
    }
    configurationDrafts = next;
  }
  function configurationDraftKey(taskId: string) {
    return `${CONFIGURATION_DRAFT_PREFIX}${taskId}`;
  }
  function openRename() {
    if (!snapshot) return;
    renameValue = snapshot.sessionName ?? currentTitle;
    void tick().then(() => renameDialogElement?.showModal());
  }
  async function rename() {
    if (!snapshot || !renameValue.trim()) return;
    try {
      snapshot = await api.rename(snapshot.chatId, renameValue.trim(), snapshot.revision);
      renameDialogElement?.close();
      await refreshSessions();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Rename failed";
    }
  }
  function openCompact() {
    if (snapshot) void tick().then(() => compactDialogElement?.showModal());
  }
  async function compact() {
    if (!snapshot) return;
    try {
      snapshot = await api.compact(snapshot.chatId, snapshot.revision);
      compactDialogElement?.close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Compaction failed";
    }
  }
  async function answerDialog(dialog: ExtensionDialog, cancelled = false) {
    if (!snapshot) return;
    try {
      await api.answerDialog(
        snapshot.chatId,
        dialog.id,
        resolveDialogValue(dialog, dialogValue, cancelled),
        snapshot.revision,
      );
      dialogElement?.close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Extension response failed";
    }
  }
  async function acknowledgeInterrupted() {
    if (!snapshot?.run?.requiresAcknowledgement) return;
    try {
      const outcome = await api.acknowledgeInterrupted(snapshot.chatId, snapshot.revision);
      snapshot = {
        ...snapshot,
        revision: outcome.revision,
        run: { ...snapshot.run, requiresAcknowledgement: false },
      };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not acknowledge interrupted run";
    }
  }
  async function copyResponse(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copyState = { ...copyState, [id]: "copied" };
    } catch {
      copyState = { ...copyState, [id]: "failed" };
    }
    window.setTimeout(() => {
      const next = { ...copyState };
      delete next[id];
      copyState = next;
    }, 2200);
  }
  async function loadToolOutput(item: ToolItem) {
    if (!snapshot || !item.resourceId) return;
    const current = toolOutputs[item.resourceId];
    if (current?.loading || current?.complete) return;
    toolOutputs = {
      ...toolOutputs,
      [item.resourceId]: {
        text: current?.text ?? "",
        nextOffset: current?.nextOffset ?? 0,
        total: current?.total ?? item.outputSize ?? 0,
        complete: false,
        loading: true,
        sourceTruncated: current?.sourceTruncated ?? false,
      },
    };
    try {
      const chunk = await api.toolOutput(
        snapshot.chatId,
        item.resourceId,
        current?.nextOffset ?? 0,
      );
      toolOutputs = {
        ...toolOutputs,
        [item.resourceId]: {
          text: `${current?.text ?? ""}${chunk.text}`,
          nextOffset: chunk.nextOffset,
          total: chunk.total,
          complete: chunk.complete,
          loading: false,
          sourceTruncated: chunk.sourceTruncated,
        },
      };
    } catch (cause) {
      toolOutputs = {
        ...toolOutputs,
        [item.resourceId]: {
          ...toolOutputs[item.resourceId]!,
          loading: false,
          error: cause instanceof Error ? cause.message : "Tool output could not be loaded",
        },
      };
    }
  }
  async function loadEarlier() {
    if (!snapshot || snapshot.transcriptStart === 0 || loadingEarlier) return;
    const previousScrollHeight = transcript?.scrollHeight;
    const previousScrollTop = transcript?.scrollTop;
    loadingEarlier = true;
    try {
      const transcriptPage = await api.transcript(snapshot.chatId, snapshot.transcriptStart);
      const seen = new Set(snapshot.items.map((item) => item.id));
      snapshot = {
        ...snapshot,
        items: [...transcriptPage.items.filter((item) => !seen.has(item.id)), ...snapshot.items],
        transcriptStart: transcriptPage.start,
        transcriptTotal: transcriptPage.total,
      };
      if (transcript && previousScrollHeight !== undefined && previousScrollTop !== undefined) {
        await tick();
        transcript.scrollTop = previousScrollTop + transcript.scrollHeight - previousScrollHeight;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Earlier messages could not be loaded";
    } finally {
      loadingEarlier = false;
    }
  }
  async function retryConnection() {
    retryingConnection = true;
    error = "";
    try {
      if (routeTaskId) {
        if (!bootstrap && !(await loadBootstrap())) return;
        await activateRoute(routePath, routeTaskId);
        routeReady = true;
      } else if (snapshot) {
        snapshot = await api.getChat(snapshot.chatId);
        chatConnection.reconnect();
      } else if (await loadBootstrap()) {
        appliedRoute = "";
        routeReady = true;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The Pidex host is still unavailable";
    } finally {
      retryingConnection = false;
    }
  }
  function persistDraft() {
    if (snapshot) localStorage.setItem(`pidex:draft:${snapshot.taskId}`, draft);
  }
  function resizePrompt() {
    if (!promptInput) return;
    promptInput.style.height = "auto";
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 210)}px`;
  }
  function draftInput() {
    persistDraft();
    resizePrompt();
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && matchMedia("(min-width: 821px)").matches) {
      event.preventDefault();
      void send();
    }
  }
  function onScroll() {
    if (transcript)
      nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
  }
  function scrollLatest() {
    if (transcript) {
      transcript.scrollTop = transcript.scrollHeight;
      nearBottom = true;
    }
  }
  async function focusSearch() {
    searchOpen = true;
    if (matchMedia("(max-width: 900px)").matches) drawerOpen = true;
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }
  function toggleSearch() {
    if (!searchOpen) {
      void focusSearch();
      return;
    }
    search = "";
    searchOpen = false;
  }
  function globalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      void focusSearch();
      return;
    }
    if (event.key !== "Escape") return;
    if (searchOpen) {
      if (search) search = "";
      else searchOpen = false;
      return;
    }
    if (drawerOpen) {
      drawerOpen = false;
      (document.querySelector(".menu-button") as HTMLElement)?.focus();
      return;
    }
    if (document.activeElement === searchInput) promptInput?.focus();
  }
  function wentOffline() {
    chatConnection.disconnect();
  }
  function cameOnline() {
    if (snapshot) chatConnection.reconnect();
  }
  onMount(() => {
    projectPath = localStorage.getItem("pidex:last-project") ?? "";
    void loadBootstrap().then((loaded) => {
      if (loaded) routeReady = true;
    });
    const relativeTimeInterval = window.setInterval(() => (relativeNow = Date.now()), 60_000);
    return () => {
      window.clearInterval(relativeTimeInterval);
      if (pendingTextDeltaFrame !== undefined) cancelAnimationFrame(pendingTextDeltaFrame);
      chatConnection.close();
    };
  });
</script>

<svelte:window onkeydown={globalKeydown} onoffline={wentOffline} ononline={cameOnline} />

<svelte:head>
  <title>Pidex</title>
  <meta name="description" content="Private local Pi dashboard" />
</svelte:head>

<div
  class="grid h-dvh w-full grid-cols-[304px_minmax(0,1fr)] overflow-hidden max-[900px]:grid-cols-1"
>
  <button
    class={`pointer-events-none fixed inset-0 z-19 hidden border-0 bg-black/52 opacity-0 transition-opacity duration-200 max-[900px]:block ${drawerOpen ? "max-[900px]:pointer-events-auto max-[900px]:opacity-100" : ""}`}
    aria-label="Close tasks"
    tabindex={drawerOpen ? 0 : -1}
    onclick={() => (drawerOpen = false)}
  ></button>

  <aside
    id="tasks-drawer"
    class={`z-20 flex min-h-0 flex-col border-r border-border bg-sidebar px-2 text-foreground shadow-[18px_0_50px_rgb(0_0_0/18%)] transition-transform duration-200 max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:w-[min(86vw,292px)] ${drawerOpen ? "max-[900px]:translate-x-0" : "max-[900px]:-translate-x-[102%]"}`}
    aria-label="Tasks"
    inert={mobileViewport.current && !drawerOpen}
  >
    <div class="flex min-h-14 items-center gap-2 px-1 pt-2 pr-1 pb-1.5 pl-2">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <strong class="text-[15px] font-semibold tracking-tight">Pidex</strong>
        <span class="font-mono text-[9px] leading-none font-medium tracking-[0.16em] text-faint"
          >LOCAL</span
        >
      </div>
      <button
        class={`inline-grid size-8.5 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground ${searchOpen ? "bg-sidebar-hover text-foreground" : ""}`}
        onclick={toggleSearch}
        aria-label={searchOpen ? "Close search" : "Search projects and tasks"}
        aria-expanded={searchOpen}
        aria-keyshortcuts="Meta+K Control+K"
        title={searchOpen ? "Close search" : "Search (⌘K)"}
      >
        <Icon name={searchOpen ? "x" : "search"} />
      </button>
    </div>

    {#if searchOpen}
      <label
        class="mx-0.5 mb-3 flex h-8.5 items-center gap-2 rounded-lg px-2 text-faint transition-colors hover:bg-sidebar-hover hover:text-muted focus-within:bg-sidebar-hover focus-within:text-muted"
      >
        <Icon name="search" />
        <input
          class="w-full min-w-0 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
          bind:this={searchInput}
          bind:value={search}
          aria-label="Search projects and tasks"
          placeholder="Search projects and tasks"
        />
      </label>
    {/if}

    <section class="flex min-h-0 flex-1 flex-col px-0.5 pb-2">
      <div
        class="flex min-h-7 items-center justify-between px-2 font-mono text-[10px] leading-none font-semibold tracking-widest text-faint"
      >
        <span class="inline-flex items-center gap-2"
          >PROJECTS <small class="text-[9px] font-medium tracking-normal opacity-75"
            >{bootstrap?.recentWorkspaces.length ?? 0}</small
          ></span
        >
        <button
          class="grid size-6.5 place-items-center rounded-md border-0 bg-transparent text-faint transition-colors hover:bg-sidebar-hover hover:text-foreground"
          onclick={openProjectPicker}
          aria-label="Add project"
          title="Add project"><Icon name="folder-plus" size={15} /></button
        >
      </div>
      <nav
        class="min-h-0 flex-1 overflow-y-auto pt-px pb-2 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]"
        aria-label="Projects"
        aria-busy={chatLoading || projectLoading}
      >
        {#if visibleProjects.length === 0}
          <div class="flex flex-col items-center gap-2 px-4.5 py-7 text-center text-faint">
            <Icon name={search ? "search" : "folder"} size={18} />
            <p class="m-0 max-w-45 text-[11.5px] leading-relaxed">
              {search ? "No matching projects or tasks." : "Add a project to get started."}
            </p>
            {#if !search}<button
                class="min-h-7 rounded-lg border border-border bg-transparent px-2.5 text-[11px] text-muted hover:border-border-strong hover:text-foreground"
                onclick={openProjectPicker}>Add project</button
              >{/if}
          </div>
        {:else}
          {#each visibleProjects as project (project.id)}
            {@const loaded =
              workspaceCache[project.id] ?? (workspace?.id === project.id ? workspace : undefined)}
            {@const expanded =
              expandedProjectIds.includes(project.id) || Boolean(search.trim() && loaded)}
            {@const matchingTasks = tasksFor(project)}
            {@const sessionLimit = search.trim()
              ? matchingTasks.length
              : (taskLimits[project.id] ?? TASK_PREVIEW_COUNT)}
            {@const shownTasks = expanded
              ? matchingTasks.slice(0, sessionLimit)
              : matchingTasks.filter((task) => routeTaskId === task.id)}
            {@const hiddenTasks = expanded
              ? Math.max(0, matchingTasks.length - shownTasks.length)
              : 0}
            <div class="mb-0.5">
              <div class="group flex min-w-0 items-center gap-0.5">
                <button
                  class={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-muted transition-colors duration-150 group-focus-within:bg-sidebar-hover group-focus-within:text-foreground hover:bg-sidebar-hover hover:text-foreground ${workspace?.id === project.id ? "text-foreground" : ""}`}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${projectLabel(project)}`}
                  title={projectLabel(project)}
                  onclick={() => toggleProject(project)}
                >
                  <span
                    class={`grid flex-none text-faint transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                    ><Icon name="chevron" size={13} /></span
                  >
                  <span
                    class={`grid size-5 flex-none place-items-center rounded text-muted ${workspace?.id === project.id ? "bg-primary/15 text-primary" : ""}`}
                    ><Icon name="folder" size={15} /></span
                  >
                  <strong
                    class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium text-inherit"
                    >{projectLabel(project)}</strong
                  >
                  {#if projectLoadingId === project.id}<span
                      class="flex-none font-mono text-[9.5px] leading-none tracking-wider text-faint"
                      >•••</span
                    >{:else if loaded}<span
                      class="flex-none font-mono text-[9.5px] leading-none text-faint"
                      >{loaded.sessions.length}</span
                    >{/if}
                </button>
                <button
                  class="grid size-7 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted opacity-0 transition-[opacity,background-color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-sidebar-hover hover:text-foreground max-[900px]:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                  onclick={() => newTaskInProject(project)}
                  disabled={chatLoading || projectLoadingId === project.id}
                  aria-label={`New task in ${projectLabel(project)}`}
                  title="New task"
                >
                  <Icon name="compose" size={14} />
                </button>
              </div>
              {#if expanded || shownTasks.length > 0}
                <div
                  class="mb-1 ml-5.5 border-l border-border-strong/60 pl-2"
                  id={`project-${project.id}`}
                >
                  {#if projectLoadingId === project.id && !loaded}
                    <p class="m-0 h-8 px-2 py-2 text-[11px] text-faint">Loading tasks…</p>
                  {:else if loaded && shownTasks.length === 0}
                    <p class="m-0 h-8 px-2 py-2 text-[11px] text-faint">
                      {search ? "No matching tasks." : "No tasks yet."}
                    </p>
                  {:else if loaded}
                    {#each shownTasks as task (task.id)}
                      {@const current = routeTaskId === task.id}
                      <button
                        class={`group/task mb-px flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border-0 px-2 text-left text-[12.5px] text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${current ? "bg-sidebar-active text-foreground shadow-sm" : "bg-transparent"}`}
                        onclick={() => navigateToTask(task.id)}
                        disabled={chatLoading && !routeLoading}
                        title={task.name ?? task.firstMessage}
                      >
                        <span
                          class={`size-1.5 flex-none rounded-full ${current ? "bg-primary opacity-100" : "bg-faint opacity-55"}`}
                        ></span>
                        <strong
                          class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-inherit"
                          >{task.name ?? (task.firstMessage || "Untitled task")}</strong
                        >
                        {#if current && active}<span
                            class="inline-flex flex-none items-center gap-1 text-[9.5px] font-semibold text-sky-500"
                            ><i
                              class="size-1.5 rounded-full bg-current shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_12%,transparent)]"
                            ></i>Working</span
                          >{:else}<time
                            class="flex-none font-mono text-[9.5px] leading-none text-faint tabular-nums"
                            datetime={task.modifiedAt}>{relativeTime(task.modifiedAt)}</time
                          >{/if}
                      </button>
                    {/each}
                    {#if hiddenTasks > 0}
                      <button
                        class="min-h-7 w-full border-0 bg-transparent pr-2 pl-5 text-left text-[10.5px] text-faint hover:text-foreground"
                        onclick={() =>
                          (taskLimits = { ...taskLimits, [project.id]: sessionLimit + 10 })}
                        >Show more <span class="ml-1 opacity-65">{hiddenTasks} hidden</span></button
                      >
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </nav>
    </section>

    <div
      class="mx-0.5 flex min-h-14.5 items-center gap-2 border-t border-border px-2 py-2 text-faint"
    >
      <span class="flex-none"><Icon name="shield" size={15} /></span>
      <p class="m-0 min-w-0 flex-1">
        <strong class="block text-[10.5px] font-semibold text-muted">Local & private</strong><span
          class="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[9.5px]"
          >Read-only limits tools, not the OS.</span
        >
      </p>
      <small class="font-mono text-[9px] leading-none">{bootstrap?.piVersion ?? "Pi"}</small>
    </div>
  </aside>

  <main
    class="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    inert={mobileViewport.current && drawerOpen}
  >
    <header
      class="z-8 flex min-h-14 flex-none items-center gap-3 border-b border-border/70 bg-background/90 px-4.5 py-1.5 backdrop-blur-xl max-[900px]:px-2.5 max-[560px]:min-h-13"
    >
      <button
        class="menu-button hidden size-8.5 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:inline-grid"
        aria-label="Open tasks"
        aria-expanded={drawerOpen}
        aria-controls="tasks-drawer"
        onclick={() => (drawerOpen = true)}
      >
        <Icon name="menu" size={19} />
      </button>
      <div class="min-w-0 flex-1">
        <strong
          class="block overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold tracking-tight"
          >{currentTitle}</strong
        >
        <div class="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-faint capitalize">
          <span class="max-[560px]:hidden">{workspace?.name ?? "No project"}</span>
          <span class="opacity-45 max-[560px]:hidden">/</span>
          <span
            class={`size-1.5 rounded-full ${connection === "connected" ? "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_12%,transparent)]" : "bg-faint"}`}
          ></span>
          <span>{routeLoading ? "syncing" : snapshot ? connection : "local"}</span>
        </div>
      </div>
      {#if snapshot}
        <div class="flex gap-1">
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[11px] font-medium text-muted hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 max-[900px]:w-8 max-[900px]:justify-center max-[900px]:p-0"
            onclick={openRename}
            disabled={active}
            aria-label="Rename"
            title="Rename task"
            ><Icon name="rename" /><span class="max-[900px]:hidden">Rename</span></button
          >
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[11px] font-medium text-muted hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 max-[900px]:w-8 max-[900px]:justify-center max-[900px]:p-0 max-[350px]:hidden"
            onclick={openCompact}
            disabled={active}
            aria-label="Compact"
            title="Compact task"
            ><Icon name="compact" /><span class="max-[900px]:hidden">Compact</span></button
          >
        </div>
      {/if}
    </header>

    {#if error}
      <div
        class="z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger"
        role="alert"
      >
        <span>{error}</span><button
          class="grid rounded p-1 text-inherit"
          aria-label="Dismiss error"
          onclick={() => (error = "")}><Icon name="x" /></button
        >
      </div>
    {/if}
    {#if snapshot && connection !== "connected" && !routeLoading}
      <div
        class="z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-xs text-muted"
        role="status"
      >
        <span class="leading-relaxed"
          ><strong>Host unavailable.</strong> Your task remains on the desktop; drafts will not be submitted
          while disconnected.</span
        ><button
          class="flex-none border border-current px-2 py-1.5 text-[10.5px] font-semibold disabled:opacity-40"
          onclick={retryConnection}
          disabled={retryingConnection}>{retryingConnection ? "Retrying…" : "Retry"}</button
        >
      </div>
    {/if}
    {#if snapshot?.run?.requiresAcknowledgement}
      <div
        class="z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning"
        role="alert"
      >
        <span class="leading-relaxed"
          ><strong>Run interrupted.</strong> The host cannot prove whether this run completed before it
          stopped. Review the Pi transcript, then acknowledge before sending new work.</span
        ><button
          class="flex-none border border-current px-2 py-1.5 text-[10.5px] font-semibold"
          onclick={acknowledgeInterrupted}>Acknowledge</button
        >
      </div>
    {/if}
    {#if workspace?.protectedResourcesSkipped}
      <div
        class="z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning"
        role="status"
      >
        <span
          >Project resources requiring trust were skipped. {window.pidexDesktop
            ? "Review the project before loading them."
            : "Open Pidex Desktop or Pi locally to review trust."}</span
        >{#if window.pidexDesktop}<button
            class="flex-none border border-current px-2 py-1.5 text-[10.5px] font-semibold"
            onclick={approveProjectTrust}>Review & trust</button
          >{/if}
      </div>
    {/if}
    {#if workspace?.resourceDiagnostics.length}
      <div
        class="z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning"
        role="status"
      >
        <span
          ><strong>Pi resource warning.</strong>
          {workspace.resourceDiagnostics[0]?.message}{#if workspace.resourceDiagnostics.length > 1}
            · {workspace.resourceDiagnostics.length - 1} more{/if}</span
        >
      </div>
    {/if}
    {#if workspace && workspace.models.length === 0}
      <div
        class="z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning"
      >
        No authenticated models are available. Run <code>pi</code> and use <code>/login</code> locally.
      </div>
    {/if}

    <section
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
      bind:this={transcript}
      onscroll={onScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {#if bootstrapError && !bootstrap}
        <div
          class="flex min-h-full w-full flex-col items-center justify-center px-6 pt-12 pb-30 text-center max-[560px]:px-4.5"
          role="status"
        >
          <div
            class="relative mb-5 grid size-12 place-items-center rounded-2xl border border-border bg-card shadow-[var(--shadow)] before:absolute before:-inset-2 before:rounded-[20px] before:border before:border-border/60 before:content-['']"
          >
            <Icon name="activity" size={22} />
          </div>
          <p
            class="m-0 mb-2.5 font-mono text-[10px] leading-none font-semibold tracking-widest text-faint uppercase"
          >
            HOST UNAVAILABLE
          </p>
          <h1
            class="m-0 max-w-175 text-[clamp(27px,3vw,38px)] leading-tight font-normal tracking-tighter text-foreground max-[560px]:text-[27px]"
          >
            Your projects are still on the desktop.
          </h1>
          <p class="mt-3 max-w-125 text-sm leading-relaxed text-muted">
            Pidex could not reach its local host. Nothing was deleted and no draft will be submitted
            automatically.
          </p>
          <button
            class="mt-5.5 rounded-lg border border-border-strong bg-card px-3.5 py-2 text-xs font-semibold text-foreground shadow-[var(--shadow)] disabled:opacity-40"
            onclick={retryConnection}
            disabled={retryingConnection}
            >{retryingConnection ? "Retrying…" : "Retry connection"}</button
          >
        </div>
      {:else if routeLoading && !snapshot}
        <div
          class="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-5 pt-10 pb-12 max-[900px]:px-4"
          aria-label="Loading task"
          role="status"
        >
          <span class="sr-only">Loading task…</span>
          {#each ["w-2/5", "w-4/5", "w-3/5"] as width, index (width)}
            <div class={`animate-pulse ${index === 1 ? "ml-auto" : ""} ${width}`}>
              <div class="mb-2 h-2.5 w-20 rounded-full bg-border"></div>
              <div class="h-20 rounded-2xl bg-secondary/75"></div>
            </div>
          {/each}
        </div>
      {:else if !workspace}
        <div
          class="flex min-h-full w-full flex-col items-center justify-center px-6 pt-12 pb-30 text-center max-[560px]:px-4.5"
        >
          <div
            class="relative mb-5 grid size-12 place-items-center rounded-2xl border border-border bg-card shadow-[var(--shadow)] before:absolute before:-inset-2 before:rounded-[20px] before:border before:border-border/60 before:content-['']"
          >
            <span class="font-serif text-[26px] leading-none font-bold">π</span>
          </div>
          <p
            class="m-0 mb-2.5 font-mono text-[10px] leading-none font-semibold tracking-widest text-faint uppercase"
          >
            YOUR PRIVATE PI PROJECT
          </p>
          <h1
            class="m-0 max-w-175 text-[clamp(27px,3vw,38px)] leading-tight font-normal tracking-tighter text-foreground max-[560px]:text-[27px]"
          >
            Bring Pi with you.
          </h1>
          <p class="mt-3 max-w-125 text-sm leading-relaxed text-muted">
            Choose a project to create or resume a task.
          </p>
          <button
            class="mt-4.5 rounded-lg border border-border-strong bg-card px-3.5 py-2 text-xs font-semibold text-foreground shadow-[var(--shadow)]"
            onclick={openProjectPicker}>Add a project</button
          >
        </div>
      {:else if !snapshot}
        <div
          class="flex min-h-full w-full flex-col items-center justify-center px-6 pb-16 text-center max-[560px]:px-4.5"
          role="status"
        >
          <h1 class="m-0 text-xl font-semibold tracking-tight text-foreground">
            Pick a task to continue
          </h1>
          <p class="mt-2 text-sm leading-relaxed text-muted">
            Select an existing task or create a new one to get started.
          </p>
        </div>
      {:else}
        <div class="mx-auto w-full max-w-3xl px-5 pt-7.5 pb-12.5 max-[900px]:px-4 max-[350px]:px-3">
          {#if snapshot.transcriptStart > 0}<button
              class="mx-auto mb-6 block rounded-full border border-border bg-card px-2.5 py-1.5 text-[10.5px] text-muted hover:text-foreground disabled:opacity-40"
              onclick={loadEarlier}
              disabled={loadingEarlier}
              >{loadingEarlier
                ? "Loading earlier messages…"
                : `Load earlier messages · ${snapshot.transcriptStart.toLocaleString()} remaining`}</button
            >{/if}
          {#each snapshot.items as item (item.id)}
            {#if item.type === "user"}
              <article class="mb-5 flex flex-col items-end pt-1">
                <div
                  class="max-w-4/5 rounded-2xl bg-secondary px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] max-[560px]:max-w-9/10"
                >
                  {item.text}
                </div>
              </article>
            {:else if item.type === "assistant"}
              <article class="mb-5 min-w-0 px-1 pt-0.5 pb-1">
                <div class="mb-2 flex items-center gap-1.5 text-[10.5px] font-medium text-faint">
                  <span
                    class="grid size-4.5 place-items-center rounded bg-foreground font-serif text-[11px] leading-none font-bold text-background"
                    >π</span
                  ><span>Pi</span>{#if !item.complete}<span
                      class="inline-flex items-center gap-1 text-primary before:size-1.5 before:animate-pulse before:rounded-full before:bg-current before:content-['']"
                      >streaming</span
                    >{:else}<button
                      class={`ml-auto inline-flex min-h-6.5 items-center gap-1 rounded-md border-0 bg-transparent px-2 text-[10px] text-faint hover:bg-secondary hover:text-foreground ${copyState[item.id] === "failed" ? "text-danger" : ""}`}
                      onclick={() => copyResponse(item.id, item.text)}
                      aria-label="Copy response"
                      ><Icon
                        name={copyState[item.id] === "copied" ? "check" : "copy"}
                        size={13}
                      />{copyState[item.id] === "copied"
                        ? "Copied"
                        : copyState[item.id] === "failed"
                          ? "Copy failed"
                          : "Copy"}</button
                    >{/if}
                </div>
                {#if item.thinking}
                  <details class="mb-2.5 border-b border-border/70">
                    <summary
                      class="flex w-max cursor-pointer items-center gap-2 pt-1 pb-2 text-[11px] text-faint [list-style:none]"
                      ><span class="inline-flex gap-0.5"
                        ><i class="size-1 animate-pulse rounded-full bg-current"></i><i
                          class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.2s]"
                        ></i><i
                          class="size-1 animate-pulse rounded-full bg-current [animation-delay:0.4s]"
                        ></i></span
                      >Thinking</summary
                    >
                    <pre
                      class="mb-2.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/70 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted dark:bg-[#111113]">{item.thinking}</pre>
                  </details>
                {/if}
                <Markdown text={item.text} streaming={!item.complete} />
              </article>
            {:else if item.type === "tool"}
              <details class="group/tool mx-1 mt-1 mb-2 text-[11.5px]">
                <summary
                  class="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-muted [list-style:none] hover:bg-secondary/55"
                >
                  <span class="grid size-5 flex-none place-items-center text-faint"
                    ><Icon name="tool" size={14} /></span
                  >
                  <strong class="font-medium text-foreground/80">{item.name}</strong>
                  <code
                    class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] leading-snug text-faint"
                    >{item.argumentSummary}</code
                  >
                  <span
                    class={`text-[10px] lowercase ${item.state === "error" ? "text-danger" : "text-success"}`}
                    >{item.state === "success" ? "done" : item.state}</span
                  >
                  <span
                    class="flex-none opacity-50 transition-transform duration-150 group-open/tool:rotate-90"
                    ><Icon name="chevron" size={13} /></span
                  >
                </summary>
                {#if item.resourceId && toolOutputs[item.resourceId]?.text}<pre
                    class="mt-1 mr-0 mb-2 ml-7 max-h-75 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/70 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground dark:bg-[#111113]">{toolOutputs[
                      item.resourceId
                    ]?.text}</pre>{:else if item.preview}<pre
                    class="mt-1 mr-0 mb-2 ml-7 max-h-75 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-secondary/70 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground dark:bg-[#111113]">{item.preview}</pre>{/if}
                {#if item.resourceId && !toolOutputs[item.resourceId]?.complete}
                  <button
                    class="mr-0 mb-2 ml-7 rounded-lg border border-border bg-card px-2 py-1.5 text-[10px] font-semibold text-primary disabled:opacity-40"
                    onclick={() => loadToolOutput(item)}
                    disabled={toolOutputs[item.resourceId]?.loading}
                    >{toolOutputs[item.resourceId]?.loading
                      ? "Loading bounded chunk…"
                      : toolOutputs[item.resourceId]?.text
                        ? `Load more · ${toolOutputs[item.resourceId]?.nextOffset.toLocaleString()} / ${toolOutputs[item.resourceId]?.total.toLocaleString()}`
                        : `Load complete output · ${(item.outputSize ?? 0).toLocaleString()} chars`}</button
                  >
                {/if}
                {#if item.resourceId && toolOutputs[item.resourceId]?.sourceTruncated}<p
                    class="mr-0 mb-2 ml-7 text-[10px] text-faint"
                  >
                    The host bounded this output at its safety limit.
                  </p>{/if}
                {#if item.resourceId && toolOutputs[item.resourceId]?.error}<p
                    class="mr-0 mb-2 ml-7 text-[10px] text-danger"
                  >
                    {toolOutputs[item.resourceId]?.error}
                  </p>{/if}
              </details>
            {:else if item.type === "notice"}
              <div
                class={`mx-1 my-2.5 flex items-start gap-2 rounded-lg border bg-secondary/45 px-3 py-2 text-[11.5px] leading-relaxed ${item.level === "error" ? "border-danger/25 text-danger" : "border-border text-muted"}`}
              >
                <span class="mt-px flex-none text-primary"><Icon name="activity" size={14} /></span
                ><span>{item.text}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </section>

    {#if !nearBottom && snapshot}<button
        class="absolute bottom-40 left-1/2 z-7 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10.5px] text-muted shadow-lg hover:text-foreground max-[560px]:bottom-33"
        onclick={scrollLatest}>Jump to latest <Icon name="arrow-down" size={13} /></button
      >{/if}

    {#if snapshot}
      <footer
        class="relative z-7 flex-none bg-[linear-gradient(to_bottom,transparent_0,var(--background)_20px,var(--background)_100%)] px-5 pt-2.5 pb-[max(9px,env(safe-area-inset-bottom))] max-[900px]:px-2.5 max-[560px]:px-2 max-[560px]:pt-2 max-[560px]:pb-[max(7px,env(safe-area-inset-bottom))]"
      >
        {#if active}
          <div
            class="mx-auto flex w-full max-w-3xl items-center justify-between gap-2.5 px-2 pb-2 text-[10.5px] text-faint"
          >
            <span class="flex items-center gap-1.5"
              ><span class="size-1.5 animate-pulse rounded-full bg-primary"
              ></span>{snapshot.runStatus} · {snapshot.steeringQueue.length} steer · {snapshot
                .followUpQueue.length} follow-up</span
            >
            {#if snapshot.steeringQueue.length + snapshot.followUpQueue.length > 0}<button
                class="border-0 bg-transparent p-0 text-[10.5px] text-primary"
                onclick={clearQueue}>Clear queues</button
              >{/if}
          </div>
        {/if}
        <div class="chat-composer mx-auto" data-testid="chat-composer">
          <textarea
            class="chat-composer__input"
            bind:this={promptInput}
            bind:value={draft}
            oninput={draftInput}
            onkeydown={keydown}
            rows="2"
            placeholder={connection !== "connected"
              ? "Draft locally while the host reconnects…"
              : active
                ? "Add guidance while Pi works…"
                : "Ask Pi to work on this project…"}
            aria-label="Prompt"></textarea>
          <div class="chat-composer__toolbar">
            <div class="chat-composer__controls">
              <label class="chat-composer__control">
                <select
                  class="chat-composer__select"
                  aria-label="Model"
                  value={selectedModel}
                  onchange={(e) => stageConfiguration({ model: e.currentTarget.value })}
                  disabled={!workspace?.models.length}
                >
                  {#each workspace?.models ?? [] as model (model.id)}<option value={model.id}
                      >{model.name}</option
                    >{/each}
                </select>
              </label>
              <span class="chat-composer__divider" aria-hidden="true"></span>
              <label class="chat-composer__control">
                <span class="chat-composer__control-icon" aria-hidden="true"
                  ><Icon name="activity" size={14} /></span
                >
                <select
                  class="chat-composer__select"
                  aria-label="Thinking level"
                  value={selectedThinkingLevel}
                  onchange={(e) =>
                    stageConfiguration({
                      thinkingLevel: e.currentTarget.value as ChatSnapshot["thinkingLevel"],
                    })}
                >
                  <option value="off">Off</option><option value="minimal">Minimal</option><option
                    value="low">Low</option
                  ><option value="medium">Medium</option><option value="high">High</option><option
                    value="xhigh">Extra high</option
                  ><option value="max">Max</option>
                </select>
              </label>
              {#if hasConfigurationDraft}<span class="chat-composer__next-turn">Next turn</span
                >{/if}
            </div>
            <div class="flex min-w-0 flex-none items-center gap-1">
              {#if snapshot.contextUsage}<ContextWindowMeter usage={snapshot.contextUsage} />{/if}
              {#if active}
                <select
                  class="h-7 max-w-20 flex-none rounded-lg border-0 bg-transparent pr-4 pl-2 text-[10.5px] font-medium text-muted outline-none hover:bg-secondary hover:text-foreground"
                  bind:value={delivery}
                  aria-label="Delivery mode"
                  ><option value="steer">Steer</option><option value="follow-up">Follow-up</option
                  ></select
                >
                <button
                  class="inline-grid size-8.5 place-items-center rounded-full border-0 bg-danger/15 text-danger hover:bg-danger/20 disabled:opacity-40"
                  onclick={stop}
                  disabled={connection !== "connected"}
                  aria-label="Stop"><Icon name="stop" /></button
                >
                <button
                  class="inline-grid h-8.5 place-items-center rounded-lg border-0 bg-primary px-3 text-[11px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
                  onclick={send}
                  disabled={!draft.trim() || connection !== "connected"}
                  aria-label="Queue">Queue</button
                >
              {:else}
                <button
                  class="chat-composer__send"
                  onclick={send}
                  disabled={!draft.trim() ||
                    !workspace?.models.length ||
                    connection !== "connected" ||
                    snapshot.run?.requiresAcknowledgement}
                  aria-label="Send"><Icon name="send" /></button
                >
              {/if}
            </div>
          </div>
        </div>
        <div
          class="mx-auto w-full max-w-3xl px-2 pt-1.5 font-mono text-[9.5px] leading-tight text-faint max-[560px]:pt-1 max-[560px]:text-[8.5px]"
        >
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
            >{snapshot.stats.messages} messages · {snapshot.stats.tokens.toLocaleString()} tokens · ${snapshot.stats.cost.toFixed(
              4,
            )}</span
          >
        </div>
      </footer>
    {/if}
  </main>
</div>

<dialog
  bind:this={projectDialogElement}
  class="app-dialog m-auto max-h-[calc(100dvh-28px)] w-[min(560px,calc(100vw-28px))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-[0_24px_90px_rgb(0_0_0/28%)]"
  aria-labelledby="project-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    if (!projectBatchLoading) projectDialogElement?.close();
  }}
>
  <form class="p-5 pb-3.5" method="dialog" onsubmit={(event) => event.preventDefault()}>
    <div class="mb-4.5 flex items-start gap-3">
      <div
        class="grid size-8.5 flex-none place-items-center rounded-xl border border-border bg-secondary text-muted"
      >
        <Icon name="folder-plus" />
      </div>
      <div>
        <h2 class="m-0 text-[15px] font-semibold" id="project-dialog-title">Add a project</h2>
        <p class="mt-1 mb-0 text-xs leading-relaxed text-muted">
          Choose by project name. Folder paths stay out of the main workspace UI.
        </p>
      </div>
    </div>
    <label
      class="m-0 flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-background px-3 text-faint focus-within:border-primary/55 focus-within:text-muted"
    >
      <Icon name="search" size={15} />
      <input
        class="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none"
        bind:value={projectQuery}
        aria-label="Filter available projects"
        placeholder="Filter projects"
        autocomplete="off"
      />
    </label>
    <div class="flex min-h-12 items-center justify-between gap-3 px-0.5 pt-2.5 pb-2">
      <span class="grid gap-0.5"
        ><strong class="text-[11.5px] font-semibold text-foreground">Projects</strong><small
          class="text-[10px] text-faint">{availableProjects.length} folders discovered</small
        ></span
      >
      {#if (bootstrap?.projectCandidates ?? []).some((candidate) => !projectAdded(candidate))}
        <button
          class="min-h-7 rounded-lg border border-border bg-transparent px-2 text-[10.5px] font-semibold text-muted hover:border-border-strong hover:text-foreground disabled:opacity-40"
          type="button"
          onclick={addAllProjects}
          disabled={projectBatchLoading}
          >{projectBatchLoading ? `Adding ${projectBatchProgress + 1}…` : "Add all"}</button
        >
      {/if}
    </div>
    <div
      class="max-h-[min(430px,52vh)] overflow-y-auto rounded-xl border border-border bg-background/70 p-1 [scrollbar-width:thin]"
    >
      {#if availableProjects.length === 0}
        <div
          class="flex min-h-33 flex-col items-center justify-center gap-2 text-[11.5px] text-faint"
        >
          <Icon name="folder" size={18} /><span
            >{projectQuery ? "No matching projects" : "No project folders were found"}</span
          >
        </div>
      {:else}
        {#each availableProjects as candidate, candidateIndex (candidate.path)}
          <button
            type="button"
            class="flex min-h-13 w-full items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2 text-left text-foreground hover:bg-secondary disabled:opacity-40"
            onclick={() => addProject(candidate)}
            disabled={projectBatchLoading || projectLoading}
            aria-label={`${projectAdded(candidate) ? "Open" : "Add"} ${candidate.name}`}
          >
            <span
              class={`grid size-8 flex-none place-items-center rounded-lg border text-[11px] font-bold ${candidateIndex % 3 === 1 ? "border-purple-500/20 bg-purple-500/10 text-purple-500" : candidateIndex % 3 === 2 ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-500" : "border-primary/15 bg-primary/10 text-primary"}`}
              >{candidate.name.slice(0, 1).toUpperCase()}</span
            >
            <span class="grid min-w-0 flex-1 gap-1"
              ><strong
                class="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium"
                >{candidate.name}</strong
              ><small class="text-[10px] text-faint"
                >{projectAdded(candidate) ? "Added to Pidex" : "Local project"}</small
              ></span
            >
            <span
              class={`min-w-10 text-right text-[10.5px] font-semibold ${projectAdded(candidate) ? "text-primary" : "text-muted"}`}
              >{projectAdded(candidate) ? "Open" : "Add"}</span
            >
          </button>
        {/each}
      {/if}
    </div>
    <div class="mt-3 flex items-center justify-end gap-2">
      {#if window.pidexDesktop}<button
          type="button"
          class="mr-auto inline-flex min-h-8.5 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[11px] font-medium text-muted hover:text-foreground disabled:opacity-40"
          onclick={browseProject}
          disabled={projectBatchLoading}
          ><Icon name="folder" size={14} /> Browse another folder</button
        >{/if}
      <button
        class="min-h-8.5 rounded-lg border border-border bg-card px-3 text-[11px] font-medium text-muted hover:text-foreground disabled:opacity-40"
        type="button"
        onclick={() => projectDialogElement?.close()}
        disabled={projectBatchLoading}>Done</button
      >
    </div>
  </form>
</dialog>

<dialog
  bind:this={renameDialogElement}
  class="app-dialog m-auto max-h-[calc(100dvh-28px)] w-[min(460px,calc(100vw-28px))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-[0_24px_90px_rgb(0_0_0/28%)]"
  aria-labelledby="rename-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    renameDialogElement?.close();
  }}
>
  <form
    class="p-5"
    method="dialog"
    onsubmit={(event) => {
      event.preventDefault();
      void rename();
    }}
  >
    <div class="mb-4.5 flex items-start gap-3">
      <div
        class="grid size-8.5 flex-none place-items-center rounded-xl border border-border bg-secondary text-muted"
      >
        <Icon name="rename" />
      </div>
      <div>
        <h2 class="m-0 text-[15px] font-semibold" id="rename-dialog-title">Rename task</h2>
        <p class="mt-1 mb-0 text-xs leading-relaxed text-muted">
          Give this task a concise, memorable name.
        </p>
      </div>
    </div>
    <label class="mb-1.5 block text-[11px] font-medium text-muted" for="session-name"
      >Task name</label
    >
    <input
      class="w-full rounded-lg border border-border-strong bg-background px-3 py-2.5 text-[13px] text-foreground outline-none"
      id="session-name"
      bind:value={renameValue}
      autocomplete="off"
    />
    <div class="mt-5 flex justify-end gap-2">
      <button
        class="min-h-8.5 rounded-lg border border-border bg-card px-3 text-[11px] font-medium text-muted hover:text-foreground"
        type="button"
        onclick={() => renameDialogElement?.close()}>Cancel</button
      ><button
        class="min-h-8.5 rounded-lg border border-primary bg-primary px-3 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
        type="submit"
        disabled={!renameValue.trim()}>Save name</button
      >
    </div>
  </form>
</dialog>

<dialog
  bind:this={compactDialogElement}
  class="app-dialog m-auto max-h-[calc(100dvh-28px)] w-[min(460px,calc(100vw-28px))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-[0_24px_90px_rgb(0_0_0/28%)]"
  aria-labelledby="compact-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    compactDialogElement?.close();
  }}
>
  <form
    class="p-5"
    method="dialog"
    onsubmit={(event) => {
      event.preventDefault();
      void compact();
    }}
  >
    <div class="mb-4.5 flex items-start gap-3">
      <div
        class="grid size-8.5 flex-none place-items-center rounded-xl border border-border bg-secondary text-muted"
      >
        <Icon name="compact" />
      </div>
      <div>
        <h2 class="m-0 text-[15px] font-semibold" id="compact-dialog-title">Compact this task?</h2>
        <p class="mt-1 mb-0 text-xs leading-relaxed text-muted">
          Pi will summarize older context to free space in the active context window.
        </p>
      </div>
    </div>
    <div class="mt-5 flex justify-end gap-2">
      <button
        class="min-h-8.5 rounded-lg border border-border bg-card px-3 text-[11px] font-medium text-muted hover:text-foreground"
        type="button"
        onclick={() => compactDialogElement?.close()}>Cancel</button
      ><button
        class="min-h-8.5 rounded-lg border border-primary bg-primary px-3 text-[11px] font-medium text-primary-foreground"
        type="submit">Compact task</button
      >
    </div>
  </form>
</dialog>

{#if snapshot?.extensionDialog}
  <dialog
    bind:this={dialogElement}
    class="app-dialog m-auto max-h-[calc(100dvh-28px)] w-[min(460px,calc(100vw-28px))] rounded-2xl border border-border bg-card p-0 text-foreground shadow-[0_24px_90px_rgb(0_0_0/28%)]"
    aria-labelledby="extension-dialog-title"
    oncancel={(event) => {
      event.preventDefault();
      void answerDialog(snapshot!.extensionDialog!, true);
    }}
  >
    <form
      class="p-5"
      method="dialog"
      onsubmit={(event) => {
        event.preventDefault();
        void answerDialog(snapshot!.extensionDialog!);
      }}
    >
      <div class="mb-4.5 flex items-start gap-3">
        <div
          class="grid size-8.5 flex-none place-items-center rounded-xl border border-border bg-secondary text-muted"
        >
          <Icon name="activity" />
        </div>
        <div>
          <h2 class="m-0 text-[15px] font-semibold" id="extension-dialog-title">
            {snapshot.extensionDialog.title}
          </h2>
          {#if snapshot.extensionDialog.message}<p
              class="mt-1 mb-0 text-xs leading-relaxed text-muted"
            >
              {snapshot.extensionDialog.message}
            </p>{/if}
        </div>
      </div>
      {#if snapshot.extensionDialog.kind === "select"}
        <select
          class="w-full rounded-lg border border-border-strong bg-background px-3 py-2.5 text-[13px] text-foreground outline-none"
          bind:value={dialogValue}
          aria-label="Response"
          >{#each snapshot.extensionDialog.options ?? [] as option (option)}<option value={option}
              >{option}</option
            >{/each}</select
        >
      {:else if snapshot.extensionDialog.kind === "confirm"}
        <label class="flex items-center gap-2 text-[13px] text-foreground"
          ><input
            type="checkbox"
            checked={Boolean(dialogValue)}
            onchange={(event) => (dialogValue = event.currentTarget.checked)}
          /> Confirm</label
        >
      {:else if snapshot.extensionDialog.kind === "editor"}
        <textarea
          class="w-full rounded-lg border border-border-strong bg-background px-3 py-2.5 text-[13px] text-foreground outline-none"
          bind:value={dialogValue}
          aria-label="Response"
          rows="8"></textarea>
      {:else}
        <input
          class="w-full rounded-lg border border-border-strong bg-background px-3 py-2.5 text-[13px] text-foreground outline-none"
          bind:value={dialogValue}
          aria-label="Response"
          placeholder={snapshot.extensionDialog.placeholder}
        />
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button
          class="min-h-8.5 rounded-lg border border-border bg-card px-3 text-[11px] font-medium text-muted hover:text-foreground"
          type="button"
          onclick={() => answerDialog(snapshot!.extensionDialog!, true)}>Cancel</button
        ><button
          class="min-h-8.5 rounded-lg border border-primary bg-primary px-3 text-[11px] font-medium text-primary-foreground"
          type="submit">Continue</button
        >
      </div>
    </form>
  </dialog>
{/if}
