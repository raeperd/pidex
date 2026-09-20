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

<main>
  <header>
    <h1>pidex</h1>
    {#if conversation}
      <section class="project" aria-label="Current project">
        <strong>{conversation.projectPath.split("/").filter(Boolean).at(-1) || "/"}</strong>
        <span>{conversation.projectPath}</span>
      </section>
    {/if}
  </header>
  {#if conversation}
    <section class="conversation" aria-label="Conversation">
      <div class="transcript">
        <div class="column">
          {#if conversation.entries.length === 0}
            <div class="empty">
              <h2>What would you like to build?</h2>
              <p>Ask Pi to explore your project, make a change, or work through a problem.</p>
            </div>
          {/if}
          {#each conversation.entries as entry (entry.id)}
            {#if entry.role === "tool"}
              <details>
                <summary
                  >{entry.name} · {entry.status === "running"
                    ? "Running"
                    : entry.status === "failed"
                      ? "Failed"
                      : "Completed"}</summary
                >
                <pre aria-label="Input">{entry.input}</pre>
                <pre aria-label="Result">{entry.result}</pre>
              </details>
            {:else if entry.role === "assistant"}
              <AssistantMessage
                text={entry.text}
                streaming={conversation.status === "running" &&
                  entry === conversation.entries.at(-1)}
              />
            {:else}
              <p aria-label="user">{entry.text}</p>
            {/if}
          {/each}
        </div>
      </div>
      <div class="controls column">
        <div class="metadata">
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
          <button onclick={restart} disabled={restarting}>Restart</button>
        {/if}
        {#if conversation.status !== "idle"}
          <button onclick={stop} disabled={!connected || conversation.status === "stopping"}
            >Stop</button
          >
        {/if}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label for="prompt">Prompt</label>
          <textarea id="prompt" bind:value={draft}></textarea>
          <button disabled={!canSend}>Send</button>
        </form>
        {#if error}<p role="alert">{error}</p>{/if}
      </div>
    </section>
  {:else}
    <div class="welcome column">
      <h2>Start with your project</h2>
      <p>Choose a folder to start a conversation with Pi.</p>
      <button onclick={chooseProject} disabled={choosing}>Choose project</button>
      {#if choosing}<p role="status">Opening project…</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  {/if}
</main>

<style>
  :global(:root) {
    color-scheme: dark;
    --canvas: #101113;
    --surface: #131416;
    --raised: #191b20;
    --text: #ececee;
    --muted: #999ba3;
    --border: #303237;
    --focus: #00d7ff;
    --blue: #3268ed;
    --teal: #8abeb7;
    --yellow: #f0c674;
    --green: #b5bd68;
    --error: #e18b8b;
    font:
      14px/1.6 -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    color: var(--text);
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    background: var(--canvas);
  }
  :global(::selection) {
    color: #f4f6ff;
    background: #344669;
  }
  :global(:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  main {
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  h1 {
    font-size: 14px;
    font-weight: 500;
    margin: 0;
  }
  .project {
    display: flex;
    align-items: baseline;
    gap: 8px 16px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .project strong {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .project span {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .column {
    width: min(768px, calc(100% - 48px));
    margin-inline: auto;
  }
  .conversation {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-block: 32px;
  }
  .controls {
    flex-shrink: 0;
    padding-block: 16px 24px;
  }
  .metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 12px;
  }
  .welcome {
    padding-block: 64px;
    overflow: auto;
  }
  .empty {
    padding: 32px 20px;
  }
  h2 {
    font-size: 24px;
    font-weight: 500;
    line-height: 1.3;
    margin: 0 0 12px;
  }
  .empty p,
  .welcome p {
    color: var(--muted);
    max-width: 48ch;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  textarea {
    display: block;
    width: 100%;
    resize: none;
    min-height: 64px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    color: var(--text);
    caret-color: var(--focus);
    font: inherit;
    font-size: 16px;
  }
  button {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--raised);
    color: var(--text);
    font: inherit;
    padding: 8px 16px;
    cursor: pointer;
  }
  button:disabled {
    color: var(--muted);
    cursor: default;
  }
  :global([role="alert"]) {
    color: var(--error);
    overflow-wrap: anywhere;
  }
  @media (max-width: 520px) {
    header {
      padding-inline: 16px;
    }
    .column {
      width: calc(100% - 32px);
    }
    .empty {
      padding-inline: 0;
    }
    h2 {
      font-size: 20px;
    }
  }
</style>
