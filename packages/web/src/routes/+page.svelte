<script lang="ts">
  import type { Conversation } from "../../../api/index.js";
  let conversation = $state<typeof Conversation.Type | null>(null);
  let choosing = $state(false);
  let error = $state("");

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
      <p role="status">{conversation.status === "idle" ? "Idle" : conversation.status}</p>
      {#if conversation.messageCount === 0}<p>No messages yet.</p>{/if}
    </section>
  {:else}
    <button onclick={chooseProject} disabled={choosing}>Choose project</button>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>
