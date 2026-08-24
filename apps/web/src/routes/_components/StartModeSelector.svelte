<script lang="ts">
  import type { TaskStartMode } from "./AppShellContext.svelte";
  import Icon from "./Icon.svelte";

  let {
    editable,
    mode,
    pending,
    select,
  }: {
    editable: boolean;
    mode: TaskStartMode;
    pending: boolean;
    select: (mode: TaskStartMode) => void;
  } = $props();

  let open = $state(false);
  let label = $derived(mode === "worktree" ? "New worktree" : "Work locally");

  function choose(selectedMode: TaskStartMode) {
    select(selectedMode);
    open = false;
  }

  function dismiss(event: MouseEvent) {
    if (open && event.target instanceof Element && !event.target.closest("[data-start-menu]"))
      open = false;
  }

  function keydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = false;
  }
</script>

<svelte:window onclick={dismiss} onkeydown={keydown} />

<div class="relative flex-none" data-start-menu>
  <button
    class="inline-flex h-7 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-control font-medium text-muted enabled:hover:bg-secondary enabled:hover:text-foreground disabled:cursor-default disabled:opacity-70"
    onclick={() => (open = !open)}
    disabled={!editable || pending}
    aria-label={`Start in ${label}`}
    aria-haspopup="menu"
    aria-expanded={open}
    title={editable ? "Choose where to start this task" : `Started in ${label}`}
  >
    <Icon name={mode === "worktree" ? "folder-git" : "folder"} size={13} />
    {pending && mode === "worktree" ? "Creating worktree…" : label}
    {#if editable}<Icon name="arrow-down" size={11} />{/if}
  </button>
  {#if open}
    <div
      class="absolute bottom-full left-0 z-20 mb-2 w-48 rounded-xl border border-border-strong bg-card p-1.5 text-foreground shadow-popover"
      role="menu"
      aria-label="Start in"
    >
      <p class="m-0 px-2 py-1.5 text-meta font-medium text-faint">Start in</p>
      <button
        class="flex h-8 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-control text-muted hover:bg-secondary hover:text-foreground"
        role="menuitemradio"
        aria-checked={mode === "local"}
        onclick={() => choose("local")}
      >
        <Icon name="folder" size={14} />
        <span class="flex-1">Work locally</span>
        {#if mode === "local"}<Icon name="check" size={13} />{/if}
      </button>
      <button
        class="flex h-8 w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-control text-muted hover:bg-secondary hover:text-foreground"
        role="menuitemradio"
        aria-checked={mode === "worktree"}
        onclick={() => choose("worktree")}
      >
        <Icon name="folder-git" size={14} />
        <span class="flex-1">New worktree</span>
        {#if mode === "worktree"}<Icon name="check" size={13} />{/if}
      </button>
    </div>
  {/if}
</div>
