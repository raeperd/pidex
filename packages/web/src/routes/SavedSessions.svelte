<script lang="ts">
  import { onMount } from "svelte";
  import type { SessionList } from "../../../api/index.js";

  let { projectPath }: { projectPath: string } = $props();
  let result = $state.raw<typeof SessionList.Encoded>();
  let loading = $state(true);
  let error = $state("");
  let selected = $state("");
  const session = $derived(result?.sessions.find((entry) => entry.sessionFile === selected));
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

<section
  aria-label="Saved sessions"
  class="shrink-0 border-0 border-b border-solid border-border px-6 py-3 max-[520px]:px-4"
>
  <details open>
    <summary class="cursor-pointer text-sm font-medium">Saved sessions</summary>
    <div class="max-h-[25dvh] overflow-auto text-sm">
      {#if loading}
        <p aria-live="polite">Loading saved sessions…</p>
      {:else}
        {#if error}<p role="alert">{error}</p>{/if}
        {#each result?.errors ?? [] as failure (failure.path)}<p role="alert">
            {failure.message}
          </p>{/each}
        {#if result && result.sessions.length === 0 && result.errors.length === 0 && !error}
          <p class="text-muted">No saved sessions in this project.</p>
        {/if}
        {#if result?.sessions.length}
          <fieldset class="m-0 border-0 p-0">
            <legend class="sr-only">Select a saved session to inspect its details</legend>
            {#each result.sessions as entry (entry.sessionFile)}
              <label class="my-2 flex cursor-pointer items-baseline gap-3 wrap-anywhere">
                <input
                  type="radio"
                  name="saved-session"
                  value={entry.sessionId}
                  checked={selected === entry.sessionFile}
                  onchange={() => {
                    selected = entry.sessionFile;
                  }}
                />
                <span class="min-w-0 flex-1">{entry.title}</span>
                <time class="text-xs text-muted" datetime={entry.modified}
                  >{new Date(entry.modified).toLocaleString()}</time
                >
              </label>
            {/each}
          </fieldset>
        {/if}
        {#if session}
          <dl class="text-xs text-muted wrap-anywhere">
            <dt>Project directory</dt>
            <dd class="ml-0" aria-label="Project directory">{session.projectPath}</dd>
            <dt>Session file</dt>
            <dd class="ml-0" aria-label="Session file">{session.sessionFile}</dd>
          </dl>
        {/if}
        <button
          class="cursor-pointer rounded-md border border-solid border-border bg-raised px-3 py-1 text-foreground"
          onclick={load}>{error || result?.errors.length ? "Retry" : "Refresh sessions"}</button
        >
      {/if}
    </div>
  </details>
</section>
