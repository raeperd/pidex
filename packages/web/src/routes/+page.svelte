<script module lang="ts">
  function followOutput(viewport: HTMLElement) {
    let following = true;
    const onScroll = () => {
      following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
    };
    const observer = new ResizeObserver(() => {
      if (following) viewport.scrollTop = viewport.scrollHeight;
    });
    const content = viewport.firstElementChild;
    if (content) observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener("scroll", onScroll);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { applyConversationUpdate, type Conversation } from "../../../api/index.js";
  import AssistantMessage from "./AssistantMessage.svelte";
  let conversation = $state.raw<typeof Conversation.Type | null>(null);
  let draft = $state("");
  let sending = $state(false);
  let pending: { id: string; text: string } | undefined;
  let connected = $state(true);
  let choosing = $state(false);
  let crashed = $state(false);
  let restarting = $state(false);
  let error = $state("");

  let canSend = $derived(
    !sending &&
      connected &&
      conversation?.status === "idle" &&
      !conversation.setupError &&
      !!draft.trim(),
  );

  onMount(() =>
    window.desktop.subscribe((update) => {
      if (update?._tag === "ConnectionError") {
        error = update.message;
        connected = false;
        return;
      }
      connected = update !== null;
      if (update?._tag === "Snapshot") {
        conversation = update.conversation;
        crashed = false;
      } else if (update && conversation)
        conversation = applyConversationUpdate(conversation, update);
      if (
        pending &&
        conversation?.entries.some(
          (entry) => entry.role === "user" && entry.submissionId === pending?.id,
        )
      ) {
        if (draft === pending.text) draft = "";
        pending = undefined;
        error = "";
      }
    }),
  );

  onMount(() =>
    window.desktop.onCrash(() => {
      crashed = true;
      connected = false;
    }),
  );

  async function restart() {
    restarting = true;
    error = "";
    try {
      const failure = await window.desktop.restart();
      if (failure) error = failure;
      else crashed = false;
    } catch {
      error = "Could not restart the backend. Try Restart again.";
    } finally {
      restarting = false;
    }
  }

  async function send() {
    if (!canSend) return;
    const submitted = draft;
    pending = { id: crypto.randomUUID(), text: submitted };
    const submission = pending;
    sending = true;
    error = "";
    try {
      const outcome = await window.desktop.send(submitted, submission.id);
      if (pending === submission) {
        if (outcome === "accepted") {
          if (draft === submitted) draft = "";
          pending = undefined;
        } else {
          error =
            "Acceptance is uncertain. The prompt may have been lost. Check the conversation before sending again.";
        }
      }
    } catch {
      pending = undefined;
      error = "Could not send the prompt. Check the connection and try again.";
    } finally {
      sending = false;
    }
  }

  async function stop() {
    const runId = conversation?.runId;
    if (!runId) return;
    error = "";
    try {
      await window.desktop.stop(runId);
    } catch {
      error = "Could not stop the run. Check the connection and try again.";
    }
  }

  async function chooseProject() {
    choosing = true;
    error = "";
    try {
      const selected = await window.desktop.chooseProject();
      // The subscription may already have delivered newer updates while IPC was pending.
      if (!conversation) conversation = selected;
      if (selected) crashed = false;
    } catch {
      error = "Could not open the project. Please try again.";
    } finally {
      choosing = false;
    }
  }
</script>

<svelte:head>
  <title>pidex</title>
</svelte:head>

<main class="flex h-dvh flex-col">
  <header class="shrink-0 border-0 border-b border-solid border-border px-6 py-3 max-[520px]:px-4">
    <h1 class="m-0 text-sm font-medium">pidex</h1>
    {#if conversation}
      <section class="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-2" aria-label="Current project">
        <strong class="font-medium wrap-anywhere">{conversation.projectPath.split("/").filter(Boolean).at(-1) || "/"}</strong>
        <span class="text-xs text-muted wrap-anywhere">{conversation.projectPath}</span>
      </section>
    {/if}
  </header>
  {#if conversation}
    <section class="flex min-h-0 flex-1 flex-col" aria-label="Conversation">
      <!-- Keyboard users must be able to scroll history. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="min-h-0 flex-1 overflow-auto py-8"
        role="region"
        aria-label="Messages"
        tabindex="0"
        {@attach followOutput}
      >
        <div class="mx-auto w-[min(768px,calc(100%_-_48px))] max-[520px]:w-[calc(100%_-_32px)]">
          {#if conversation.entries.length === 0}
            <div class="px-5 py-8 max-[520px]:px-0">
              <h2 class="mt-0 mb-3 text-2xl leading-[1.3] font-medium max-[520px]:text-xl">What would you like to build?</h2>
              <p class="max-w-[48ch] text-muted">Ask Pi to explore your project, make a change, or work through a problem.</p>
            </div>
          {/if}
          {#each conversation.entries as entry (entry.id)}
            {#if entry.role === "tool"}
              <details class="tool" data-state={entry.status}>
                <summary
                  ><span class="tool-name">{entry.name}</span> ·
                  <span class="tool-state"
                    >{entry.status === "running"
                      ? "Running"
                      : entry.status === "failed"
                        ? "Failed"
                        : "Completed"}</span
                  ></summary
                >
                <div class="tool-body">
                  <h3>Input</h3>
                  <pre aria-label="Input">{entry.input}</pre>
                  <h3>Result</h3>
                  <pre aria-label="Result">{entry.result}</pre>
                </div>
              </details>
            {:else if entry.role === "assistant"}
              <div class="assistant-turn">
                <div class="author">Pi</div>
                <AssistantMessage
                  text={entry.text}
                  streaming={conversation.status === "running" &&
                    entry === conversation.entries.at(-1)}
                />
              </div>
            {:else}
              <p class="user-message" aria-label="user">{entry.text}</p>
            {/if}
          {/each}
        </div>
      </div>
      <div class="mx-auto w-[min(768px,calc(100%_-_48px))] max-[520px]:w-[calc(100%_-_32px)] shrink-0 pt-4 pb-6">
        <div class="mb-3 flex flex-wrap gap-3 text-xs text-muted">
          <span>{conversation.modelName}</span>
          <span role="status">
            {!connected
              ? "Disconnected"
              : conversation.status === "idle"
                ? "Idle"
                : conversation.status === "stopping"
                  ? "Stopping"
                  : "Running"}
          </span>
        </div>
        {#if conversation.setupError}<p role="alert">{conversation.setupError.message}</p>{/if}
        {#if conversation.error}<p role="alert">{conversation.error}</p>{/if}
        {#if crashed}
          <p role="alert">The backend stopped. Restart to recover saved history.</p>
          <button class="rounded-lg border border-solid border-border bg-raised px-4 py-2 font-sans text-sm text-foreground cursor-pointer disabled:cursor-default disabled:text-muted" onclick={restart} disabled={restarting}>Restart</button>
        {/if}
        {#if conversation.status !== "idle"}
          <button class="rounded-lg border border-solid border-border bg-raised px-4 py-2 font-sans text-sm text-foreground cursor-pointer disabled:cursor-default disabled:text-muted" onclick={stop} disabled={!connected || conversation.status === "stopping"}
            >Stop</button
          >
        {/if}
        <form
          class="flex flex-wrap items-center gap-3"
          onsubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label for="prompt">Prompt</label>
          <textarea class="block min-h-16 w-full resize-none rounded-lg border border-solid border-border bg-surface p-3 font-sans text-base text-foreground caret-focus" id="prompt" bind:value={draft}></textarea>
          <button class="rounded-lg border border-solid border-border bg-raised px-4 py-2 font-sans text-sm text-foreground cursor-pointer disabled:cursor-default disabled:text-muted" disabled={!canSend}>Send</button>
        </form>
        {#if error}<p role="alert">{error}</p>{/if}
      </div>
    </section>
  {:else}
    <div class="mx-auto w-[min(768px,calc(100%_-_48px))] max-[520px]:w-[calc(100%_-_32px)] overflow-auto py-16">
      <h2 class="mt-0 mb-3 text-2xl leading-[1.3] font-medium max-[520px]:text-xl">Start with your project</h2>
      <p class="max-w-[48ch] text-muted">Choose a folder to start a conversation with Pi.</p>
      <button class="rounded-lg border border-solid border-border bg-raised px-4 py-2 font-sans text-sm text-foreground cursor-pointer disabled:cursor-default disabled:text-muted" onclick={chooseProject} disabled={choosing}>Choose project</button>
      {#if choosing}<p role="status">Opening project…</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  {/if}
</main>

<style>

  .transcript > .column {
    padding-inline: 20px;
  }

  .user-message {
    width: fit-content;
    max-width: 88%;
    margin: 0 0 32px auto;
    padding: 12px 16px;
    border-radius: 16px 16px 4px 16px;
    background: #212329;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .assistant-turn {
    margin-bottom: 24px;
  }

  .author {
    color: var(--color-info);
    font-size: 12px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .tool {
    color: var(--color-muted);
    font-size: 12px;
    margin-bottom: 8px;
  }

  .tool + .assistant-turn {
    margin-top: 24px;
  }

  summary {
    cursor: pointer;
    padding: 8px 12px;
    border-radius: 6px;
    overflow-wrap: anywhere;
  }

  summary:hover,
  .tool[open] summary {
    background: var(--color-raised);
  }

  .tool-name {
    color: var(--color-foreground);
    font-weight: 500;
  }

  .tool-state {
    color: var(--color-success);
  }

  .tool[data-state="running"] .tool-state {
    color: var(--color-focus);
  }

  .tool[data-state="failed"] .tool-state {
    color: var(--color-error);
  }

  .tool-body {
    margin: 4px 12px 12px;
    padding: 12px 16px;
    border-radius: 6px;
    background: var(--color-raised);
  }

  .tool-body h3 {
    font-size: 12px;
    font-weight: 500;
    margin: 0 0 8px;
  }

  .tool-body pre {
    margin: 0 0 16px;
    color: var(--color-foreground);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      12px/1.65 ui-monospace,
      "SFMono-Regular",
      Menlo,
      monospace;
  }

  .tool-body pre:last-child {
    margin-bottom: 0;
  }
@media (max-width: 520px) {
    .transcript > .column {
      padding-inline: 0;
    }
    .user-message {
      max-width: 100%;
    }
  }

  @media (pointer: coarse) {
    summary {
      min-height: 44px;
    }
  }
</style>
