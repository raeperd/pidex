<script lang="ts" module>
  import type { ConnectionState } from "./AppShellConnection";

  const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
    style: "narrow",
  });

  /** `"disconnected"` (offline) is gated the same as `"reconnecting"` — a uniform delay, no special case. */
  function connectionBanner(
    connection: ConnectionState,
    hasEverConnected: boolean,
    delayElapsed: boolean,
  ): "connecting" | "reconnecting" | undefined {
    if (connection === "connected" || !delayElapsed) return undefined;
    return hasEverConnected ? "reconnecting" : "connecting";
  }
</script>

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
  import {
    dialogValue as resolveDialogValue,
    makePidexApiClient,
    type PidexApiClient,
  } from "./AppShellApiClient";
  import { makeChatConnection } from "./AppShellConnection";
  import {
    createTaskViewControllerRegistry,
    provideAppShellContext,
    type AppShellContext,
    type TaskStartMode,
    type TaskToolOutput,
    type TaskToolTiming,
  } from "./AppShellContext.svelte";
  import Icon from "./Icon.svelte";
  import { resolveTaskStatus, rollupProjectStatus } from "./SidebarTaskStatus";
  import { makeTaskSnapshotCache, taskPath } from "./TaskNavigationState";
  import Toast from "./Toast.svelte";

  const TASK_PREVIEW_COUNT = 6;
  const SIDEBAR_WIDTH_STORAGE_KEY = "pidex:sidebar-width";
  const DEFAULT_SIDEBAR_WIDTH = 272;
  const MIN_SIDEBAR_WIDTH = 120;
  const MAX_SIDEBAR_WIDTH = 480;
  const usesIntegratedTitleBar = window.pidexDesktop?.usesIntegratedTitleBar ?? false;
  const bannerClass = (tone: string, text: string) =>
    `z-6 mx-4.5 mt-2.5 flex items-center justify-between gap-3 rounded-lg border ${tone} px-3 py-2 text-control ${text}`;
  const warningBannerClass = bannerClass("border-warning/25 bg-warning/10", "text-warning-text");
  const bannerActionClass =
    "flex-none rounded-lg border border-current px-2 py-1.5 text-meta font-semibold";
  const shellIconButtonClass =
    "place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground";
  const appDialogClass =
    "app-dialog m-auto max-h-[calc(100dvh-28px)] rounded-2xl border border-border bg-card p-0 text-foreground shadow-modal";
  const dialogSecondaryButtonClass =
    "min-h-8.5 rounded-lg border border-border bg-card px-3 text-control font-medium text-muted hover:text-foreground";
  const dialogPrimaryButtonClass =
    "min-h-8.5 rounded-lg border border-primary bg-primary px-3 text-control font-medium text-primary-foreground";
  const dialogInputClass =
    "w-full rounded-lg border border-border-strong bg-background px-3 py-2.5 text-ui text-foreground";
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
  let toast = $state("");
  // Bumped on every toast report, including a repeat of the same text: `toast = $state("")`
  // assigning an identical string is a no-op to Svelte's reactivity, so without a distinguishing
  // key the second occurrence of an already-showing message would neither re-present nor restart
  // the auto-dismiss timer. `{#key toastOccurrence}` around <Toast> forces a fresh instance.
  let toastOccurrence = $state(0);
  let bootstrapError = $state("");
  let drawerOpen = $state(false);
  let sidebarCollapsed = $state(false);
  let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
  let sidebarResizing = $state(false);
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
  let hasEverConnected = $state(false);
  let connectionBannerDelayElapsed = $state(false);
  let loadingEarlier = $state(false);
  let startMode = $state<TaskStartMode>("local");
  let configurationPendingTaskIds = $state.raw<string[]>([]);
  let compactPendingTaskIds = $state.raw<string[]>([]);
  let pendingPrompt = $state.raw<{ actionId: string; text: string } | undefined>();
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
  const api = makePidexApiClient();
  const snapshotCache = makeTaskSnapshotCache();
  const taskViews = createTaskViewControllerRegistry();
  const chatConnection = makeChatConnection({
    onEvent: applyEvent,
    onInvalidChat: () => void recoverInvalidChat(),
    onStateChange: (state) => (connection = state),
  });
  let pendingTextDeltas = new Map<string, { text: string; thinking: string }>();
  let pendingTextDeltaFrame: number | undefined;
  let pendingTextDeltaChatId = "";
  let sidebarResizeStartX = 0;
  let sidebarResizeStartWidth = DEFAULT_SIDEBAR_WIDTH;

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
  /** Every session from every project loaded into the cache, resolved through the same
   * priority table the sidebar rows and rollup dots use — the favicon reflects the whole
   * app's state, not just the open task, so a task running or erroring in another project
   * still surfaces here. */
  let knownSessionStatuses = $derived.by(() => {
    const loaded =
      workspace && !(workspace.id in workspaceCache)
        ? { ...workspaceCache, [workspace.id]: workspace }
        : workspaceCache;
    return Object.values(loaded).flatMap((entry) =>
      entry.sessions.map((session) =>
        resolveTaskStatus({
          session,
          liveTaskId: snapshot?.taskId,
          liveRunStatus: snapshot?.runStatus,
        }),
      ),
    );
  });
  /** "Attention" folds in `requiresAcknowledgement` for the open task on top of the
   * aggregate error rollup: a crash-interrupted run awaiting acknowledgement has no
   * `runStatus` of its own to roll up (it reads as idle), but it is exactly the kind of
   * thing the favicon exists to surface. */
  let faviconHref = $derived.by(() => {
    const aggregate = rollupProjectStatus(knownSessionStatuses);
    if (aggregate === "error" || snapshot?.run?.requiresAcknowledgement)
      return "/favicon-attention.svg";
    return aggregate === "running" ? "/favicon-running.svg" : "/favicon.svg";
  });
  $effect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (link) link.href = faviconHref;
  });
  let configurationPending = $derived(
    Boolean(snapshot && configurationPendingTaskIds.includes(snapshot.taskId)),
  );
  let compactPending = $derived(
    Boolean(snapshot && compactPendingTaskIds.includes(snapshot.taskId)),
  );
  let isNewTask = $derived(
    Boolean((routePath === "/" && workspace) || (snapshot && snapshot.items.length === 0)),
  );
  let taskHasNoTranscript = $derived(
    Boolean(snapshot && snapshot.transcriptTotal === 0 && snapshot.items.length === 0),
  );
  let banner = $derived(
    connectionBanner(connection, hasEverConnected, connectionBannerDelayElapsed),
  );
  let hasTopBanner = $derived(
    Boolean(
      error ||
      (snapshot && banner && !routeLoading) ||
      snapshot?.run?.requiresAcknowledgement ||
      workspace?.protectedResourcesSkipped ||
      workspace?.resourceDiagnostics.length ||
      (workspace && workspace.models.length === 0),
    ),
  );
  let snapshotChatId = $derived(snapshot?.chatId);
  /** Delay-gates the connection banner so a blip shorter than ~1.5s never flashes it. */
  $effect(() => {
    if (connection === "connected") {
      hasEverConnected = true;
      connectionBannerDelayElapsed = false;
      return;
    }
    const timer = window.setTimeout(() => (connectionBannerDelayElapsed = true), 1_500);
    return () => window.clearTimeout(timer);
  });
  $effect(() => {
    void snapshotChatId;
    hasEverConnected = false;
  });
  let selectedModel = $derived(snapshot?.model ?? "");
  let selectedThinkingLevel = $derived(snapshot?.thinkingLevel ?? "medium");
  let startModeEditable = $derived(
    Boolean(
      snapshot &&
      taskHasNoTranscript &&
      !active &&
      !chatLoading &&
      !workspaceIsWorktree(snapshot.workspaceId),
    ),
  );
  const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  function sourceWorkspaceId(project: RecentWorkspace) {
    if (project.sourceWorkspaceId) return project.sourceWorkspaceId;
    if (project.worktree !== true) return undefined;
    const sources = (bootstrap?.recentWorkspaces ?? []).filter(
      (candidate) =>
        candidate.worktree !== true && projectName(candidate.path) === projectName(project.path),
    );
    return sources.length === 1 ? sources[0]?.id : undefined;
  }
  function projectLabel(project: RecentWorkspace) {
    const name = projectName(project.path);
    const duplicates = (bootstrap?.recentWorkspaces ?? []).filter(
      (entry) => !sourceWorkspaceId(entry) && projectName(entry.path) === name,
    );
    if (duplicates.length < 2) return name;
    return project.worktree ? `${name} · worktree` : `${name} · local`;
  }
  function workspaceIsWorktree(workspaceId: string) {
    return bootstrap?.recentWorkspaces.some(
      (project) => project.id === workspaceId && project.worktree === true,
    );
  }
  const workspaceFor = (id: string) =>
    workspaceCache[id] ?? (workspace?.id === id ? workspace : undefined);
  const worktreesFor = (workspaceId: string) =>
    (bootstrap?.recentWorkspaces ?? []).filter(
      (project) => sourceWorkspaceId(project) === workspaceId,
    );
  const projectActive = (project: RecentWorkspace) =>
    workspace?.id === project.id ||
    worktreesFor(project.id).some((worktree) => worktree.id === workspace?.id);
  const projectExpanded = (id: string) => expandedProjectIds.includes(id);
  function tasksFor(project: RecentWorkspace) {
    const sessions = [project, ...worktreesFor(project.id)]
      .flatMap((member) =>
        (workspaceFor(member.id)?.sessions ?? []).map((session) => ({
          ...session,
          worktree: member.worktree === true,
        })),
      )
      .toSorted((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    const query = search.trim().toLowerCase();
    if (!query || projectName(project.path).toLowerCase().includes(query)) return sessions;
    return sessions.filter((session) =>
      `${session.name ?? ""} ${session.firstMessage}`.toLowerCase().includes(query),
    );
  }
  let rootProjects = $derived.by(() => {
    const projects = bootstrap?.recentWorkspaces ?? [];
    return projects.filter((project) => {
      const sourceId = sourceWorkspaceId(project);
      return !sourceId || !projects.some((candidate) => candidate.id === sourceId);
    });
  });
  let visibleProjects = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return rootProjects.filter(
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
  const projectTileClasses = [
    "border-primary/15 bg-primary/10 text-primary-text",
    "border-purple-500/20 bg-purple-500/10 text-purple-500",
    "border-emerald-500/20 bg-emerald-500/10 text-emerald-500",
  ];
  /* Hash the name so a project keeps its tile color while the list is filtered or reordered. */
  function projectTileClass(name: string) {
    let hash = 0;
    for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 9973;
    return projectTileClasses[hash % projectTileClasses.length];
  }
  let currentTitle = $derived.by(() => {
    if (!snapshot) return workspace?.name ?? "Pidex";
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
      get creatingTask() {
        return chatLoading;
      },
      get configurationPending() {
        return configurationPending;
      },
      get compactPending() {
        return compactPending;
      },
      get draft() {
        return draft;
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
      get startMode() {
        return startMode;
      },
      get startModeEditable() {
        return startModeEditable;
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
      configure,
      loadEarlier,
      loadToolOutput,
      persistDraft,
      send,
      start: startTask,
      setDraft: (value) => (draft = value),
      setStartMode: (value) => {
        if (startModeEditable) startMode = value;
      },
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
        ? [0, "second"] // sub-minute labels would lie between 60s ticks; "now" is always honest
        : absolute < 3600
          ? [Math.round(seconds / 60), "minute"]
          : absolute < 86_400
            ? [Math.round(seconds / 3600), "hour"]
            : [Math.round(seconds / 86_400), "day"];
    return RELATIVE_TIME_FORMAT.format(amount, unit as Intl.RelativeTimeFormatUnit);
  };
  function reportError(cause: unknown, fallback: string) {
    error = cause instanceof Error ? cause.message : fallback;
  }
  function reportToast(cause: unknown, fallback: string) {
    toast = cause instanceof Error ? cause.message : fallback;
    toastOccurrence += 1;
  }
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
      const currentIndex = bootstrap.recentWorkspaces.findIndex(
        (project) => project.id === loaded.id || project.path === loaded.path,
      );
      const current = bootstrap.recentWorkspaces[currentIndex];
      const entry = {
        id: loaded.id,
        path: loaded.path,
        ...(current?.worktree === undefined ? {} : { worktree: current.worktree }),
        ...(current?.sourceWorkspaceId ? { sourceWorkspaceId: current.sourceWorkspaceId } : {}),
      };
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
    const sourceIndex = rootProjects.findIndex(({ id }) => id === sourceId);
    if (sourceIndex < 0) return;
    const reordered = [...rootProjects];
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
    const reorderedWithWorktrees = recentWorkspaces.flatMap((project) => [
      project,
      ...worktreesFor(project.id),
    ]);
    projectOrderSaving = true;
    bootstrap = { ...bootstrap, recentWorkspaces: reorderedWithWorktrees };
    try {
      const persisted = await api.reorderWorkspaces(reorderedWithWorktrees.map(({ id }) => id));
      bootstrap = { ...bootstrap, recentWorkspaces: persisted };
    } catch (cause) {
      try {
        bootstrap = await api.bootstrap();
      } catch {
        bootstrap = { ...bootstrap, recentWorkspaces: previous };
      }
      reportToast(cause, "Project order could not be saved");
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
        const loadedProject = bootstrap?.recentWorkspaces.find(
          (project) => project.id === loaded.id || project.path === loaded.path,
        );
        if (loadedProject) await loadSourceWorkspace(loadedProject);
        for (const worktree of worktreesFor(loaded.id))
          if (!workspaceFor(worktree.id))
            await openProject(worktree.path, {
              activate: false,
              expand: false,
              remember: false,
            });
        adoptWorkspace(loaded);
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
      reportToast(cause, "Could not open project");
      return undefined;
    } finally {
      if (activate) projectLoading = false;
      projectLoadingId = "";
    }
  }
  function adoptWorkspace(loaded: Workspace, mode?: TaskStartMode) {
    chatConnection.close();
    workspace = loaded;
    projectPath = loaded.path;
    startMode = mode ?? (workspaceIsWorktree(loaded.id) ? "worktree" : "local");
    localStorage.setItem("pidex:last-project", loaded.path);
  }
  async function loadSourceWorkspace(project: RecentWorkspace) {
    const sourceId = sourceWorkspaceId(project);
    if (!sourceId || workspaceFor(sourceId)) return;
    const source = bootstrap?.recentWorkspaces.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    await openProject(source.path, {
      activate: false,
      expand: false,
      remember: false,
    });
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
      reportToast(cause, "Could not open the folder picker");
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
      reportToast(cause, "Project trust could not be saved");
    }
  }
  async function toggleProject(project: RecentWorkspace) {
    if (projectExpanded(project.id)) {
      expandedProjectIds = expandedProjectIds.filter((id) => id !== project.id);
      return;
    }
    expandedProjectIds = [...expandedProjectIds, project.id];
    for (const member of [project, ...worktreesFor(project.id)])
      if (!workspaceFor(member.id))
        await openProject(member.path, {
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
      adoptWorkspace(rememberedTarget);
      rememberWorkspace(rememberedTarget);
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
        const configured = await configure(starterPrompt.configuration);
        if (snapshot?.chatId !== created.chatId) return;
        chatConnection.connect(created.chatId);
        if (!configured) return;
        await submitPrompt(starterPrompt.text, starterPrompt.draft);
      }
    } catch (cause) {
      if (sequence !== routeSequence) {
        if (created) await disposeCreatedTask(created);
        return;
      }
      reportToast(cause, "Could not create task");
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
  async function prepareWorktreeTask(initialDraft: string) {
    if (!workspace || !snapshot || chatLoading || projectOrderSaving) return false;
    const source = workspace;
    const previousSnapshot = snapshot;
    const sequence = ++routeSequence;
    let worktree: Workspace | undefined;
    let created: ChatSnapshot | undefined;
    try {
      error = "";
      chatLoading = true;
      worktree = await api.createWorktree(source.id);
      const createdWorktree = worktree;
      created = await api.createChat(worktree.id);
      const createdChat = created;
      const abandon = async () => {
        await disposeCreatedWorktree(createdWorktree, createdChat);
        return false;
      };
      if (sequence !== routeSequence) return abandon();
      persistDraft();
      const refreshedBootstrap = await api.bootstrap();
      if (sequence !== routeSequence) return abandon();
      bootstrap = refreshedBootstrap;
      rememberWorkspace(worktree, false);
      adoptWorkspace(worktree, "worktree");
      snapshot = created;
      const configured = await configure({
        ...(previousSnapshot.model ? { model: previousSnapshot.model } : {}),
        thinkingLevel: previousSnapshot.thinkingLevel,
      });
      if (!configured) throw new Error(toast || "Could not configure worktree");
      if (sequence !== routeSequence) return abandon();
      await afterChat(initialDraft, true);
      if (sequence !== routeSequence) return abandon();
      const path = taskPath(created.taskId);
      appliedRoute = path;
      await goto(path, { replaceState: true });
      await disposeCreatedTask(previousSnapshot);
      return true;
    } catch (cause) {
      if (worktree) await disposeCreatedWorktree(worktree, created);
      if (sequence !== routeSequence) return false;
      workspace = source;
      projectPath = source.path;
      localStorage.setItem("pidex:last-project", source.path);
      snapshot = previousSnapshot;
      reportToast(cause, "Could not create worktree");
      return false;
    } finally {
      if (sequence === routeSequence) chatLoading = false;
    }
  }
  async function disposeCreatedWorktree(worktree: Workspace, created?: ChatSnapshot) {
    if (created) await disposeCreatedTask(created);
    try {
      await api.removeWorktree(worktree.id);
      bootstrap = await api.bootstrap();
    } catch {
      /* Cleanup is best-effort; the original task remains usable if removal fails. */
    }
  }
  async function activateRoute(path: string, taskId: string) {
    appliedRoute = path;
    const sequence = ++routeSequence;
    persistDraft();
    chatConnection.close();
    // The chat's WebSocket for the task we're leaving just closed, so if its run settles
    // while we're gone, its idle run_status event never arrives and refreshSessions never
    // fires for it. Per-chat events alone can't keep the list live; refresh that task's
    // workspace now as a cheap mitigation. (A workspace-level event stream would be the
    // proper fix but is out of scope here.) Gated on `snapshot` so this only fires when
    // actually navigating away from an open task, not on every route activation.
    if (snapshot) void refreshSessions(snapshot.workspaceId);

    if (!taskId) {
      snapshot = undefined;
      draft = "";
      startMode = "local";
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
      adoptWorkspace(target);
      rememberWorkspace(target);
      snapshot = resumed;
      await afterChat();
    } catch (cause) {
      if (sequence === routeSequence) reportError(cause, "Task could not be opened");
    } finally {
      if (sequence === routeSequence) {
        routeLoading = false;
        chatLoading = false;
      }
    }
  }
  async function workspaceById(workspaceId: string) {
    const recent = bootstrap?.recentWorkspaces.find((project) => project.id === workspaceId);
    const cached = workspaceFor(workspaceId);
    if (cached) {
      if (recent) await loadSourceWorkspace(recent);
      return cached;
    }
    if (!recent) return undefined;
    const loaded = await api.openWorkspace(recent.path, true);
    rememberWorkspace(loaded);
    await loadSourceWorkspace(recent);
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
      const wasIdle = snapshot.runStatus === "idle";
      snapshot = {
        ...snapshot,
        runStatus: event.status,
        revision: event.revision,
        ...(event.run ? { run: event.run } : {}),
      };
      if (pendingPrompt && event.run?.actionId === pendingPrompt.actionId) clearPendingPrompt();
      // A session only enters the sidebar listing via refreshSessions, which used to fire
      // only when a run settles. Without also refreshing on the idle -> non-idle transition,
      // a task created this session had no sidebar presence for its entire first run.
      // `wasIdle` here already implies `event.status !== "idle"`: this branch of the OR only
      // runs once the first has ruled that out.
      if (event.status === "idle" || wasIdle) void refreshSessions();
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
    if (active || configurationPending || !snapshot || !draft.trim() || connection !== "connected")
      return;
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    if (
      startMode === "worktree" &&
      taskHasNoTranscript &&
      !workspaceIsWorktree(snapshot.workspaceId) &&
      !(await prepareWorktreeTask(submittedDraft))
    )
      return;
    if (!snapshot) return;
    await submitPrompt(text, submittedDraft);
  }
  async function submitPrompt(text: string, submittedDraft: string) {
    if (!snapshot) return;
    const matching = pendingPrompt?.text === text ? pendingPrompt : undefined;
    pendingPrompt = matching ?? { actionId: api.createActionId(), text };
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
        snapshot.revision,
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
      reportToast(cause, "Prompt rejected");
    }
  }
  async function stop() {
    if (!snapshot?.run || connection !== "connected") return;
    try {
      const outcome = await api.abort(snapshot.chatId, snapshot.run.runId, snapshot.revision);
      snapshot = { ...snapshot, revision: Math.max(snapshot.revision, outcome.revision) };
    } catch (cause) {
      reportToast(cause, "Stop failed");
    }
  }
  async function clearQueue() {
    if (!snapshot) return;
    try {
      snapshot = await api.clearQueue(snapshot.chatId, snapshot.revision);
    } catch (cause) {
      reportToast(cause, "Could not clear queued instructions");
    }
  }
  async function configure(patch: ChatConfiguration) {
    if (!snapshot || active) return false;
    const taskId = snapshot.taskId;
    if (configurationPendingTaskIds.includes(taskId)) return false;
    const chatId = snapshot.chatId;
    const revision = snapshot.revision;
    configurationPendingTaskIds = [...configurationPendingTaskIds, taskId];
    try {
      const configured = await api.configure(chatId, patch, revision);
      if (snapshot?.chatId === chatId) snapshot = configured;
      return true;
    } catch (cause) {
      reportToast(cause, "Configuration failed");
      return false;
    } finally {
      configurationPendingTaskIds = configurationPendingTaskIds.filter(
        (pendingTaskId) => pendingTaskId !== taskId,
      );
    }
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
      reportToast(cause, "Rename failed");
    }
  }
  async function compact(instructions?: string) {
    if (!snapshot) return false;
    const taskId = snapshot.taskId;
    if (compactPendingTaskIds.includes(taskId)) return false;
    const chatId = snapshot.chatId;
    const revision = snapshot.revision;
    compactPendingTaskIds = [...compactPendingTaskIds, taskId];
    try {
      const compacted = await api.compact(chatId, revision, instructions);
      if (snapshot?.chatId !== chatId) return false;
      snapshot = compacted;
      return true;
    } catch (cause) {
      if (snapshot?.chatId !== chatId) return false;
      reportToast(cause, "Compaction failed");
      return false;
    } finally {
      compactPendingTaskIds = compactPendingTaskIds.filter(
        (pendingTaskId) => pendingTaskId !== taskId,
      );
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
      reportToast(cause, "Extension response failed");
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
      reportToast(cause, "Could not acknowledge interrupted run");
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
      reportToast(cause, "Earlier messages could not be loaded");
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
      reportError(cause, "The Pidex host is still unavailable");
    } finally {
      retryingConnection = false;
    }
  }
  function persistDraft() {
    if (snapshot) localStorage.setItem(`pidex:draft:${snapshot.taskId}`, draft);
  }
  async function focusSearch() {
    searchOpen = true;
    if (mobileViewport.current) drawerOpen = true;
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
  function collapseSidebarAtDefaultWidth() {
    sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
    persistSidebarWidth();
    void collapseSidebar();
  }
  function persistSidebarWidth() {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }
  function startSidebarResize(event: PointerEvent) {
    if (mobileViewport.current || sidebarCollapsed || event.button !== 0) return;
    event.preventDefault();
    sidebarResizing = true;
    sidebarResizeStartX = event.clientX;
    sidebarResizeStartWidth = sidebarWidth;
    const handle = event.currentTarget;
    if (handle instanceof HTMLElement) handle.setPointerCapture(event.pointerId);
  }
  function resizeSidebar(event: PointerEvent) {
    if (!sidebarResizing) return;
    const nextWidth = sidebarResizeStartWidth + event.clientX - sidebarResizeStartX;
    if (nextWidth < MIN_SIDEBAR_WIDTH) {
      sidebarResizing = false;
      collapseSidebarAtDefaultWidth();
      return;
    }
    sidebarWidth = constrainSidebarWidth(nextWidth);
  }
  function finishSidebarResize() {
    if (!sidebarResizing) return;
    sidebarResizing = false;
    persistSidebarWidth();
    void tick().then(taskViews.resizeComposer);
  }
  function resizeSidebarWithKeyboard(event: KeyboardEvent) {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    if (event.key === "ArrowLeft" && sidebarWidth === MIN_SIDEBAR_WIDTH) {
      collapseSidebarAtDefaultWidth();
      return;
    }
    const step = event.shiftKey ? 32 : 16;
    sidebarWidth = constrainSidebarWidth(
      event.key === "Home"
        ? MIN_SIDEBAR_WIDTH
        : event.key === "End"
          ? MAX_SIDEBAR_WIDTH
          : sidebarWidth + (event.key === "ArrowLeft" ? -step : step),
    );
    persistSidebarWidth();
    void tick().then(taskViews.resizeComposer);
  }
  function resetSidebarWidth() {
    sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
    persistSidebarWidth();
    void tick().then(taskViews.resizeComposer);
  }
  function finishSidebarTransition(event: TransitionEvent) {
    if (event.target !== event.currentTarget || event.propertyName !== "grid-template-columns")
      return;
    taskViews.resizeComposer();
    if (sidebarCollapsed) expandSidebarButton?.focus();
  }
  function constrainSidebarWidth(width: number) {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
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
  onMount(() => {
    projectPath = localStorage.getItem("pidex:last-project") ?? "";
    const savedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0)
      sidebarWidth = constrainSidebarWidth(savedSidebarWidth);
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

<svelte:window
  onkeydown={globalKeydown}
  onoffline={() => chatConnection.disconnect()}
  ononline={() => {
    if (snapshot) chatConnection.reconnect();
  }}
/>

<svelte:head>
  <title>{currentTitle}</title>
  <meta name="description" content="Private local Pi dashboard" />
</svelte:head>

<div
  class={`grid h-dvh w-full overflow-hidden ${sidebarResizing || mobileViewport.current ? "" : "transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none"} ${sidebarResizing ? "cursor-col-resize select-none" : ""}`}
  style:grid-template-columns={mobileViewport.current
    ? "minmax(0, 1fr)"
    : `${sidebarCollapsed ? 0 : sidebarWidth}px minmax(0, 1fr)`}
  ontransitionend={finishSidebarTransition}
>
  <button
    class={`pointer-events-none fixed inset-0 z-19 hidden border-0 bg-black/52 opacity-0 transition-opacity duration-200 max-[900px]:block ${drawerOpen ? "max-[900px]:pointer-events-auto max-[900px]:opacity-100" : ""}`}
    aria-label="Close tasks"
    tabindex={drawerOpen ? 0 : -1}
    onclick={() => (drawerOpen = false)}
  ></button>

  <aside
    id="tasks-drawer"
    class={`relative z-20 flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-sidebar px-2 text-foreground shadow-[18px_0_50px_rgb(0_0_0/18%)] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:w-[min(88vw,320px)] ${sidebarCollapsed ? "min-[901px]:-translate-x-4 min-[901px]:opacity-0" : "min-[901px]:translate-x-0 min-[901px]:opacity-100"} ${drawerOpen ? "max-[900px]:translate-x-0" : "max-[900px]:-translate-x-[102%]"}`}
    aria-label="Tasks"
    inert={(sidebarCollapsed && !mobileViewport.current) || (mobileViewport.current && !drawerOpen)}
  >
    <div
      class="group absolute inset-y-0 right-0 z-30 hidden w-2 cursor-col-resize touch-none items-center justify-end outline-none min-[901px]:flex"
      role="slider"
      aria-label="Resize sidebar"
      aria-orientation="horizontal"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={sidebarWidth}
      tabindex="0"
      onpointerdown={startSidebarResize}
      onpointermove={resizeSidebar}
      onpointerup={finishSidebarResize}
      onpointercancel={finishSidebarResize}
      onlostpointercapture={finishSidebarResize}
      onkeydown={resizeSidebarWithKeyboard}
      ondblclick={resetSidebarWidth}
    >
      <span
        class={`h-full w-px transition-colors ${sidebarResizing ? "bg-primary" : "bg-transparent group-hover:bg-border-strong group-focus-visible:bg-primary"}`}
        aria-hidden="true"
      ></span>
    </div>
    <div
      class={`flex items-center gap-2 pr-1 ${usesIntegratedTitleBar ? "window-drag-region h-13 min-h-13 pl-20" : "min-h-14 pt-2 pb-1.5 pl-2"}`}
    >
      <span class="icon-tooltip relative inline-flex max-[900px]:hidden">
        <button
          class="inline-grid size-8.5 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
          bind:this={collapseSidebarButton}
          aria-label="Collapse sidebar"
          aria-controls="tasks-drawer"
          aria-expanded="true"
          onclick={collapseSidebar}
        >
          <Icon name="sidebar-collapse" />
        </button>
        <span
          class="icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-left"
          role="tooltip">Collapse sidebar</span
        >
      </span>
      <a class="flex min-w-0 flex-1 items-center gap-2" href="/" aria-label="Pidex home">
        {#if usesIntegratedTitleBar}
          <img
            class="size-4 flex-none rounded-[4px]"
            src="/pidex-icon.png"
            alt=""
            draggable="false"
          />
        {/if}
        <strong class="text-heading font-semibold tracking-tight">Pidex</strong>
        <span class="font-mono text-meta leading-none font-medium tracking-[0.16em] text-faint"
          >LOCAL</span
        >
      </a>
      <span class="icon-tooltip relative inline-flex">
        <button
          class={`inline-grid size-8.5 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:size-10 ${searchOpen ? "bg-sidebar-hover text-foreground" : ""}`}
          onclick={toggleSearch}
          aria-label={searchOpen ? "Close search" : "Search projects and tasks"}
          aria-expanded={searchOpen}
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Icon name={searchOpen ? "x" : "search"} />
        </button>
        <span
          class="icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-right"
          role="tooltip">{searchOpen ? "Close search" : "Search (⌘K)"}</span
        >
      </span>
    </div>

    {#if searchOpen}
      <label
        class="mx-0.5 mb-3 flex h-8.5 items-center gap-2 rounded-lg px-2 text-faint transition-colors hover:bg-sidebar-hover hover:text-muted focus-within:bg-sidebar-hover focus-within:text-muted max-[900px]:h-10"
      >
        <Icon name="search" />
        <input
          class="w-full min-w-0 border-0 bg-transparent text-ui text-foreground outline-none placeholder:text-muted"
          bind:this={searchInput}
          bind:value={search}
          aria-label="Search projects and tasks"
          placeholder="Search projects and tasks"
        />
      </label>
    {/if}

    <section class="flex min-h-0 flex-1 flex-col px-0.5 pb-2">
      <div
        class="mt-2 flex min-h-9 items-center justify-between px-2 text-ui font-medium text-muted"
      >
        <span>Projects</span>
        <button
          class="grid size-8 place-items-center rounded-lg border-0 bg-transparent text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:size-9 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={openProjectPicker}
          disabled={projectOrderSaving}
          aria-label="Add project"
          title="Add project"><Icon name="folder-plus" size={17} /></button
        >
      </div>
      <nav
        class="min-h-0 flex-1 overflow-y-auto pt-1 pb-2 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]"
        aria-label="Projects"
        aria-busy={chatLoading || projectLoading || projectOrderSaving}
      >
        {#if visibleProjects.length === 0}
          <div class="flex flex-col items-center gap-2 px-4.5 py-7 text-center text-faint">
            <Icon name={search ? "search" : "folder"} size={18} />
            <p class="m-0 max-w-45 text-control leading-relaxed">
              {search ? "No matching projects or tasks." : "Add a project to get started."}
            </p>
            {#if !search}<button
                class="min-h-7 rounded-lg border border-border bg-transparent px-2.5 text-control text-muted hover:border-border-strong hover:text-foreground"
                onclick={openProjectPicker}>Add project</button
              >{/if}
          </div>
        {:else}
          {#each visibleProjects as project (project.id)}
            {@const loaded = workspaceFor(project.id)}
            {@const expanded = projectExpanded(project.id) || Boolean(search.trim() && loaded)}
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
            {@const projectRollup = expanded
              ? "idle"
              : rollupProjectStatus(
                  matchingTasks.map((task) =>
                    resolveTaskStatus({
                      session: task,
                      liveTaskId: snapshot?.taskId,
                      liveRunStatus: snapshot?.runStatus,
                    }),
                  ),
                )}
            <div
              class="relative mb-1 rounded-lg"
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
                  class={`flex h-9 min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-lg border-0 bg-transparent px-1.5 text-left text-muted transition-colors duration-150 group-focus-within:bg-sidebar-hover group-focus-within:text-foreground hover:bg-sidebar-hover hover:text-foreground active:cursor-grabbing max-[900px]:h-10 ${projectActive(project) ? "text-foreground" : ""}`}
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
                    class={`grid size-4 flex-none place-items-center text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
                    ><Icon name="chevron" size={14} /></span
                  >
                  <span
                    class={`grid size-5 flex-none place-items-center ${projectActive(project) ? "text-primary" : "text-muted"}`}
                    ><Icon name={expanded ? "folder-open" : "folder"} size={17} /></span
                  >
                  <strong
                    class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-ui font-medium text-foreground"
                    >{projectLabel(project)}</strong
                  >
                  {#if projectRollup !== "idle"}<span
                      class={`size-1.5 flex-none rounded-full ${projectRollup === "error" ? "bg-danger" : "bg-primary animate-status-pulse"}`}
                      aria-label={projectRollup === "error"
                        ? "Task needs attention"
                        : "Tasks running"}
                      title={projectRollup === "error" ? "Task needs attention" : "Tasks running"}
                    ></span>{/if}
                  {#if projectLoadingId === project.id}<span
                      class="flex-none font-mono text-meta leading-none tracking-wider text-faint max-[900px]:text-meta"
                      >•••</span
                    >{/if}
                </button>
                <button
                  class="grid size-8 flex-none place-items-center rounded-lg border-0 bg-transparent text-muted opacity-0 transition-[opacity,background-color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-sidebar-hover hover:text-foreground max-[900px]:size-9 max-[900px]:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                  onclick={() => newTaskInProject(project)}
                  disabled={chatLoading || projectOrderSaving || projectLoadingId === project.id}
                  aria-label={`New task in ${projectLabel(project)}`}
                  title="New task"
                >
                  <Icon name="compose" size={14} />
                </button>
              </div>
              {#if expanded || shownTasks.length > 0}
                <div class="relative mb-1" id={`project-${project.id}`}>
                  <span
                    class="pointer-events-none absolute inset-y-0 left-3 z-1 border-l border-border-strong/60"
                    aria-hidden="true"
                  ></span>
                  {#if projectLoadingId === project.id && !loaded}
                    <p
                      class="m-0 h-9 py-2 pr-2 pl-[22px] text-ui text-faint max-[900px]:h-10 max-[900px]:py-2.5"
                    >
                      Loading tasks…
                    </p>
                  {:else if loaded && shownTasks.length === 0}
                    <p
                      class="m-0 h-9 py-2 pr-2 pl-[22px] text-ui text-faint max-[900px]:h-10 max-[900px]:py-2.5"
                    >
                      {search ? "No matching tasks." : "No tasks yet."}
                    </p>
                  {:else if loaded}
                    {#each shownTasks as task (task.id)}
                      {@const current = routeTaskId === task.id}
                      {@const rowStatus = resolveTaskStatus({
                        session: task,
                        liveTaskId: snapshot?.taskId,
                        liveRunStatus: snapshot?.runStatus,
                      })}
                      <button
                        class={`group/task mb-0.5 flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border-0 py-0 pr-2.5 pl-[22px] text-left text-ui text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground max-[900px]:h-10 disabled:cursor-not-allowed disabled:opacity-40 ${current ? "bg-sidebar-active text-foreground shadow-sm" : "bg-transparent"}`}
                        onclick={() => {
                          if (!chatLoading) void goto(taskPath(task.id));
                        }}
                        disabled={chatLoading && !routeLoading}
                        title={task.name ?? task.firstMessage}
                      >
                        <strong
                          class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-inherit"
                          >{task.name ?? (task.firstMessage || "Untitled task")}</strong
                        >
                        {#if task.worktree}<span
                            class="grid size-4 flex-none rotate-90 place-items-center text-faint"
                            data-worktree-indicator
                            aria-label="Worktree"
                            title="Worktree"><Icon name="worktree" size={14} /></span
                          >{/if}
                        {#if rowStatus === "running"}<span
                            class="inline-flex flex-none items-center gap-1 text-meta font-semibold text-primary-text max-[900px]:text-meta"
                            title="Working"
                            ><i
                              class="size-1.5 animate-status-pulse rounded-full bg-current shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_12%,transparent)]"
                            ></i>Working</span
                          >{:else if rowStatus === "error"}<span
                            class="inline-flex flex-none items-center gap-1 text-meta font-semibold text-danger max-[900px]:text-meta"
                            title="Error"
                            ><i class="size-1.5 rounded-full bg-current"></i>Error</span
                          >{:else}<time
                            class="flex-none font-mono text-meta leading-none text-faint tabular-nums"
                            datetime={task.modifiedAt}>{relativeTime(task.modifiedAt)}</time
                          >{/if}
                      </button>
                    {/each}
                    {#if hiddenTasks > 0}
                      <button
                        class="min-h-8 w-full border-0 bg-transparent pr-2.5 pl-[22px] text-left text-control text-faint hover:text-foreground max-[900px]:min-h-10"
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
    {#snippet expandSidebarControl(buttonClass: string)}
      <button
        class={`${buttonClass} icon-tooltip`}
        bind:this={expandSidebarButton}
        aria-label="Expand sidebar"
        aria-controls="tasks-drawer"
        aria-expanded="false"
        onclick={expandSidebar}
      >
        <Icon name="sidebar-expand" size={19} />
        <span
          class="icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-left"
          role="tooltip">Expand sidebar</span
        >
      </button>
    {/snippet}
    {#snippet openTasksControl(buttonClass: string)}
      <button
        class={buttonClass}
        aria-label="Open tasks"
        aria-expanded={drawerOpen}
        aria-controls="tasks-drawer"
        onclick={() => (drawerOpen = true)}
      >
        <Icon name="menu" size={19} />
      </button>
    {/snippet}
    {#if isNewTask}
      {#if usesIntegratedTitleBar}<div
          class="window-drag-region absolute inset-x-0 top-0 z-8 h-8"
          aria-hidden="true"
        ></div>{/if}
      {#if sidebarCollapsed}
        {@render expandSidebarControl(
          `absolute top-2.5 z-9 hidden size-8.5 ${shellIconButtonClass} min-[901px]:inline-grid ${usesIntegratedTitleBar ? "left-20" : "left-2.5"}`,
        )}
      {/if}
      {@render openTasksControl(
        `menu-button absolute top-2.5 z-9 hidden size-8.5 ${shellIconButtonClass} max-[900px]:inline-grid max-[900px]:size-10 ${usesIntegratedTitleBar ? "left-20" : "left-2.5"}`,
      )}
    {:else}
      <header
        class={`z-8 flex flex-none items-center gap-3 border-b border-border/70 bg-background/90 px-4.5 backdrop-blur-xl max-[900px]:px-2.5 ${usesIntegratedTitleBar ? `window-drag-region h-13 min-h-13 py-0 ${sidebarCollapsed ? "pl-20" : "max-[900px]:pl-20"}` : "min-h-14 py-1.5 max-[560px]:min-h-13"}`}
      >
        {#if sidebarCollapsed}
          {@render expandSidebarControl(
            `relative inline-grid size-8.5 flex-none ${shellIconButtonClass} max-[900px]:hidden`,
          )}
        {/if}
        {@render openTasksControl(
          `menu-button hidden size-8.5 flex-none ${shellIconButtonClass} max-[900px]:inline-grid max-[900px]:size-10`,
        )}
        <div class="min-w-0 flex-1">
          <strong
            class="block overflow-hidden text-ellipsis whitespace-nowrap text-ui font-semibold tracking-tight"
            >{currentTitle}</strong
          >
        </div>
        {#if snapshot}
          <div class="flex gap-1">
            <span class="icon-tooltip relative inline-flex">
              <button
                class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-control font-medium text-muted hover:border-border-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 max-[900px]:size-9 max-[900px]:justify-center max-[900px]:p-0"
                onclick={openRename}
                disabled={active}
                aria-label="Rename"
                ><Icon name="rename" /><span class="max-[900px]:hidden">Rename</span></button
              >
              <span
                class="icon-tooltip-bubble icon-tooltip-bubble--below icon-tooltip-bubble--align-right"
                role="tooltip">Rename task</span
              >
            </span>
          </div>
        {/if}
      </header>
    {/if}

    {#if isNewTask && hasTopBanner}<div class="h-13 flex-none" aria-hidden="true"></div>{/if}

    {#if error}
      <div class={bannerClass("border-danger/25 bg-danger/10", "text-danger")} role="alert">
        <span>{error}</span><button
          class="grid rounded p-1 text-inherit"
          aria-label="Dismiss error"
          onclick={() => (error = "")}><Icon name="x" /></button
        >
      </div>
    {/if}
    {#if snapshot && banner && !routeLoading}
      <div class={bannerClass("border-primary/25 bg-primary/8", "text-muted")} role="status">
        <span class="leading-relaxed"
          >{#if banner === "connecting"}<strong>Connecting…</strong> Waiting for the desktop host.{:else}<strong
              >Reconnecting…</strong
            > Your task remains on the desktop; drafts will not be submitted while disconnected.{/if}</span
        ><button
          class={`${bannerActionClass} disabled:opacity-40`}
          onclick={retryConnection}
          disabled={retryingConnection}>{retryingConnection ? "Retrying…" : "Retry"}</button
        >
      </div>
    {/if}
    {#if snapshot?.run?.requiresAcknowledgement}
      <div class={warningBannerClass} role="alert">
        <span class="leading-relaxed"
          ><strong>Run interrupted.</strong> The host cannot prove whether this run completed before it
          stopped. Review the Pi transcript, then acknowledge before sending new work.</span
        ><button class={bannerActionClass} onclick={acknowledgeInterrupted}>Acknowledge</button>
      </div>
    {/if}
    {#if workspace?.protectedResourcesSkipped}
      <div class={warningBannerClass} role="status">
        <span
          >Project resources requiring trust were skipped. {window.pidexDesktop
            ? "Review the project before loading them."
            : "Open Pidex Desktop or Pi locally to review trust."}</span
        >{#if window.pidexDesktop}<button class={bannerActionClass} onclick={approveProjectTrust}
            >Review & trust</button
          >{/if}
      </div>
    {/if}
    {#if workspace?.resourceDiagnostics.length}
      <div class={warningBannerClass} role="status">
        <span
          ><strong>Pi resource warning.</strong>
          {workspace.resourceDiagnostics[0]?.message}{#if workspace.resourceDiagnostics.length > 1}
            · {workspace.resourceDiagnostics.length - 1} more{/if}</span
        >
      </div>
    {/if}
    {#if workspace && workspace.models.length === 0}
      <div class={warningBannerClass}>
        No authenticated models are available. Run <code>pi</code> and use <code>/login</code> locally.
      </div>
    {/if}

    {#key toastOccurrence}
      <Toast message={toast} ondismiss={() => (toast = "")} />
    {/key}

    {@render children()}
  </main>
</div>

{#snippet dialogHeader(
  icon: "folder-plus" | "rename" | "activity",
  titleId: string,
  title: string,
  description?: string,
)}
  <div class="mb-4.5 flex items-start gap-3">
    <div
      class="grid size-8.5 flex-none place-items-center rounded-xl border border-border bg-secondary text-muted"
    >
      <Icon name={icon} />
    </div>
    <div>
      <h2 class="m-0 text-heading font-semibold" id={titleId}>{title}</h2>
      {#if description}<p class="mt-1 mb-0 text-control leading-relaxed text-muted">
          {description}
        </p>{/if}
    </div>
  </div>
{/snippet}

<dialog
  bind:this={projectDialogElement}
  class={[appDialogClass, "w-[min(560px,calc(100vw-28px))]"]}
  aria-labelledby="project-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    if (!projectBatchLoading) projectDialogElement?.close();
  }}
>
  <form class="p-5 pb-3.5" method="dialog" onsubmit={(event) => event.preventDefault()}>
    {@render dialogHeader(
      "folder-plus",
      "project-dialog-title",
      "Add a project",
      "Choose by project name. Folder paths stay out of the main workspace UI.",
    )}
    <label
      class="m-0 flex h-10 items-center gap-2 rounded-lg border border-border-strong bg-background px-3 text-faint focus-within:border-primary focus-within:text-muted"
    >
      <Icon name="search" size={15} />
      <input
        class="min-w-0 flex-1 border-0 bg-transparent p-0 text-ui text-foreground outline-none"
        bind:value={projectQuery}
        aria-label="Filter available projects"
        placeholder="Filter projects"
        autocomplete="off"
      />
    </label>
    <div class="flex min-h-12 items-center justify-between gap-3 px-0.5 pt-2.5 pb-2">
      <span class="grid gap-0.5"
        ><strong class="text-control font-semibold text-foreground">Projects</strong><small
          class="text-meta text-faint">{availableProjects.length} folders discovered</small
        ></span
      >
      {#if (bootstrap?.projectCandidates ?? []).some((candidate) => !projectAdded(candidate))}
        <button
          class="min-h-7 rounded-lg border border-border bg-transparent px-2 text-meta font-semibold text-muted hover:border-border-strong hover:text-foreground disabled:opacity-40"
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
          class="flex min-h-33 flex-col items-center justify-center gap-2 text-control text-faint"
        >
          <Icon name="folder" size={18} /><span
            >{projectQuery ? "No matching projects" : "No project folders were found"}</span
          >
        </div>
      {:else}
        {#each availableProjects as candidate (candidate.path)}
          <button
            type="button"
            class="flex min-h-13 w-full items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2 text-left text-foreground hover:bg-secondary disabled:opacity-40"
            onclick={() => addProject(candidate)}
            disabled={projectBatchLoading || projectLoading || projectOrderSaving}
            aria-label={`${projectAdded(candidate) ? "Open" : "Add"} ${candidate.name}`}
          >
            <span
              class={`grid size-8 flex-none place-items-center rounded-lg border text-control font-bold ${projectTileClass(candidate.name)}`}
              >{candidate.name.slice(0, 1).toUpperCase()}</span
            >
            <span class="grid min-w-0 flex-1 gap-1"
              ><strong class="overflow-hidden text-ellipsis whitespace-nowrap text-ui font-medium"
                >{candidate.name}</strong
              ><small class="text-meta text-faint"
                >{projectAdded(candidate) ? "Added to Pidex" : "Local project"}</small
              ></span
            >
            <span
              class={`min-w-10 text-right text-meta font-semibold ${projectAdded(candidate) ? "text-primary-text" : "text-muted"}`}
              >{projectAdded(candidate) ? "Open" : "Add"}</span
            >
          </button>
        {/each}
      {/if}
    </div>
    <div class="mt-3 flex items-center justify-end gap-2">
      {#if window.pidexDesktop}<button
          type="button"
          class="mr-auto inline-flex min-h-8.5 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-control font-medium text-muted hover:text-foreground disabled:opacity-40"
          onclick={browseProject}
          disabled={projectBatchLoading || projectOrderSaving}
          ><Icon name="folder" size={14} /> Browse another folder</button
        >{/if}
      <button
        class={`${dialogSecondaryButtonClass} disabled:opacity-40`}
        type="button"
        onclick={() => projectDialogElement?.close()}
        disabled={projectBatchLoading}>Done</button
      >
    </div>
  </form>
</dialog>

<dialog
  bind:this={renameDialogElement}
  class={[appDialogClass, "w-[min(460px,calc(100vw-28px))]"]}
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
    {@render dialogHeader(
      "rename",
      "rename-dialog-title",
      "Rename task",
      "Give this task a concise, memorable name.",
    )}
    <label class="mb-1.5 block text-control font-medium text-muted" for="session-name"
      >Task name</label
    >
    <input class={dialogInputClass} id="session-name" bind:value={renameValue} autocomplete="off" />
    <div class="mt-5 flex justify-end gap-2">
      <button
        class={dialogSecondaryButtonClass}
        type="button"
        onclick={() => renameDialogElement?.close()}>Cancel</button
      ><button
        class={`${dialogPrimaryButtonClass} disabled:opacity-40`}
        type="submit"
        disabled={!renameValue.trim()}>Save name</button
      >
    </div>
  </form>
</dialog>

{#if snapshot?.extensionDialog}
  <dialog
    bind:this={dialogElement}
    class={[appDialogClass, "w-[min(460px,calc(100vw-28px))]"]}
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
      {@render dialogHeader(
        "activity",
        "extension-dialog-title",
        snapshot.extensionDialog.title,
        snapshot.extensionDialog.message,
      )}
      {#if snapshot.extensionDialog.kind === "select"}
        <select class={dialogInputClass} bind:value={dialogValue} aria-label="Response"
          >{#each snapshot.extensionDialog.options ?? [] as option (option)}<option value={option}
              >{option}</option
            >{/each}</select
        >
      {:else if snapshot.extensionDialog.kind === "confirm"}
        <label class="flex items-center gap-2 text-ui text-foreground"
          ><input
            type="checkbox"
            checked={Boolean(dialogValue)}
            onchange={(event) => (dialogValue = event.currentTarget.checked)}
          /> Confirm</label
        >
      {:else if snapshot.extensionDialog.kind === "editor"}
        <textarea class={dialogInputClass} bind:value={dialogValue} aria-label="Response" rows="8"
        ></textarea>
      {:else}
        <input
          class={dialogInputClass}
          bind:value={dialogValue}
          aria-label="Response"
          placeholder={snapshot.extensionDialog.placeholder}
        />
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button
          class={dialogSecondaryButtonClass}
          type="button"
          onclick={() => answerDialog(snapshot!.extensionDialog!, true)}>Cancel</button
        ><button class={dialogPrimaryButtonClass} type="submit">Continue</button>
      </div>
    </form>
  </dialog>
{/if}
