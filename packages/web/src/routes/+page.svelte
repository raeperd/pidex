<script module lang="ts">
  function followOutput(viewport: HTMLElement) {
    let following = true;
    const onScroll = () => {
      following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
    };
    const onDisclosure = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("summary")) following = false;
    };
    const observer = new ResizeObserver(() => {
      if (following) viewport.scrollTop = viewport.scrollHeight;
    });
    const content = viewport.firstElementChild;
    if (content) observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener("scroll", onScroll);
    viewport.addEventListener("click", onDisclosure);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("click", onDisclosure);
    };
  }
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { applyConversationUpdate, type Conversation } from "../../../api/index.js";
  import AssistantMessage from "./AssistantMessage.svelte";
  import Sessions from "./Sessions.svelte";
  let conversation = $state.raw<typeof Conversation.Type | null>(null);
  let draft = $state("");
  let editor = $state<HTMLTextAreaElement>();
  const busy = $derived(conversation !== null && conversation.status !== "idle");
  let sending = $state(false);
  let pending: { id: string; text: string } | undefined;
  let connected = $state(true);
  let choosing = $state(false);
  let crashed = $state(false);
  let restarting = $state(false);
  let error = $state("");
  let showSessions = $state(false);

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
      // Keep a specific startup/history error delivered by the subscription.
      error ||= "Could not open the project. Please try again.";
    } finally {
      choosing = false;
    }
  }
</script>

<svelte:head>
  <title>pidex</title>
</svelte:head>

