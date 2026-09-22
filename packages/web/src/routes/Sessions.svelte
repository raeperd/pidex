<script module lang="ts">
  function activityLabel(value: string) {
    const date = new Date(value);
    const today = new Date();
    return date.toDateString() === today.toDateString()
      ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
        });
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import type { SessionList } from "../../../api/index.js";

  let { projectPath, oncurrent }: { projectPath: string; oncurrent: () => void } = $props();
  let result = $state.raw<typeof SessionList.Encoded>();
  let loading = $state(true);
  let error = $state("");
  let selected = $state("");
  let query = $state("");
  const session = $derived(result?.sessions.find((entry) => entry.sessionFile === selected));
  const matches = $derived(
    result?.sessions.filter((entry) =>
      entry.title.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [],
  );
  onMount(() => {
    void load();
  });

  async function load() {
    loading = true;
    error = "";
    try {
      result = await window.desktop.listSessions(projectPath);
    } catch {
      error = "Could not load saved sessions. Check the connection, then Retry.";
    } finally {
      loading = false;
    }
  }
</script>

<section aria-label="Saved sessions" class="flex h-full min-h-0 flex-col">
  <div class="shrink-0 px-3 pt-4 pb-3">
    <label
      class="flex items-center gap-2 rounded-lg px-2 py-2 text-muted focus-within:bg-raised has-focus-visible:outline-2 has-focus-visible:outline-focus"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
      </svg>
      <input
        type="search"
        aria-label="Search saved sessions"
        placeholder="Search sessions"
        bind:value={query}
        class="min-w-0 w-full border-0 bg-transparent p-0 font-sans text-sm text-foreground placeholder:text-muted focus-visible:outline-none"
      />
    </label>
    <button
      class="mt-4 flex w-full cursor-pointer items-center gap-3 rounded-lg border border-solid border-border/60 bg-raised/60 px-3 py-3 text-left font-sans text-foreground hover:bg-raised"
      onclick={() => {
        selected = "";
        oncurrent();
      }}
      aria-label="Current session"
    >
      <svg
        class="shrink-0 text-muted"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="M20 11.5a8 8 0 0 1-8 8H4l1.4-4A8 8 0 1 1 20 11.5Z" />
      </svg>
      <span class="flex-1 text-sm">Current session</span>
      <span class="flex items-center gap-1.5 text-[11px] text-info"
        ><span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>Active</span
      >
    </button>
  </div>

  <div class="flex shrink-0 items-center justify-between px-5 pt-3 pb-2">
    <h2 class="m-0 text-[11px] font-medium tracking-[0.08em] text-muted uppercase">
      Saved sessions
    </h2>
    <div class="flex items-center gap-2">
      {#if result}<span class="text-[11px] tabular-nums text-muted">{result.sessions.length}</span
        >{/if}
      <button
        class="flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-raised hover:text-foreground disabled:cursor-default disabled:opacity-40"
        aria-label={error || result?.errors.length ? "Retry" : "Refresh sessions"}
        title={error || result?.errors.length ? "Retry" : "Refresh sessions"}
        onclick={load}
        disabled={loading}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19.5 10M4.5 14a8 8 0 0 0 13.4 3.9" />
        </svg>
      </button>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-busy={loading}>
    {#if loading}
      <p class="px-2 text-xs text-muted" aria-live="polite">Loading saved sessions…</p>
    {/if}
    {#if error}<p class="rounded-lg bg-error/5 p-3 text-xs" role="alert">{error}</p>{/if}
    {#each result?.errors ?? [] as failure (failure.path)}
      <p class="rounded-lg bg-error/5 p-3 text-xs" role="alert">{failure.message}</p>
    {/each}
    {#if !loading && result && result.sessions.length === 0 && result.errors.length === 0 && !error}
      <div class="px-2 py-5 text-xs leading-relaxed text-muted">
        <p class="m-0 text-foreground/80">No saved sessions in this project.</p>
        <p class="mt-2 mb-0">Your conversations will appear here once they’re saved.</p>
      </div>
    {:else if !loading && result?.sessions.length && matches.length === 0}
      <p class="px-2 py-5 text-xs text-muted">No sessions match “{query}”.</p>
    {/if}
    {#if matches.length}
      <fieldset class="m-0 min-w-0 border-0 p-0">
        <legend class="sr-only">Select a saved session to inspect its details</legend>
        {#each matches as entry (entry.sessionFile)}
          <label
            class="group relative mb-1 block cursor-pointer rounded-lg border border-solid border-transparent px-3 py-3 hover:bg-raised/70 has-checked:border-border/70 has-checked:bg-raised has-focus-visible:outline-2 has-focus-visible:outline-focus has-focus-visible:outline-offset-[-2px]"
            title={entry.title}
          >
            <input
              class="absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
              type="radio"
              name="saved-session"
              value={entry.sessionId}
              checked={selected === entry.sessionFile}
              onchange={() => {
                selected = entry.sessionFile;
              }}
            />
            <span class="mb-1.5 block truncate text-[13px] leading-snug text-foreground/90"
              >{entry.title}</span
            >
            <span class="flex items-center gap-2 text-[11px] text-muted">
              <time datetime={entry.modified} title={new Date(entry.modified).toLocaleString()}
                >{activityLabel(entry.modified)}</time
              >
              <span
                class="ml-auto opacity-0 group-hover:opacity-100 group-has-checked:opacity-100 group-has-focus-visible:opacity-100"
                >Details <span aria-hidden="true">↗</span></span
              >
            </span>
          </label>
        {/each}
      </fieldset>
    {/if}
  </div>

  <div
    class="max-h-[40%] shrink-0 overflow-auto border-0 border-t border-solid border-border/60 px-5 py-4 text-xs text-muted"
  >
    {#if session}
      <p class="mt-0 mb-2 truncate font-medium text-foreground" title={session.title}>
        {session.title}
      </p>
      <p class="my-0 leading-relaxed">Viewing details only. Your current session stays active.</p>
      <details class="mt-3">
        <summary class="cursor-pointer text-[11px] hover:text-foreground">Session details</summary>
        <dl class="mb-0 text-[11px] wrap-anywhere">
          <dt class="text-foreground/80">Project directory</dt>
          <dd class="mt-1 mb-3 ml-0" aria-label="Project directory">{session.projectPath}</dd>
          <dt class="text-foreground/80">Session file</dt>
          <dd class="mt-1 ml-0" aria-label="Session file">{session.sessionFile}</dd>
        </dl>
      </details>
    {:else}
      <p class="m-0 leading-relaxed">
        Browse saved history. Resuming sessions isn’t available yet.
      </p>
    {/if}
  </div>
</section>
