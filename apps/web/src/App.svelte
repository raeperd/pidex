<script lang="ts">
  import { onMount, tick } from "svelte";
  import type {
    Bootstrap,
    ChatSnapshot,
    ExtensionDialog,
    ProjectCandidate,
    RecentWorkspace,
    ServerEvent,
    SessionSummary,
    ToolItem,
    Workspace,
  } from "@pidex/api";
  import { dialogValue as resolveDialogValue, PidexApiClient } from "./api-client";
  import { ChatConnection, type ConnectionState } from "./chat-connection";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";

  const THREAD_PREVIEW_COUNT = 6;
  let bootstrap: Bootstrap | undefined;
  let workspace: Workspace | undefined;
  let snapshot: ChatSnapshot | undefined;
  let workspaceCache: Record<string, Workspace> = {};
  let expandedProjectIds: string[] = [];
  let threadLimits: Record<string, number> = {};
  let projectPath = "";
  let projectQuery = "";
  let draft = "";
  let search = "";
  let connection: ConnectionState = "disconnected";
  let error = "";
  let bootstrapError = "";
  let drawerOpen = false;
  let projectLoading = false;
  let projectLoadingId = "";
  let projectBatchLoading = false;
  let projectBatchProgress = 0;
  let chatLoading = false;
  let retryingConnection = false;
  let loadingEarlier = false;
  let delivery: "normal" | "steer" | "follow-up" = "normal";
  let pendingPrompt:
    | { actionId: string; text: string; delivery: "normal" | "steer" | "follow-up" }
    | undefined;
  let copyState: Record<string, "copied" | "failed"> = {};
  let toolOutputs: Record<
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
  > = {};
  // oxlint-disable no-unassigned-vars -- Assigned by Svelte's bind:this directive.
  let transcript: HTMLElement;
  let searchInput: HTMLInputElement;
  let promptInput: HTMLTextAreaElement;
  let nearBottom = true;
  let dialogValue: string | boolean = "";
  let dialogElement: HTMLDialogElement;
  let projectDialogElement: HTMLDialogElement;
  let renameDialogElement: HTMLDialogElement;
  let renameValue = "";
  let compactDialogElement: HTMLDialogElement;
  // oxlint-enable no-unassigned-vars
  const api = new PidexApiClient();
  const chatConnection = new ChatConnection({
    onEvent: applyEvent,
    onStateChange: (state) => (connection = state),
  });

  const active = () => snapshot && snapshot.runStatus !== "idle" && snapshot.runStatus !== "error";
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
  function sessionsFor(project: RecentWorkspace) {
    const loaded = workspaceFor(project.id);
    if (!loaded) return [];
    const query = search.trim().toLowerCase();
    if (!query || loaded.name.toLowerCase().includes(query)) return loaded.sessions;
    return loaded.sessions.filter((session) =>
      `${session.name ?? ""} ${session.firstMessage}`.toLowerCase().includes(query),
    );
  }
  function visibleProjects() {
    const query = search.trim().toLowerCase();
    return (bootstrap?.recentWorkspaces ?? []).filter(
      (project) =>
        !query ||
        projectName(project.path).toLowerCase().includes(query) ||
        sessionsFor(project).length > 0,
    );
  }
  function availableProjects() {
    const query = projectQuery.trim().toLowerCase();
    return (bootstrap?.projectCandidates ?? []).filter(
      (candidate) => !query || candidate.name.toLowerCase().includes(query),
    );
  }
  function projectAdded(candidate: ProjectCandidate) {
    return Boolean(bootstrap?.recentWorkspaces.some((project) => project.path === candidate.path));
  }
  function currentTitle() {
    if (snapshot?.sessionName) return snapshot.sessionName;
    const firstUser = snapshot?.items.find((item) => item.type === "user");
    if (firstUser?.type === "user")
      return firstUser.text.split("\n")[0]?.slice(0, 64) || workspace?.name || "Pidex";
    return workspace?.name ?? "Pidex";
  }
  const relativeTime = (value: string) => {
    const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
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
      if (savedPath) await openProject(savedPath, { closeDrawer: false });
    } catch (cause) {
      bootstrapError = cause instanceof Error ? cause.message : "The Pidex host is unavailable";
    }
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
        if (options.closeDrawer ?? true) drawerOpen = false;
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
    if (loaded) projectDialogElement.close();
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
    projectDialogElement.close();
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
  async function newChat(target = workspace) {
    if (!target || chatLoading) return;
    try {
      error = "";
      chatLoading = true;
      workspace = target;
      projectPath = target.path;
      rememberWorkspace(target);
      localStorage.setItem("pidex:last-project", target.path);
      snapshot = await api.createChat(target.id);
      await afterChat();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not create chat";
    } finally {
      chatLoading = false;
    }
  }
  async function newChatInProject(project: RecentWorkspace) {
    const target =
      workspaceFor(project.id) ??
      (await openProject(project.path, { activate: false, moveToTop: false }));
    if (target) await newChat(target);
  }
  async function resume(session: SessionSummary, target: Workspace) {
    if (chatLoading) return;
    try {
      error = "";
      chatLoading = true;
      workspace = target;
      projectPath = target.path;
      rememberWorkspace(target);
      localStorage.setItem("pidex:last-project", target.path);
      snapshot = await api.resumeChat(target.id, session.id);
      await afterChat();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Resume failed";
    } finally {
      chatLoading = false;
    }
  }
  async function afterChat() {
    drawerOpen = false;
    draft = localStorage.getItem(`pidex:draft:${snapshot?.sessionId}`) ?? "";
    restorePendingPrompt();
    if (snapshot) chatConnection.connect(snapshot.chatId);
    await tick();
    resizePrompt();
    scrollLatest();
  }
  function replaceItem(item: ChatSnapshot["items"][number]) {
    if (!snapshot) return;
    const items = [...snapshot.items];
    const index = items.findIndex((old) => old.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    snapshot = { ...snapshot, items };
  }
  function applyEvent(event: ServerEvent) {
    if (!snapshot) return;
    if (event.type === "snapshot") {
      snapshot = event.snapshot;
      if (pendingPrompt && event.snapshot.run?.actionId === pendingPrompt.actionId)
        clearPendingPrompt();
    } else if (event.type === "message" || event.type === "tool" || event.type === "notice")
      replaceItem(event.item);
    else if (event.type === "text_delta")
      snapshot = {
        ...snapshot,
        items: snapshot.items.map((item) =>
          item.id === event.itemId && item.type === "assistant"
            ? {
                ...item,
                ...(event.channel === "text"
                  ? { text: item.text + event.delta }
                  : { thinking: (item.thinking ?? "") + event.delta }),
              }
            : item,
        ),
      };
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
    else if (event.type === "session") {
      snapshot = {
        ...snapshot,
        ...(event.name ? { sessionName: event.name } : {}),
        stats: event.stats,
      };
      void refreshSessions();
    } else if (event.type === "extension_dialog") {
      snapshot = { ...snapshot, ...(event.dialog ? { extensionDialog: event.dialog } : {}) };
      if (event.dialog) {
        dialogValue = event.dialog.kind === "confirm" ? false : (event.dialog.prefill ?? "");
        void tick().then(() => dialogElement?.showModal());
      } else dialogElement?.close();
    }
    if (nearBottom) requestAnimationFrame(scrollLatest);
  }
  function pendingKey() {
    return snapshot ? `pidex:pending:${snapshot.sessionId}` : "";
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
    const text = draft.trim();
    const mode = active() ? delivery : "normal";
    const matching =
      pendingPrompt?.text === text && pendingPrompt.delivery === mode ? pendingPrompt : undefined;
    pendingPrompt = matching ?? { actionId: api.createActionId(), text, delivery: mode };
    localStorage.setItem(pendingKey(), JSON.stringify(pendingPrompt));
    draft = "";
    persistDraft();
    void tick().then(resizePrompt);
    try {
      const outcome = await api.sendMessage(
        snapshot.chatId,
        text,
        mode,
        snapshot.revision,
        active() ? snapshot.run?.runId : undefined,
        pendingPrompt.actionId,
      );
      snapshot = { ...snapshot, revision: Math.max(snapshot.revision, outcome.revision) };
      clearPendingPrompt();
    } catch (cause) {
      draft = text;
      persistDraft();
      void tick().then(resizePrompt);
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
  async function configure(patch: Parameters<PidexApiClient["configure"]>[1]) {
    if (!snapshot) return;
    try {
      snapshot = await api.configure(snapshot.chatId, patch, snapshot.revision);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Configuration failed";
    }
  }
  function openRename() {
    if (!snapshot) return;
    renameValue = snapshot.sessionName ?? currentTitle();
    void tick().then(() => renameDialogElement?.showModal());
  }
  async function rename() {
    if (!snapshot || !renameValue.trim()) return;
    try {
      snapshot = await api.rename(snapshot.chatId, renameValue.trim(), snapshot.revision);
      renameDialogElement.close();
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
      compactDialogElement.close();
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
      dialogElement.close();
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
    loadingEarlier = true;
    try {
      const page = await api.transcript(snapshot.chatId, snapshot.transcriptStart);
      const seen = new Set(snapshot.items.map((item) => item.id));
      snapshot = {
        ...snapshot,
        items: [...page.items.filter((item) => !seen.has(item.id)), ...snapshot.items],
        transcriptStart: page.start,
        transcriptTotal: page.total,
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
      if (snapshot) {
        snapshot = await api.getChat(snapshot.chatId);
        chatConnection.reconnect();
      } else await loadBootstrap();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The Pidex host is still unavailable";
    } finally {
      retryingConnection = false;
    }
  }
  function persistDraft() {
    if (snapshot) localStorage.setItem(`pidex:draft:${snapshot.sessionId}`, draft);
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
    if (matchMedia("(max-width: 900px)").matches) drawerOpen = true;
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }
  function globalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      void focusSearch();
      return;
    }
    if (event.key !== "Escape") return;
    if (drawerOpen) {
      drawerOpen = false;
      (document.querySelector(".menu-button") as HTMLElement)?.focus();
      return;
    }
    if (document.activeElement === searchInput) {
      if (search) search = "";
      else promptInput?.focus();
    }
  }
  function wentOffline() {
    chatConnection.disconnect();
  }
  function cameOnline() {
    if (snapshot) chatConnection.reconnect();
  }
  onMount(() => {
    projectPath = localStorage.getItem("pidex:last-project") ?? "";
    void loadBootstrap();
    window.addEventListener("keydown", globalKeydown);
    window.addEventListener("offline", wentOffline);
    window.addEventListener("online", cameOnline);
    return () => {
      window.removeEventListener("keydown", globalKeydown);
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener("online", cameOnline);
      chatConnection.close();
    };
  });
</script>

<svelte:head>
  <title>Pidex</title>
  <meta name="description" content="Private local Pi dashboard" />
</svelte:head>

<div class:drawer-open={drawerOpen} class="shell">
  <button class="scrim" aria-label="Close sessions" onclick={() => (drawerOpen = false)}></button>

  <aside aria-label="Sessions">
    <div class="sidebar-titlebar">
      <div class="brand">
        <div class="mark">π</div>
        <strong>Pidex</strong>
        <span>LOCAL</span>
      </div>
      <button
        class="square-button"
        onclick={() => newChat()}
        disabled={!workspace || chatLoading}
        aria-label="New chat"
        title="New chat"
      >
        <Icon name="compose" />
      </button>
    </div>

    <label class="search">
      <Icon name="search" />
      <input
        bind:this={searchInput}
        bind:value={search}
        aria-label="Search projects and threads"
        aria-keyshortcuts="Meta+K Control+K"
        placeholder="Search projects and threads"
      />
      <kbd aria-hidden="true">⌘K</kbd>
    </label>

    <section class="project-browser">
      <div class="section-label">
        <span>PROJECTS <small>{bootstrap?.recentWorkspaces.length ?? 0}</small></span>
        <button
          class="section-add"
          onclick={openProjectPicker}
          aria-label="Add project"
          title="Add project"><Icon name="folder-plus" size={15} /></button
        >
      </div>
      <nav class="project-tree" aria-label="Projects" aria-busy={chatLoading || projectLoading}>
        {#if visibleProjects().length === 0}
          <div class="sidebar-empty">
            <Icon name={search ? "search" : "folder"} size={18} />
            <p>{search ? "No matching projects or tasks." : "Add a project to get started."}</p>
            {#if !search}<button onclick={openProjectPicker}>Add project</button>{/if}
          </div>
        {:else}
          {#each visibleProjects() as project (project.id)}
            {@const loaded =
              workspaceCache[project.id] ?? (workspace?.id === project.id ? workspace : undefined)}
            {@const expanded =
              expandedProjectIds.includes(project.id) || Boolean(search.trim() && loaded)}
            {@const matchingSessions = sessionsFor(project)}
            {@const sessionLimit = search.trim()
              ? matchingSessions.length
              : (threadLimits[project.id] ?? THREAD_PREVIEW_COUNT)}
            {@const shownSessions = expanded
              ? matchingSessions.slice(0, sessionLimit)
              : matchingSessions.filter(
                  (session) => workspace?.id === project.id && snapshot?.sessionId === session.id,
                )}
            {@const hiddenSessions = expanded
              ? Math.max(0, matchingSessions.length - shownSessions.length)
              : 0}
            <div
              class:active-project-group={workspace?.id === project.id}
              class:expanded
              class="project-group"
            >
              <div class="project-row">
                <button
                  class="project-toggle"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${projectLabel(project)}`}
                  title={projectLabel(project)}
                  onclick={() => toggleProject(project)}
                >
                  <span class="project-chevron"><Icon name="chevron" size={13} /></span>
                  <span class="project-icon"><Icon name="folder" size={15} /></span>
                  <strong>{projectLabel(project)}</strong>
                  {#if projectLoadingId === project.id}<span class="project-count loading">•••</span
                    >{:else if loaded}<span class="project-count">{loaded.sessions.length}</span
                    >{/if}
                </button>
                <button
                  class="project-new"
                  onclick={() => newChatInProject(project)}
                  disabled={chatLoading || projectLoadingId === project.id}
                  aria-label={`New thread in ${projectLabel(project)}`}
                  title="New thread"
                >
                  <Icon name="compose" size={14} />
                </button>
              </div>
              {#if expanded || shownSessions.length > 0}
                <div class="project-threads" id={`project-${project.id}`}>
                  {#if projectLoadingId === project.id && !loaded}
                    <p class="tree-empty">Loading threads…</p>
                  {:else if loaded && shownSessions.length === 0}
                    <p class="tree-empty">{search ? "No matching threads." : "No threads yet."}</p>
                  {:else if loaded}
                    {#each shownSessions as session}
                      <button
                        class:current={snapshot?.sessionId === session.id}
                        class="thread-row"
                        onclick={() => resume(session, loaded)}
                        disabled={chatLoading}
                        title={session.name ?? session.firstMessage}
                      >
                        <span class="thread-pip"></span>
                        <strong
                          >{session.name ?? (session.firstMessage || "Untitled session")}</strong
                        >
                        {#if snapshot?.sessionId === session.id && active()}<span
                            class="thread-status"><i></i>Working</span
                          >{:else}<time datetime={session.modifiedAt}
                            >{relativeTime(session.modifiedAt)}</time
                          >{/if}
                      </button>
                    {/each}
                    {#if hiddenSessions > 0}
                      <button
                        class="show-more"
                        onclick={() =>
                          (threadLimits = { ...threadLimits, [project.id]: sessionLimit + 10 })}
                        >Show more <span>{hiddenSessions} hidden</span></button
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

    <div class="sidebar-footer">
      <Icon name="shield" size={15} />
      <p><strong>Local & private</strong><span>Read-only limits tools, not the OS.</span></p>
      <small>{bootstrap?.piVersion ?? "Pi"}</small>
    </div>
  </aside>

  <main>
    <header class="topbar">
      <button
        class="menu-button"
        aria-label="Open sessions"
        aria-expanded={drawerOpen}
        onclick={() => (drawerOpen = true)}
      >
        <Icon name="menu" size={19} />
      </button>
      <div class="title-block">
        <strong>{currentTitle()}</strong>
        <div class="title-meta">
          <span>{workspace?.name ?? "No project"}</span>
          <span class="meta-divider">/</span>
          <span class:online={connection === "connected"} class="status-dot"></span>
          <span>{snapshot ? connection : "local"}</span>
        </div>
      </div>
      {#if snapshot}
        <div class="header-actions">
          <button
            onclick={openRename}
            disabled={active()}
            aria-label="Rename"
            title="Rename session"><Icon name="rename" /><span>Rename</span></button
          >
          <button
            onclick={openCompact}
            disabled={active()}
            aria-label="Compact"
            title="Compact session"><Icon name="compact" /><span>Compact</span></button
          >
        </div>
      {/if}
    </header>

    {#if error}
      <div class="alert error" role="alert">
        <span>{error}</span><button aria-label="Dismiss error" onclick={() => (error = "")}
          ><Icon name="x" /></button
        >
      </div>
    {/if}
    {#if snapshot && connection !== "connected"}
      <div class="alert offline" role="status">
        <span
          ><strong>Host unavailable.</strong> Your session remains on the desktop; drafts will not be
          submitted while disconnected.</span
        ><button onclick={retryConnection} disabled={retryingConnection}
          >{retryingConnection ? "Retrying…" : "Retry"}</button
        >
      </div>
    {/if}
    {#if snapshot?.run?.requiresAcknowledgement}
      <div class="alert warning interrupted" role="alert">
        <span
          ><strong>Run interrupted.</strong> The host cannot prove whether this run completed before it
          stopped. Review the Pi transcript, then acknowledge before sending new work.</span
        ><button onclick={acknowledgeInterrupted}>Acknowledge</button>
      </div>
    {/if}
    {#if workspace?.protectedResourcesSkipped}
      <div class="alert warning" role="status">
        <span
          >Project resources requiring trust were skipped. {window.pidexDesktop
            ? "Review the project before loading them."
            : "Open Pidex Desktop or Pi locally to review trust."}</span
        >{#if window.pidexDesktop}<button onclick={approveProjectTrust}>Review & trust</button>{/if}
      </div>
    {/if}
    {#if workspace?.resourceDiagnostics.length}
      <div class="alert warning resource-warning" role="status">
        <span
          ><strong>Pi resource warning.</strong>
          {workspace.resourceDiagnostics[0]?.message}{#if workspace.resourceDiagnostics.length > 1}
            · {workspace.resourceDiagnostics.length - 1} more{/if}</span
        >
      </div>
    {/if}
    {#if workspace && workspace.models.length === 0}
      <div class="alert warning">
        No authenticated models are available. Run <code>pi</code> and use <code>/login</code> locally.
      </div>
    {/if}

    <section class="transcript" bind:this={transcript} onscroll={onScroll} aria-live="polite">
      {#if bootstrapError && !bootstrap}
        <div class="empty offline-state" role="status">
          <div class="hero-mark"><Icon name="activity" size={22} /></div>
          <p class="eyebrow">HOST UNAVAILABLE</p>
          <h1>Your projects are still on the desktop.</h1>
          <p>
            Pidex could not reach its local host. Nothing was deleted and no draft will be submitted
            automatically.
          </p>
          <button class="retry-button" onclick={retryConnection} disabled={retryingConnection}
            >{retryingConnection ? "Retrying…" : "Retry connection"}</button
          >
        </div>
      {:else if !workspace}
        <div class="empty">
          <div class="hero-mark"><span>π</span></div>
          <p class="eyebrow">YOUR PRIVATE PI WORKSPACE</p>
          <h1>Bring Pi with you.</h1>
          <p>Choose a project to create or resume a native Pi session.</p>
          <button class="retry-button hero-add" onclick={openProjectPicker}>Add a project</button>
        </div>
      {:else if !snapshot}
        <div class="empty workspace-empty">
          <div class="hero-project">{workspace.name.slice(0, 1).toUpperCase()}</div>
          <p class="eyebrow">{workspace.name}</p>
          <h1>What should Pi work on?</h1>
          <p>Start a fresh thread or pick up a native Pi session from the sidebar.</p>
          <button
            class="hero-composer"
            onclick={() => newChat()}
            disabled={!workspace.models.length || chatLoading}
          >
            <span>Start a new chat</span><span class="hero-send"><Icon name="send" /></span>
          </button>
        </div>
      {:else}
        <div class="messages">
          {#if snapshot.transcriptStart > 0}<button
              class="load-earlier"
              onclick={loadEarlier}
              disabled={loadingEarlier}
              >{loadingEarlier
                ? "Loading earlier messages…"
                : `Load earlier messages · ${snapshot.transcriptStart.toLocaleString()} remaining`}</button
            >{/if}
          {#each snapshot.items as item (item.id)}
            {#if item.type === "user"}
              <article class="message user">
                <div class="bubble">{item.text}</div>
              </article>
            {:else if item.type === "assistant"}
              <article class="message assistant">
                <div class="assistant-label">
                  <span class="pi-avatar">π</span><span>Pi</span>{#if !item.complete}<span
                      class="streaming">streaming</span
                    >{:else}<button
                      class:copy-failed={copyState[item.id] === "failed"}
                      class="copy-response"
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
                  <details class="thinking">
                    <summary
                      ><span class="thinking-dots"><i></i><i></i><i></i></span>Thinking</summary
                    >
                    <pre>{item.thinking}</pre>
                  </details>
                {/if}
                <Markdown text={item.text} />
              </article>
            {:else if item.type === "tool"}
              <details class="tool">
                <summary>
                  <span class="tool-icon"><Icon name="tool" size={14} /></span>
                  <strong>{item.name}</strong>
                  <code>{item.argumentSummary}</code>
                  <span class:failed={item.state === "error"} class="tool-state"
                    >{item.state === "success" ? "done" : item.state}</span
                  >
                  <Icon name="chevron" size={13} />
                </summary>
                {#if item.resourceId && toolOutputs[item.resourceId]?.text}<pre>{toolOutputs[
                      item.resourceId
                    ]?.text}</pre>{:else if item.preview}<pre>{item.preview}</pre>{/if}
                {#if item.resourceId && !toolOutputs[item.resourceId]?.complete}
                  <button
                    class="tool-load"
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
                    class="tool-note"
                  >
                    The host bounded this output at its safety limit.
                  </p>{/if}
                {#if item.resourceId && toolOutputs[item.resourceId]?.error}<p
                    class="tool-note failed"
                  >
                    {toolOutputs[item.resourceId]?.error}
                  </p>{/if}
              </details>
            {:else if item.type === "notice"}
              <div class:notice-error={item.level === "error"} class="notice">
                <Icon name="activity" size={14} /><span>{item.text}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </section>

    {#if !nearBottom && snapshot}<button class="jump" onclick={scrollLatest}
        >Jump to latest <span>↓</span></button
      >{/if}

    {#if snapshot}
      <footer class="composer-wrap">
        {#if active()}
          <div class="queue-row">
            <span
              ><span class="working-dot"></span>{snapshot.runStatus} · {snapshot.steeringQueue
                .length} steer · {snapshot.followUpQueue.length} follow-up</span
            >
            {#if snapshot.steeringQueue.length + snapshot.followUpQueue.length > 0}<button
                onclick={clearQueue}>Clear queues</button
              >{/if}
          </div>
        {/if}
        <div class="composer-frame">
          <textarea
            bind:this={promptInput}
            bind:value={draft}
            oninput={draftInput}
            onkeydown={keydown}
            rows="2"
            placeholder={connection !== "connected"
              ? "Draft locally while the host reconnects…"
              : active()
                ? "Add guidance while Pi works…"
                : "Ask Pi to work on this project…"}
            aria-label="Prompt"></textarea>
          <div class="composer-toolbar">
            <div class="composer-controls">
              <select
                aria-label="Model"
                value={snapshot.model}
                onchange={(e) => configure({ model: e.currentTarget.value })}
                disabled={active() || !workspace?.models.length}
              >
                {#each workspace?.models ?? [] as model}<option value={model.id}
                    >{model.name}</option
                  >{/each}
              </select>
              <span class="control-divider"></span>
              <select
                aria-label="Thinking level"
                value={snapshot.thinkingLevel}
                onchange={(e) =>
                  configure({
                    thinkingLevel: e.currentTarget.value as ChatSnapshot["thinkingLevel"],
                  })}
                disabled={active()}
              >
                {#each ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as level}<option
                    value={level}>{level} thinking</option
                  >{/each}
              </select>
              <span class="control-divider"></span>
              <select
                aria-label="Tool access"
                value={snapshot.toolMode}
                onchange={(e) =>
                  configure({ toolMode: e.currentTarget.value as ChatSnapshot["toolMode"] })}
                disabled={active()}
              >
                <option value="read-only">Read only</option><option value="full">Full access</option
                >
              </select>
            </div>
            <div class="composer-actions">
              {#if active()}
                <select bind:value={delivery} aria-label="Delivery mode"
                  ><option value="steer">Steer</option><option value="follow-up">Follow-up</option
                  ></select
                >
                <button
                  class="stop"
                  onclick={stop}
                  disabled={connection !== "connected"}
                  aria-label="Stop"><Icon name="stop" /></button
                >
                <button
                  class="send queue"
                  onclick={send}
                  disabled={!draft.trim() || connection !== "connected"}
                  aria-label="Queue">Queue</button
                >
              {:else}
                <button
                  class="send"
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
        <div class="composer-meta">
          <span
            >{snapshot.stats.messages} messages · {snapshot.stats.tokens.toLocaleString()} tokens · ${snapshot.stats.cost.toFixed(
              4,
            )}</span
          >
          <span>{snapshot.activeTools.join(" · ")}</span>
        </div>
      </footer>
    {/if}
  </main>
</div>

<dialog
  bind:this={projectDialogElement}
  class="app-dialog project-dialog"
  aria-labelledby="project-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    if (!projectBatchLoading) projectDialogElement.close();
  }}
>
  <form method="dialog" onsubmit={(event) => event.preventDefault()}>
    <div class="dialog-heading">
      <div class="dialog-icon"><Icon name="folder-plus" /></div>
      <div>
        <h2 id="project-dialog-title">Add a project</h2>
        <p>Choose by project name. Folder paths stay out of the main workspace UI.</p>
      </div>
    </div>
    <label class="picker-search">
      <Icon name="search" size={15} />
      <input
        bind:value={projectQuery}
        aria-label="Filter available projects"
        placeholder="Filter projects"
        autocomplete="off"
      />
    </label>
    <div class="picker-summary">
      <span
        ><strong>Projects</strong><small>{availableProjects().length} folders discovered</small
        ></span
      >
      {#if (bootstrap?.projectCandidates ?? []).some((candidate) => !projectAdded(candidate))}
        <button type="button" onclick={addAllProjects} disabled={projectBatchLoading}
          >{projectBatchLoading ? `Adding ${projectBatchProgress + 1}…` : "Add all"}</button
        >
      {/if}
    </div>
    <div class="project-candidates">
      {#if availableProjects().length === 0}
        <div class="candidate-empty">
          <Icon name="folder" size={18} /><span
            >{projectQuery ? "No matching projects" : "No project folders were found"}</span
          >
        </div>
      {:else}
        {#each availableProjects() as candidate (candidate.path)}
          <button
            type="button"
            class:added={projectAdded(candidate)}
            class="candidate-row"
            onclick={() => addProject(candidate)}
            disabled={projectBatchLoading || projectLoading}
            aria-label={`${projectAdded(candidate) ? "Open" : "Add"} ${candidate.name}`}
          >
            <span class="candidate-avatar">{candidate.name.slice(0, 1).toUpperCase()}</span>
            <span class="candidate-copy"
              ><strong>{candidate.name}</strong><small
                >{projectAdded(candidate) ? "Added to Pidex" : "Local project"}</small
              ></span
            >
            <span class="candidate-action">{projectAdded(candidate) ? "Open" : "Add"}</span>
          </button>
        {/each}
      {/if}
    </div>
    <div class="dialog-actions project-dialog-actions">
      {#if window.pidexDesktop}<button
          type="button"
          class="browse-other"
          onclick={browseProject}
          disabled={projectBatchLoading}
          ><Icon name="folder" size={14} /> Browse another folder</button
        >{/if}
      <button
        type="button"
        onclick={() => projectDialogElement.close()}
        disabled={projectBatchLoading}>Done</button
      >
    </div>
  </form>
</dialog>

<dialog
  bind:this={renameDialogElement}
  class="app-dialog"
  oncancel={(event) => {
    event.preventDefault();
    renameDialogElement.close();
  }}
>
  <form
    method="dialog"
    onsubmit={(event) => {
      event.preventDefault();
      void rename();
    }}
  >
    <div class="dialog-heading">
      <div class="dialog-icon"><Icon name="rename" /></div>
      <div>
        <h2>Rename thread</h2>
        <p>Give this Pi session a concise, memorable name.</p>
      </div>
    </div>
    <label for="session-name">Session name</label>
    <input id="session-name" bind:value={renameValue} autocomplete="off" />
    <div class="dialog-actions">
      <button type="button" onclick={() => renameDialogElement.close()}>Cancel</button><button
        class="primary"
        type="submit"
        disabled={!renameValue.trim()}>Save name</button
      >
    </div>
  </form>
</dialog>

<dialog
  bind:this={compactDialogElement}
  class="app-dialog"
  oncancel={(event) => {
    event.preventDefault();
    compactDialogElement.close();
  }}
>
  <form
    method="dialog"
    onsubmit={(event) => {
      event.preventDefault();
      void compact();
    }}
  >
    <div class="dialog-heading">
      <div class="dialog-icon"><Icon name="compact" /></div>
      <div>
        <h2>Compact this thread?</h2>
        <p>Pi will summarize older context to free space in the active context window.</p>
      </div>
    </div>
    <div class="dialog-actions">
      <button type="button" onclick={() => compactDialogElement.close()}>Cancel</button><button
        class="primary"
        type="submit">Compact thread</button
      >
    </div>
  </form>
</dialog>

{#if snapshot?.extensionDialog}
  <dialog
    bind:this={dialogElement}
    class="app-dialog extension-dialog"
    oncancel={(event) => {
      event.preventDefault();
      void answerDialog(snapshot!.extensionDialog!, true);
    }}
  >
    <form
      method="dialog"
      onsubmit={(event) => {
        event.preventDefault();
        void answerDialog(snapshot!.extensionDialog!);
      }}
    >
      <div class="dialog-heading">
        <div class="dialog-icon"><Icon name="activity" /></div>
        <div>
          <h2>{snapshot.extensionDialog.title}</h2>
          {#if snapshot.extensionDialog.message}<p>{snapshot.extensionDialog.message}</p>{/if}
        </div>
      </div>
      {#if snapshot.extensionDialog.kind === "select"}
        <select bind:value={dialogValue}
          >{#each snapshot.extensionDialog.options ?? [] as option}<option value={option}
              >{option}</option
            >{/each}</select
        >
      {:else if snapshot.extensionDialog.kind === "confirm"}
        <label class="confirm-row"
          ><input
            type="checkbox"
            checked={Boolean(dialogValue)}
            onchange={(event) => (dialogValue = event.currentTarget.checked)}
          /> Confirm</label
        >
      {:else if snapshot.extensionDialog.kind === "editor"}
        <textarea bind:value={dialogValue} rows="8"></textarea>
      {:else}
        <input bind:value={dialogValue} placeholder={snapshot.extensionDialog.placeholder} />
      {/if}
      <div class="dialog-actions">
        <button type="button" onclick={() => answerDialog(snapshot!.extensionDialog!, true)}
          >Cancel</button
        ><button class="primary" type="submit">Continue</button>
      </div>
    </form>
  </dialog>
{/if}
