<script lang="ts">
  import { onMount } from "svelte";
  import type { Conversation } from "../../../api/index.js";
  let conversation = $state<typeof Conversation.Type | null>(null);
  let draft = $state("");
  let sending = $state(false);
  let connected = $state(true);
  let choosing = $state(false);
  let error = $state("");

  onMount(() =>
    window.desktop.watch((snapshot) => {
      connected = snapshot !== null;
      if (snapshot) conversation = snapshot;
    }),
  );

  async function send() {
    sending = true;
    error = "";
    try {
      await window.desktop.send(draft);
      draft = "";
    } catch {
      error = "Could not send the prompt. Check the connection and try again.";
    } finally {
      sending = false;
    }
  }

  async function chooseProject() {
    choosing = true;
    error = "";
    try {
      conversation = await window.desktop.chooseProject();
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
        <p aria-label={entry.role}>{entry.text}</p>
      {/each}
      {#if conversation.error}<p role="alert">{conversation.error}</p>{/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label for="prompt">Prompt</label>
        <textarea id="prompt" bind:value={draft}></textarea>
        <button disabled={sending || !connected || conversation.status !== "idle" || !draft.trim()}
          >Send</button
        >
      </form>
    </section>
  {:else}
    <button onclick={chooseProject} disabled={choosing}>Choose project</button>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>