<main class="flex h-dvh flex-col overflow-hidden">
  <header class="flex h-14 shrink-0 items-center border-0 border-b border-solid border-border/60">
    <div class="flex w-64 shrink-0 items-center gap-2.5 px-5 max-[799px]:w-auto max-[799px]:px-4">
      <span
        class="flex size-6 items-center justify-center rounded-md bg-heading/15 font-mono text-xs font-semibold text-heading"
        aria-hidden="true">px</span
      >
      <h1 class="m-0 text-sm font-semibold tracking-tight">pidex</h1>
    </div>
    {#if conversation}
      <section
        class="flex min-w-0 flex-1 items-center gap-3 px-6 max-[799px]:px-3"
        aria-label="Current project"
      >
        <span class="truncate text-xs text-muted" title={conversation.projectPath}>
          {conversation.projectPath.split("/").filter(Boolean).at(-1) || "/"}
        </span>
        <span class="sr-only">{conversation.projectPath}</span>
        <span class="text-border" aria-hidden="true">/</span>
        <span class="shrink-0 text-xs max-[520px]:hidden">Current session</span>
      </section>
      <button
        class="mr-4 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-raised hover:text-foreground min-[800px]:hidden"
        aria-label={showSessions ? "Hide sessions" : "Show sessions"}
        aria-expanded={showSessions}
        aria-controls="session-sidebar"
        title={showSessions ? "Hide sessions" : "Show sessions"}
        onclick={() => {
          showSessions = !showSessions;
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />
        </svg>
      </button>
    {/if}
  </header>
  {#if conversation}
    <div class="flex min-h-0 flex-1">
      <aside
        id="session-sidebar"
        aria-label="Session sidebar"
        class={[
          "w-64 shrink-0 border-0 border-r border-solid border-border/60 bg-[#0d0e10] max-[799px]:w-full max-[799px]:border-r-0",
          !showSessions && "max-[799px]:hidden",
        ]}
      >
        {#key conversation.projectPath}
          <Sessions
            projectPath={conversation.projectPath}
            oncurrent={async () => {
              showSessions = false;
              await tick();
              editor?.focus();
            }}
          />
        {/key}
      </aside>
      <section
        class={["flex min-h-0 min-w-0 flex-1 flex-col", showSessions && "max-[799px]:hidden"]}
        aria-label="Conversation"
      >
        <!-- Keyboard users must be able to scroll history. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="min-h-0 flex-1 overflow-auto py-8"
          role="region"
          aria-label="Messages"
          tabindex="0"
          {@attach conversation.entries.length > 0 ? followOutput : undefined}
        >
          <div
            class="mx-auto w-[min(768px,calc(100%_-_48px))] max-[520px]:w-[calc(100%_-_32px)] px-5 max-[520px]:px-0"
          >
            {#if conversation.entries.length === 0}
              <div class="px-5 py-8 max-[520px]:px-0">
                <h2 class="mt-0 mb-3 text-2xl leading-[1.3] font-medium max-[520px]:text-xl">
                  What would you like to build?
                </h2>
                <p class="max-w-[48ch] text-muted">
                  Ask Pi to explore your project, make a change, or work through a problem.
                </p>
              </div>
            {/if}
            {#each conversation.entries as entry (entry.id)}
              {#if entry.role === "tool"}
                <details class="group mb-2 text-xs text-muted" data-state={entry.status}>
                  <summary
                    class="cursor-pointer rounded-md px-3 py-2 wrap-anywhere hover:bg-raised group-open:bg-raised pointer-coarse:min-h-11"
                    ><span class="font-medium text-foreground">{entry.name}</span> ·
                    <span
                      class="text-success group-data-[state=running]:text-focus group-data-[state=failed]:text-error"
                      >{entry.status === "running"
                        ? "Running"
                        : entry.status === "failed"
                          ? "Failed"
                          : "Completed"}</span
                    ></summary
                  >
                  <div class="mx-3 mt-1 mb-3 rounded-md bg-raised px-4 py-3">
                    <h3 class="mt-0 mb-2 text-xs font-medium">Input</h3>
                    <pre
                      class="mt-0 mb-4 font-mono text-xs leading-[1.65] whitespace-pre-wrap text-foreground wrap-anywhere last:mb-0"
                      aria-label="Input">{entry.input}</pre>
                    <h3 class="mt-0 mb-2 text-xs font-medium">Result</h3>
                    <pre
                      class="mt-0 mb-4 font-mono text-xs leading-[1.65] whitespace-pre-wrap text-foreground wrap-anywhere last:mb-0"
                      aria-label="Result">{entry.result}</pre>
                  </div>
                </details>
              {:else if entry.role === "assistant"}
                <div class="mb-6 [details+&]:mt-6">
                  <div class="mb-2 text-xs font-medium text-info">Pi</div>
                  <AssistantMessage
                    text={entry.text}
                    streaming={conversation.status === "running" &&
                      entry === conversation.entries.at(-1)}
                  />
                </div>
              {:else}
                <p
                  class="mt-0 mr-0 mb-8 ml-auto w-fit max-w-[88%] rounded-[16px_16px_4px_16px] bg-user px-4 py-3 whitespace-pre-wrap wrap-anywhere max-[520px]:max-w-full"
                  aria-label="user"
                >
                  {entry.text}
                </p>
              {/if}
            {/each}
          </div>
        </div>
        <div
          class="mx-auto w-[min(768px,calc(100%_-_48px))] max-[520px]:w-[calc(100%_-_32px)] shrink-0 pt-4 pb-6"
        >
          <div class="max-h-[20dvh] overflow-auto [&:not(:empty)]:mb-3">
            {#if conversation.setupError}<p role="alert">{conversation.setupError.message}</p>{/if}
            {#if conversation.error}<p role="alert">{conversation.error}</p>{/if}
            {#if crashed}
              <p role="alert">The backend stopped. Restart to recover saved history.</p>
              <button
                class="rounded-lg border border-solid border-border bg-raised px-4 py-2 font-sans text-sm text-foreground cursor-pointer disabled:cursor-default disabled:text-muted"
                onclick={restart}
                disabled={restarting}>Restart</button
              >
            {/if}
            {#if error}<p role="alert">{error}</p>{/if}
          </div>
          <form
            class="rounded-[24px] border border-solid border-border bg-surface p-5 pb-4 shadow-composer has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-solid has-[textarea:focus-visible]:outline-focus has-[textarea:focus-visible]:outline-offset-[3px] max-[520px]:p-4"
            aria-label="Message composer"
            onsubmit={(event) => {
              event.preventDefault();
              void send();
              editor?.focus();
            }}
          >
            <label class="sr-only" for="prompt">Prompt</label>
            <textarea
              class="block min-h-26 max-h-[min(30dvh,240px)] w-full field-sizing-content resize-none overflow-auto border-0 bg-transparent p-0 font-sans text-base text-foreground caret-focus placeholder:text-muted focus-visible:outline-none"
              id="prompt"
              bind:this={editor}
              bind:value={draft}
              placeholder="Ask Pi to work on your project…"></textarea>
            <div class="mt-4 flex items-center gap-3">
              <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
                <span class="wrap-anywhere">{conversation.modelName}</span>
                <span
                  class="group inline-flex items-center gap-1.5 border-0 border-l border-solid border-border pl-3 whitespace-nowrap"
                  role="status"
                  data-active={connected && busy}
                >
                  <span
                    class="size-[5px] rounded-[50%] bg-current group-data-[active=true]:text-focus"
                    aria-hidden="true"
                  ></span>
                  {!connected
                    ? "Disconnected"
                    : conversation.status === "idle"
                      ? "Idle"
                      : conversation.status === "stopping"
                        ? "Stopping"
                        : "Running"}
                </span>
              </div>
              <!-- t3code ComposerPrimaryActions.tsx at 4a560b4e4ebb37efb7f57805ba79e37f5500bdca.
                 SVGs licensed under MIT; notice distributed in /licenses/t3code.txt. -->
              <button
                class="ml-auto inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[50%] border-0 p-0 text-white shadow-action enabled:hover:brightness-[1.12] enabled:active:translate-y-px disabled:cursor-default disabled:opacity-40 [&[hidden]]:hidden max-[520px]:size-9 pointer-coarse:size-11 bg-action"
                type="submit"
                aria-label="Send"
                title="Send"
                hidden={busy}
                disabled={!canSend}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="ml-auto inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[50%] border-0 p-0 text-white shadow-action enabled:hover:brightness-[1.12] enabled:active:translate-y-px disabled:cursor-default disabled:opacity-40 [&[hidden]]:hidden max-[520px]:size-9 pointer-coarse:size-11 bg-stop"
                type="button"
                aria-label="Stop"
                title={conversation.status === "stopping" ? "Stopping…" : "Stop"}
                hidden={!busy}
                disabled={!connected || conversation.status === "stopping"}
                onclick={stop}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="2" y="2" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  {:else}
    <div
      class="mx-auto w-[min(768px,calc(100%_-_48px))] max-[520px]:w-[calc(100%_-_32px)] overflow-auto py-16"
    >
      <h2 class="mt-0 mb-3 text-2xl leading-[1.3] font-medium max-[520px]:text-xl">
        Start with your project
      </h2>
      <p class="max-w-[48ch] text-muted">Choose a folder to start a conversation with Pi.</p>
      <button
        class="rounded-lg border border-solid border-border bg-raised px-4 py-2 font-sans text-sm text-foreground cursor-pointer disabled:cursor-default disabled:text-muted"
        onclick={chooseProject}
        disabled={choosing}>Choose project</button
      >
      {#if choosing}<p role="status">Opening project…</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  {/if}
</main>
