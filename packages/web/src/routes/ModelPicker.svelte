<script module lang="ts">
  function matchesQuery(model: { provider: string; id: string; name: string }, query: string) {
    const text = `${model.provider} ${model.name} ${model.id}`.toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .every((term) => text.includes(term));
  }

  // Display names can repeat; a model is identified by provider and model ID.
  function sameModel(
    model: { provider: string; id: string },
    target: { provider: string; id: string } | null,
  ) {
    return model.provider === target?.provider && model.id === target.id;
  }

  function optionId(index: number) {
    return `model-option-${index}`;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { ModelIdentity, ModelList } from "../../../api/index.js";

  let {
    projectPath,
    sessionId,
    current,
    label,
    onclose,
  }: {
    projectPath: string;
    sessionId: string;
    current: typeof ModelIdentity.Type | null;
    label: string;
    onclose: () => void;
  } = $props();
  let open = $state(false);
  let loading = $state(false);
  let error = $state("");
  let list = $state.raw<typeof ModelList.Encoded>();
  let query = $state("");
  let active = $state(0);
  let search = $state<HTMLInputElement>();
  let request = 0;
  const matches = $derived(list?.models.filter((model) => matchesQuery(model, query)) ?? []);
  const activeModel = $derived(matches[active]);

  async function toggle() {
    if (open) return close();
    open = true;
    query = "";
    await tick();
    search?.focus();
    await load();
  }

  function close(refocus = true) {
    open = false;
    request++;
    list = undefined;
    if (refocus) onclose();
  }

  async function load(keep = current) {
    const id = ++request;
    loading = true;
    error = "";
    list = undefined;
    let result: Awaited<ReturnType<typeof window.desktop.listModels>>;
    try {
      result = await window.desktop.listModels(sessionId);
    } catch {
      result = { list: null, error: "Could not load models. Check the connection, then Retry." };
    }
    // Ignore results for an earlier request or target.
    if (id !== request) return;
    loading = false;
    error =
      result.list &&
      (result.list.sessionId !== sessionId || result.list.projectPath !== projectPath)
        ? "The selected session changed. Refresh and try again."
        : result.error;
    if (error) return;
    list = result.list ?? undefined;
    const kept = matches.findIndex((model) => sameModel(model, keep));
    active =
      kept >= 0
        ? kept
        : Math.max(
            0,
            matches.findIndex((model) => sameModel(model, current)),
          );
  }

  function navigate(event: KeyboardEvent) {
    // The picker sits inside the composer form; Enter must not submit the draft.
    // Applying the active model belongs to #216.
    if (event.key === "Enter") event.preventDefault();
    const last = matches.length - 1;
    const next = {
      ArrowDown: active >= last ? 0 : active + 1,
      ArrowUp: active <= 0 ? last : active - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next !== undefined && matches.length) {
      event.preventDefault();
      active = next;
      document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
    }
  }
</script>

<div
  class="relative min-w-0"
  onfocusout={(event) => {
    // Close when focus leaves the picker; the new focus target keeps focus.
    if (
      open &&
      !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
    )
      close(false);
  }}
>
  <button
    type="button"
    class="max-w-full cursor-pointer truncate rounded-md border-0 bg-transparent px-1.5 py-1 font-sans text-xs text-muted hover:bg-raised hover:text-foreground"
    aria-label={`Model: ${label}`}
    aria-haspopup="dialog"
    aria-expanded={open}
    title="Choose model"
    onclick={toggle}>{label}</button
  >
  {#if open}
    <div
      class="absolute bottom-full left-0 z-10 mb-2 flex max-h-[min(60dvh,420px)] w-[min(360px,calc(100vw_-_32px))] flex-col rounded-xl border border-solid border-border bg-surface shadow-composer"
      role="dialog"
      aria-label="Choose model"
      tabindex="-1"
      onkeydown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
    >
      <input
        class="m-2 rounded-lg border-0 bg-raised px-3 py-2 font-sans text-sm text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
        type="search"
        role="combobox"
        aria-label="Search models"
        aria-expanded={matches.length > 0}
        aria-controls="model-options"
        aria-activedescendant={activeModel ? optionId(active) : undefined}
        aria-autocomplete="list"
        placeholder="Search provider, model, or ID"
        bind:this={search}
        bind:value={query}
        oninput={() => {
          active = 0;
        }}
        onkeydown={navigate}
      />
      <div class="min-h-0 overflow-y-auto px-2 pb-2 text-xs" aria-busy={loading}>
        <div aria-live="polite">
          {#if loading}
            <p class="px-2 text-muted">Loading models…</p>
          {:else if error}
            <p class="rounded-lg bg-error/5 p-3" role="alert">{error}</p>
          {:else if list && list.models.length === 0 && list.errors.length > 0}
            <p class="rounded-lg bg-error/5 p-3" role="alert">
              Pi could not check provider authentication. Check your credentials in Pi, then Retry.
            </p>
          {:else if list && list.models.length === 0}
            <p class="px-2 text-muted">
              No authenticated models. Use /login in Pi or configure a provider API key, then Retry.
            </p>
          {:else if list}
            {#each list.errors as failure (failure.provider)}
              <p class="rounded-lg bg-error/5 p-3" role="alert">{failure.message}</p>
            {/each}
            {#if matches.length === 0}
              <p class="px-2 text-muted">No models match “{query}”.</p>
            {/if}
          {/if}
        </div>
        <div id="model-options" role="listbox" aria-label="Models">
          {#each matches as model, index (`${model.provider}/${model.id}`)}
            <div
              id={optionId(index)}
              class="flex items-baseline gap-2 rounded-lg px-3 py-2 aria-selected:bg-raised"
              role="option"
              tabindex="-1"
              aria-selected={index === active}
              onpointermove={() => {
                active = index;
              }}
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-foreground">{model.name}</span>
                <span class="block truncate text-muted">{model.provider} · {model.id}</span>
              </span>
              {#if sameModel(model, current)}<span class="shrink-0 text-info">Current</span>{/if}
            </div>
          {/each}
        </div>
        {#if !loading && (error || list?.errors.length || list?.models.length === 0)}
          <button
            type="button"
            class="mt-2 rounded-lg border border-solid border-border bg-raised px-3 py-1.5 font-sans text-xs text-foreground cursor-pointer"
            onclick={() => {
              // Retry disappears after success; keep focus inside the picker.
              search?.focus();
              // Retry keeps the highlighted model when it is still available.
              void load(activeModel ?? current);
            }}>Retry</button
          >
        {/if}
      </div>
    </div>
  {/if}
</div>
