<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { MediaQuery } from "svelte/reactivity";
  import {
    MAX_RECENT_WORKSPACES,
    type Bootstrap,
    type ChatSnapshot,
    type ExtensionDialog,
    type ProjectCandidate,
    type RecentWorkspace,
    type ServerEvent,
    type ToolItem,
    type Workspace,
  } from "@pidex/api";
  import { dialogValue as resolveDialogValue, PidexApiClient } from "./AppShellApiClient";
  import { ChatConnection, type ConnectionState } from "./AppShellConnection";
  import {
    createTaskViewControllerRegistry,
    provideAppShellContext,
    type AppShellContext,
    type TaskDelivery,
    type TaskToolOutput,
    type TaskToolTiming,
  } from "./AppShellContext.svelte";
  import Icon from "./Icon.svelte";
  import { taskPath, TaskSnapshotCache } from "./TaskNavigationState";

  const TASK_PREVIEW_COUNT = 6;
  const CONFIGURATION_DRAFT_PREFIX = "pidex:configuration-draft:";
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const usesIntegratedTitleBar = window.pidexDesktop?.usesIntegratedTitleBar ?? false;
  type ChatConfiguration = Parameters<PidexApiClient["configure"]>[1];
  interface StarterPrompt {
    readonly configuration: ChatConfiguration;
    readonly draft: string;
    readonly text: string;
  }

  let { children }: { children: Snippet } = $props();

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
  let sidebarCollapsed = $state(false);
  let projectLoading = $state(false);
  let projectLoadingId = $state("");
  let projectBatchLoading = $state(false);
  let projectBatchProgress = $state(0);
  let projectOrderSaving = $state(false);
  let draggedProjectId = $state("");
  let projectDropTargetId = $state("");
  let projectDropTargetEdge = $state<"before" | "after">("before");
  let chatLoading = $state(false);
  let routeLoading = $state(false);
  let routeReady = $state(false);
  let appliedRoute = $state("");
  let routeSequence = 0;
  let retryingConnection = $state(false);
  let loadingEarlier = $state(false);
  let delivery = $state<TaskDelivery>("steer");
  let pendingPrompt = $state.raw<
    { actionId: string; text: string; delivery: "normal" | "steer" | "follow-up" } | undefined
  >();
  let configurationDrafts = $state.raw<Record<string, ChatConfiguration>>({});
  let toolTimings = $state.raw<Record<string, TaskToolTiming>>({});
  let toolElapsedNow = $state(Date.now());
  let toolOutputs = $state.raw<Record<string, TaskToolOutput>>({});
  let searchInput = $state<HTMLInputElement>();
  let collapseSidebarButton = $state<HTMLButtonElement>();
  let expandSidebarButton = $state<HTMLButtonElement>();
  let relativeNow = $state(Date.now());
  let dialogValue = $state<string | boolean>("");
  let dialogElement = $state<HTMLDialogElement>();
  let projectDialogElement = $state<HTMLDialogElement>();
  let renameDialogElement = $state<HTMLDialogElement>();
  let renameValue = $state("");
  const mobileViewport = new MediaQuery("max-width: 900px");
  const api = new PidexApiClient();
  const snapshotCache = new TaskSnapshotCache();
  const taskViews = createTaskViewControllerRegistry();
  const chatConnection = new ChatConnection({
    onEvent: applyEvent,
    onInvalidChat: () => void recoverInvalidChat(),
    onStateChange: (state) => (connection = state),
  });
  let pendingTextDeltas = new Map<string, { text: string; thinking: string }>();
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
  let isNewTask = $derived(Boolean(snapshot && snapshot.items.length === 0));
  let hasTopBanner = $derived(
    Boolean(
      error ||
      (snapshot && connection !== "connected" && !routeLoading) ||
      snapshot?.run?.requiresAcknowledgement ||
      workspace?.protectedResourcesSkipped ||
      workspace?.resourceDiagnostics.length ||
      (workspace && workspace.models.length === 0),
    ),
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
  const appShellContext: AppShellContext = {
    shell: {
      get bootstrap() {
        return bootstrap;
      },
      get bootstrapError() {
        return bootstrapError;
      },
      get connection() {
        return connection;
      },
      get retryingConnection() {
        return retryingConnection;
      },
      get routeReady() {
        return routeReady;
      },
      get routeLoading() {
        return routeLoading;
      },
      get workspace() {
        return workspace;
      },
    },
    task: {
      get active() {
        return active;
      },
      get delivery() {
        return delivery;
      },
      get draft() {
        return draft;
      },
      get hasConfigurationDraft() {
        return hasConfigurationDraft;
      },
      get loadingEarlier() {
        return loadingEarlier;
      },
      get selectedModel() {
        return selectedModel;
      },
      get selectedThinkingLevel() {
        return selectedThinkingLevel;
      },
      get snapshot() {
        return snapshot;
      },
      get toolElapsedNow() {
        return toolElapsedNow;
      },
      get toolOutputs() {
        return toolOutputs;
      },
      get toolTimings() {
        return toolTimings;
      },
    },
    taskActions: {
      attachComposer: taskViews.attachComposer,
      attachTranscript: taskViews.attachTranscript,
      clearQueue,
      compact,
      loadEarlier,
      loadToolOutput,
      persistDraft,
      send,
      start: startTask,
      setDelivery: (value) => (delivery = value),
      setDraft: (value) => (draft = value),
      stageConfiguration,
      stop,
    },
    projectActions: {
      openProjectPicker,
      retryConnection,
    },
  };
  provideAppShellContext(appShellContext);

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
  function rememberWorkspace(loaded: Workspace, expand = true) {
    workspaceCache = { ...workspaceCache, [loaded.id]: loaded };
    if (expand && !expandedProjectIds.includes(loaded.id))
      expandedProjectIds = [...expandedProjectIds, loaded.id];
    if (bootstrap) {
      const entry = { id: loaded.id, path: loaded.path };
      const currentIndex = bootstrap.recentWorkspaces.findIndex(
        (project) => project.id === loaded.id || project.path === loaded.path,
      );
      let recentWorkspaces = bootstrap.recentWorkspaces;
      if (currentIndex < 0 && recentWorkspaces.length < MAX_RECENT_WORKSPACES)
        recentWorkspaces = [...recentWorkspaces, entry];
      else if (currentIndex >= 0)
        recentWorkspaces = recentWorkspaces.map((project, index) =>
          index === currentIndex ? entry : project,
        );
      bootstrap = { ...bootstrap, recentWorkspaces };
    }
  }
  function startProjectDrag(event: DragEvent, projectId: string) {
    if (projectOrderSaving) return;
    draggedProjectId = projectId;
    event.dataTransfer?.setData("text/plain", projectId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  function dragProjectOver(event: DragEvent, projectId: string) {
    if (!draggedProjectId) return;
    if (draggedProjectId === projectId) {
      projectDropTargetId = "";
      return;
    }
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const targetBounds = target.getBoundingClientRect();
    projectDropTargetId = projectId;
    projectDropTargetEdge =
      event.clientY < targetBounds.top + targetBounds.height / 2 ? "before" : "after";
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }
  function dropProject(event: DragEvent, projectId: string) {
    event.preventDefault();
    const sourceId = draggedProjectId || event.dataTransfer?.getData("text/plain") || "";
    const edge = projectDropTargetEdge;
    finishProjectDrag();
    moveProjectTo(sourceId, projectId, edge);
  }
  function finishProjectDrag() {
    draggedProjectId = "";
    projectDropTargetId = "";
    projectDropTargetEdge = "before";
  }
  function moveProjectTo(sourceId: string, targetId: string, edge: "before" | "after") {
    if (!bootstrap || sourceId === targetId || projectOrderSaving) return;
    const sourceIndex = bootstrap.recentWorkspaces.findIndex(({ id }) => id === sourceId);
    if (sourceIndex < 0) return;
    const reordered = [...bootstrap.recentWorkspaces];
    const [moved] = reordered.splice(sourceIndex, 1);
    if (!moved) return;
    const targetIndex = reordered.findIndex(({ id }) => id === targetId);
    if (targetIndex < 0) return;
    reordered.splice(targetIndex + (edge === "after" ? 1 : 0), 0, moved);
    void saveProjectOrder(reordered);
  }
  function moveProjectBy(projectId: string, offset: -1 | 1) {
    if (projectOrderSaving) return;
    const sourceIndex = visibleProjects.findIndex(({ id }) => id === projectId);
    const target = visibleProjects[sourceIndex + offset];
    if (!target) return;
    moveProjectTo(projectId, target.id, offset < 0 ? "before" : "after");
  }
  async function saveProjectOrder(recentWorkspaces: RecentWorkspace[]) {
    if (!bootstrap) return;
    const previous = bootstrap.recentWorkspaces;
    projectOrderSaving = true;
    bootstrap = { ...bootstrap, recentWorkspaces };
    try {
      const persisted = await api.reorderWorkspaces(recentWorkspaces.map(({ id }) => id));
      bootstrap = { ...bootstrap, recentWorkspaces: persisted };
    } catch (cause) {
      try {
        bootstrap = await api.bootstrap();
      } catch {
        bootstrap = { ...bootstrap, recentWorkspaces: previous };
      }
      error = cause instanceof Error ? cause.message : "Project order could not be saved";
    } finally {
      projectOrderSaving = false;
    }
  }
  async function openProject(
    path = projectPath,
    options: {
      activate?: boolean;
      closeDrawer?: boolean;
      expand?: boolean;
      remember?: boolean;
      reconcileHistory?: boolean;
      navigate?: boolean;
    } = {},
  ) {
    const activate = options.activate ?? true;
    const remember = options.remember ?? true;
    if (remember && projectOrderSaving) return undefined;
    const knownId =
      bootstrap?.recentWorkspaces.find((project) => project.path === path)?.id ?? projectName(path);
    try {
      error = "";
      if (activate) projectLoading = true;
      projectLoadingId = knownId;
      const loaded = await api.openWorkspace(path, remember);
      if (remember && (options.reconcileHistory ?? true)) {
        try {
          bootstrap = await api.bootstrap();
        } catch (cause) {
          const detail = cause instanceof Error ? `: ${cause.message}` : "";
          error = `Project history could not be refreshed${detail}`;
        }
      }
      rememberWorkspace(loaded, options.expand ?? activate);
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
    if (projectOrderSaving) return;
    projectQuery = "";
    void tick().then(() => projectDialogElement?.showModal());
  }
  async function addProject(candidate: ProjectCandidate) {
    if (projectOrderSaving) return;
    const loaded = await openProject(candidate.path);
    if (loaded) projectDialogElement?.close();
  }
  async function addAllProjects() {
    const pending = (bootstrap?.projectCandidates ?? []).filter(
      (candidate) => !projectAdded(candidate),
    );
    if (!pending.length || projectBatchLoading || projectOrderSaving) return;
    projectBatchLoading = true;
    projectBatchProgress = 0;
    try {
      for (const candidate of pending) {
        await openProject(candidate.path, {
          activate: false,
          expand: false,
          reconcileHistory: false,
        });
        projectBatchProgress += 1;
      }
      bootstrap = await api.bootstrap();
      const initialWorkspace = bootstrap.recentWorkspaces
        .map(({ id }) => workspaceFor(id))
        .find((loaded) => loaded !== undefined);
      if (!workspace && initialWorkspace) {
        workspace = initialWorkspace;
        projectPath = initialWorkspace.path;
        rememberWorkspace(initialWorkspace, true);
        localStorage.setItem("pidex:last-project", initialWorkspace.path);
      }
      projectDialogElement?.close();
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : "";
      error = `Project history could not be refreshed${detail}`;
    } finally {
      projectBatchLoading = false;
    }
  }
  async function browseProject() {
    if (projectOrderSaving) return;
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
  async function startTask(submittedDraft: string, configuration: ChatConfiguration) {
    const text = submittedDraft.trim();
    if (!text) return;
    await newTask(workspace, { configuration, draft: submittedDraft, text });
  }
  async function newTask(target = workspace, starterPrompt?: StarterPrompt) {
    if (!target || chatLoading) return;
    const sequence = ++routeSequence;
    let created: ChatSnapshot | undefined;
    try {
      error = "";
      chatLoading = true;
      const rememberedTarget = await openProject(target.path, {
        activate: false,
        expand: false,
      });
      if (!rememberedTarget) return;
      created = await api.createChat(rememberedTarget.id);
      if (sequence !== routeSequence) {
        await disposeCreatedTask(created);
        return;
      }
      persistDraft();
      chatConnection.close();
      workspace = rememberedTarget;
      projectPath = rememberedTarget.path;
      rememberWorkspace(rememberedTarget);
      localStorage.setItem("pidex:last-project", rememberedTarget.path);
      snapshot = created;
      draft = starterPrompt?.draft ?? "";
      await afterChat(draft, !starterPrompt, !starterPrompt);
      if (sequence !== routeSequence) {
        await disposeCreatedTask(created);
        return;
      }
      const path = taskPath(created.taskId);
      appliedRoute = path;
      await goto(path);
      if (starterPrompt && snapshot?.chatId === created.chatId) {
        stageConfiguration(starterPrompt.configuration);
        const configured = await applyConfigurationDraft();
        if (snapshot?.chatId !== created.chatId) return;
        chatConnection.connect(created.chatId);
        if (!configured) return;
        await submitPrompt(starterPrompt.text, starterPrompt.draft, "normal");
      }
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
      workspaceFor(project.id) ?? (await openProject(project.path, { activate: false }));
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
      taskViews.scrollLatest();
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
    const loaded = await api.openWorkspace(recent.path, true);
    rememberWorkspace(loaded);
    return loaded;
  }
  function initializeDialogValue(dialog: ExtensionDialog) {
    dialogValue = dialog.kind === "confirm" ? false : (dialog.prefill ?? "");
  }
  async function afterChat(initialDraft = "", focusComposer = false, connect = true) {
    drawerOpen = false;
    draft = initialDraft || localStorage.getItem(`pidex:draft:${snapshot?.taskId}`) || "";
    if (initialDraft) persistDraft();
    restorePendingPrompt();
    restoreConfigurationDraft();
    if (snapshot && connect) chatConnection.connect(snapshot.chatId);
    await tick();
    if (snapshot?.extensionDialog) {
      initializeDialogValue(snapshot.extensionDialog);
      if (dialogElement && !dialogElement.open) dialogElement.showModal();
    }
    taskViews.resizeComposer();
    taskViews.scrollLatest();
    if (focusComposer) taskViews.focusComposer();
  }
  function replaceItem(item: ChatSnapshot["items"][number]) {
    if (!snapshot) return;
    const items = [...snapshot.items];
    const index = items.findIndex((old) => old.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    snapshot = { ...snapshot, items };
  }
  /** Times tool calls in the client, the way the Pi TUI does; the transcript carries no duration. */
  function recordToolTiming(item: ToolItem) {
    const current = toolTimings[item.id];
    if (current?.endedAt !== undefined) return;
    // A tool already running when this chat loaded arrives without a start we can trust,
    // so report no duration rather than an invented `Took 0.0s`.
    if (!current && item.state !== "running") return;
    toolElapsedNow = Date.now();
    const startedAt = current?.startedAt ?? toolElapsedNow;
    toolTimings = {
      ...toolTimings,
      [item.id]: item.state === "running" ? { startedAt } : { startedAt, endedAt: toolElapsedNow },
    };
  }
  function queueTextDelta(event: Extract<ServerEvent, { type: "text_delta" }>) {
    if (pendingTextDeltaChatId && pendingTextDeltaChatId !== event.chatId)
      flushScheduledTextDeltas();
    pendingTextDeltaChatId = event.chatId;
    const pending = pendingTextDeltas.get(event.itemId) ?? { text: "", thinking: "" };
    pendingTextDeltas.set(event.itemId, {
      ...pending,
      [event.channel]: pending[event.channel] + event.delta,
    });
    if (pendingTextDeltaFrame !== undefined) return;
    pendingTextDeltaFrame = requestAnimationFrame(() => {
      pendingTextDeltaFrame = undefined;
      flushPendingTextDeltas();
      taskViews.scrollIfNearBottom();
    });
  }
  function flushScheduledTextDeltas() {
    if (pendingTextDeltaFrame !== undefined) cancelAnimationFrame(pendingTextDeltaFrame);
    pendingTextDeltaFrame = undefined;
    flushPendingTextDeltas();
  }
  function flushPendingTextDeltas() {
    if (snapshot && snapshot.chatId === pendingTextDeltaChatId && pendingTextDeltas.size > 0)
      snapshot = {
        ...snapshot,
        items: snapshot.items.map((item) => {
          const delta = pendingTextDeltas.get(item.id);
          if (!delta || item.type !== "assistant") return item;
          return {
            ...item,
            text: item.text + delta.text,
            thinking: (item.thinking ?? "") + delta.thinking,
          };
        }),
      };
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
      if (event.snapshot.revision < snapshot.revision) return;
      snapshot = event.snapshot;
      if (pendingPrompt && event.snapshot.run?.actionId === pendingPrompt.actionId)
        clearPendingPrompt();
    } else if (event.type === "message" || event.type === "tool" || event.type === "notice") {
      if (event.type === "tool") recordToolTiming(event.item);
      replaceItem(event.item);
    } else if (event.type === "run_status") {
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
    taskViews.scrollIfNearBottom();
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
      void tick().then(taskViews.resizeComposer);
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
        void tick().then(taskViews.resizeComposer);
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
  async function compact(instructions?: string) {
    if (!snapshot) return false;
    const chatId = snapshot.chatId;
    try {
      const compacted = await api.compact(chatId, snapshot.revision, instructions);
      if (snapshot?.chatId !== chatId) return false;
      snapshot = compacted;
      return true;
    } catch (cause) {
      if (snapshot?.chatId !== chatId) return false;
      error = cause instanceof Error ? cause.message : "Compaction failed";
      return false;
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
  async function collapseSidebar() {
    sidebarCollapsed = true;
    await tick();
    expandSidebarButton?.focus();
  }
  async function expandSidebar() {
    sidebarCollapsed = false;
    await tick();
    collapseSidebarButton?.focus();
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
    if (document.activeElement === searchInput) taskViews.focusComposer();
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
      pendingTextDeltaFrame = undefined;
      pendingTextDeltas.clear();
      pendingTextDeltaChatId = "";
      taskViews.dispose();
      chatConnection.close();
    };
  });
  $effect(() => {
    if (!snapshot?.items.some((item) => item.type === "tool" && item.state === "running")) return;
    const interval = window.setInterval(() => (toolElapsedNow = Date.now()), 1_000);
    return () => window.clearInterval(interval);
  });
</script>

<svelte:window onkeydown={globalKeydown} onoffline={wentOffline} ononline={cameOnline} />

<svelte:head>
  <title>Pidex</title>
  <meta name="description" content="Private local Pi dashboard" />
</svelte:head>

<div
  class={`grid h-dvh w-full overflow-hidden max-[900px]:grid-cols-1 ${sidebarCollapsed ? "grid-cols-1" : "grid-cols-[304px_minmax(0,1fr)]"}`}
>
  <button
    class={`pointer-events-none fixed inset-0 z-19 hidden border-0 bg-black/52 opacity-0 transition-opacity duration-200 max-[900px]:block ${drawerOpen ? "max-[900px]:pointer-events-auto max-[900px]:opacity-100" : ""}`}
    aria-label="Close tasks"
    tabindex={drawerOpen ? 0 : -1}
    onclick={() => (drawerOpen = false)}
  ></button>

  <aside
    id="tasks-drawer"
    class={`z-20 flex min-h-0 flex-col border-r border-border bg-sidebar px-2 text-foreground shadow-[18px_0_50px_rgb(0_0_0/18%)] transition-transform duration-200 max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:w-[min(86vw,292px)] ${sidebarCollapsed ? "min-[901px]:hidden" : ""} ${drawerOpen ? "max-[900px]:translate-x-0" : "max-[900px]:-translate-x-[102%]"}`}
    aria-label="Tasks"
    inert={mobileViewport.current && !drawerOpen}
  >
    <div
      class={`flex items-center gap-2 pr-1 ${usesIntegratedTitleBar ? "window-drag-region h-13 min-h-13 pl-20" : "min-h-14 pt-2 pb-1.5 pl-2"}`}
    >
      <button
        class="inline-grid size-8.5 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:hidden"
        bind:this={collapseSidebarButton}
        aria-label="Collapse sidebar"
        aria-controls="tasks-drawer"
        aria-expanded="true"
        onclick={collapseSidebar}
      >
        <Icon name="sidebar-collapse" />
      </button>
      <div class="flex min-w-0 flex-1 items-center gap-2">
        {#if usesIntegratedTitleBar}
          <img
            class="size-4 flex-none rounded-[4px]"
            src="/pidex-icon.png"
            alt=""
            draggable="false"
          />
        {/if}
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
          class="grid size-6.5 place-items-center rounded-md border-0 bg-transparent text-faint transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onclick={openProjectPicker}
          disabled={projectOrderSaving}
          aria-label="Add project"
          title="Add project"><Icon name="folder-plus" size={15} /></button
        >
      </div>
      <nav
        class="min-h-0 flex-1 overflow-y-auto pt-px pb-2 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]"
        aria-label="Projects"
        aria-busy={chatLoading || projectLoading || projectOrderSaving}
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
            <div
              class="relative mb-0.5 rounded-lg"
              role="group"
              aria-label={`${projectLabel(project)} project`}
              ondragover={(event) => dragProjectOver(event, project.id)}
              ondrop={(event) => dropProject(event, project.id)}
            >
              {#if projectDropTargetId === project.id}
                <span
                  class={`pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-primary ${projectDropTargetEdge === "before" ? "-top-px" : "-bottom-px"}`}
                  data-project-drop-edge={projectDropTargetEdge}
                  aria-hidden="true"
                ></span>
              {/if}
              <div class="group flex min-w-0 items-center gap-0.5">
                <button
                  class={`flex h-8 min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-muted transition-colors duration-150 group-focus-within:bg-sidebar-hover group-focus-within:text-foreground hover:bg-sidebar-hover hover:text-foreground active:cursor-grabbing ${workspace?.id === project.id ? "text-foreground" : ""}`}
                  draggable={!projectOrderSaving}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${projectLabel(project)}`}
                  title={`${projectLabel(project)} — drag to reorder; use arrow keys for precise movement`}
                  ondragstart={(event) => startProjectDrag(event, project.id)}
                  ondragend={finishProjectDrag}
                  onkeydown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    moveProjectBy(project.id, event.key === "ArrowUp" ? -1 : 1);
                  }}
                  onclick={() => toggleProject(project)}
                >
                  <span
                    class={`grid size-5 flex-none place-items-center rounded text-muted ${workspace?.id === project.id ? "bg-primary/15 text-primary" : ""}`}
                    ><Icon name={expanded ? "folder-open" : "folder"} size={15} /></span
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
                  disabled={chatLoading || projectOrderSaving || projectLoadingId === project.id}
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
                        <span
                          class={`size-1.5 flex-none rounded-full ${current ? "bg-primary opacity-100" : "bg-faint opacity-55"}`}
                        ></span>
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
  </aside>

  <main
    class="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    inert={mobileViewport.current && drawerOpen}
  >
    {#if isNewTask}
      {#if usesIntegratedTitleBar}<div
          class="window-drag-region absolute inset-x-0 top-0 z-8 h-8"
          aria-hidden="true"
        ></div>{/if}
      {#if sidebarCollapsed}
        <button
          class={`absolute top-2.5 z-9 hidden size-8.5 place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground min-[901px]:inline-grid ${usesIntegratedTitleBar ? "left-20" : "left-2.5"}`}
          bind:this={expandSidebarButton}
          aria-label="Expand sidebar"
          aria-controls="tasks-drawer"
          aria-expanded="false"
          onclick={expandSidebar}
        >
          <Icon name="sidebar-expand" size={19} />
        </button>
      {/if}
      <button
        class={`menu-button absolute top-2.5 z-9 hidden size-8.5 place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:inline-grid ${usesIntegratedTitleBar ? "left-20" : "left-2.5"}`}
        aria-label="Open tasks"
        aria-expanded={drawerOpen}
        aria-controls="tasks-drawer"
        onclick={() => (drawerOpen = true)}
      >
        <Icon name="menu" size={19} />
      </button>
    {:else}
      <header
        class={`z-8 flex flex-none items-center gap-3 border-b border-border/70 bg-background/90 px-4.5 backdrop-blur-xl max-[900px]:px-2.5 ${usesIntegratedTitleBar ? `window-drag-region h-13 min-h-13 py-0 ${sidebarCollapsed ? "pl-20" : "max-[900px]:pl-20"}` : "min-h-14 py-1.5 max-[560px]:min-h-13"}`}
      >
        {#if sidebarCollapsed}
          <button
            class="inline-grid size-8.5 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:hidden"
            bind:this={expandSidebarButton}
            aria-label="Expand sidebar"
            aria-controls="tasks-drawer"
            aria-expanded="false"
            onclick={expandSidebar}
          >
            <Icon name="sidebar-expand" size={19} />
          </button>
        {/if}
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
          {#if !usesIntegratedTitleBar || mobileViewport.current}
            <div class="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-faint capitalize">
              <span class="max-[560px]:hidden">{workspace?.name ?? "No project"}</span>
              <span class="opacity-45 max-[560px]:hidden">/</span>
              <span
                class={`size-1.5 rounded-full ${connection === "connected" ? "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_12%,transparent)]" : "bg-faint"}`}
              ></span>
              <span>{routeLoading ? "syncing" : snapshot ? connection : "local"}</span>
            </div>
          {/if}
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
          </div>
        {/if}
      </header>
    {/if}

    {#if isNewTask && hasTopBanner}<div class="h-13 flex-none" aria-hidden="true"></div>{/if}

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

    {@render children()}
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
          disabled={projectBatchLoading || projectOrderSaving}
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
            disabled={projectBatchLoading || projectLoading || projectOrderSaving}
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
          disabled={projectBatchLoading || projectOrderSaving}
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
