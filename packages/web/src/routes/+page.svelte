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
      if (update?._tag === "Snapshot") conversation = update.conversation;
      else if (update && conversation) conversation = applyConversationUpdate(conversation, update);
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

  async function chooseProject() {
    choosing = true;
    error = "";
    try {
      const selected = await window.desktop.chooseProject();
      // The subscription may already have delivered newer updates while IPC was pending.
      if (!conversation) conversation = selected;
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
  <h1>pidex</h1>
  {#if conversation}
    <section aria-label="Conversation">
      <h2>New conversation</h2>
      <p>{conversation.modelName}</p>
      <p role="status">
        {!connected ? "Disconnected" : conversation.status === "idle" ? "Idle" : "Running"}
      </p>
      {#if conversation.entries.length === 0}<p>No messages yet.</p>{/if}
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
            streaming={conversation.status === "running" && entry === conversation.entries.at(-1)}
          />
        {:else}
          <p aria-label="user">{entry.text}</p>
        {/if}
      {/each}
      {#if conversation.setupError}<p role="alert">{conversation.setupError.message}</p>{/if}
      {#if conversation.error}<p role="alert">{conversation.error}</p>{/if}
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
    </section>
  {:else}
    <button onclick={chooseProject} disabled={choosing}>Choose project</button>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>
